/**
 * Smoke test for the [ACT:open:target] action in agent-driver.ts.
 *
 * `open` is the only action that hands a model-authored string to a
 * process launcher, so the checks pin both halves of the contract:
 *   - the target is validated (shell metachars rejected) before it ever
 *     reaches execFile, and the launch is the documented
 *     `cmd /d /s /c start "" <target>` argv — never a shell string;
 *   - open is lease-free: a pure-open batch completes while another
 *     agent holds the global input lease (proven with the real
 *     input-lease module, not a mock).
 *
 * Bun-ONLY (project has no node_modules; bun resolves the packages):
 *   bun --preload ./scripts/agent-stub-preload.ts ./scripts/open-action-smoke.mts
 * Any other runner prints SKIP lines and exits 0.
 *
 * The stub trick: child_process and nut-js are CJS modules, so their
 * exports objects are mutable via createRequire — patching them BEFORE
 * the driver module evaluates captures the recorders in its import
 * bindings (verified: plugin build.module cannot intercept node:* or an
 * installed package's dynamic import — an earlier attempt ran REAL
 * `cmd start` calls). Without this ordering the test would launch real
 * processes; keep the patch-first structure.
 */
import { createRequire } from 'node:module';
import type { AgentAction, ScreenCapture } from '../src/shared/types';

declare const Bun: unknown;

let pass = 0;
let fail = 0;
let skipped = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`,
    );
  }
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`SKIP ${name} :: ${reason}`);
}

if (typeof Bun === 'undefined') {
  skip('open-action: all cases', 'requires bun --preload agent-stub-preload.ts');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

// ── Patch BEFORE any import of agent-driver ─────────────────────────────
const rq = createRequire(import.meta.url);
const execCalls: Array<{ file: string; args: string[] }> = [];
let execFileFails = false;
rq('node:child_process').execFile = (
  file: string,
  args: string[],
  _opts: unknown,
  cb: (err: (Error & { code?: number }) | null) => void,
) => {
  execCalls.push({ file, args });
  cb(execFileFails ? Object.assign(new Error('boom'), { code: 1 }) : null);
};

const nutCalls: Array<{ api: string; arg: unknown }> = [];
const rec = (api: string) => async (a: unknown) => void nutCalls.push({ api, arg: a });
const nut = rq('@nut-tree-fork/nut-js');
// The package namespace itself is frozen — the mouse/keyboard objects
// it exports are not, so methods are patched in place (the driver reads
// `lib.mouse.move` fresh at every run).
for (const api of [
  'move', 'click', 'doubleClick', 'pressButton', 'releaseButton',
  'scrollUp', 'scrollDown', 'scrollLeft', 'scrollRight', 'getPosition',
]) {
  nut.mouse[api] = rec(`mouse.${api}`);
}
for (const api of ['pressKey', 'releaseKey', 'type']) {
  nut.keyboard[api] = rec(`keyboard.${api}`);
}

const { runAgentActions } = await import('../src/main/services/agent-driver');
const lease = await import('../src/main/services/input-lease');

const shot: ScreenCapture = {
  dataBase64: '',
  displayId: 7,
  imageWidth: 1920,
  imageHeight: 1080,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isCursorScreen: true,
};
const open = (text: string): AgentAction => ({ kind: 'open', text });
const run = (actions: AgentAction[], hooks?: Parameters<typeof runAgentActions>[2]) =>
  runAgentActions(actions, [shot], hooks);

// ── happy paths: url / app / spaced path all route ─────────────────────
{
  execCalls.length = 0;
  const r = await run([
    open('https://youtube.com/watch?v=abc'),
    open('notepad'),
    open('C:\\Program Files\\Zapi\\notes.md'),
  ]);
  check(
    execCalls.length === 3 && execCalls.every((c) => c.file === 'cmd'),
    'open: every target launches via cmd',
    execCalls,
  );
  const argv = execCalls.map((c) => c.args);
  check(
    argv.every(
      (a) => a.length === 6 && a.slice(0, 4).join('|') === '/d|/s|/c|start' && a[4] === '',
    ),
    'open: argv is the start-idiom — "cmd /d /s /c start" + title slot, never a shell string',
    argv,
  );
  check(
    execCalls.map((c) => c.args[c.args.length - 1]).join(';;') ===
      'https://youtube.com/watch?v=abc;;notepad;;C:\\Program Files\\Zapi\\notes.md',
    'open: url, app name, and spaced path all reach execFile verbatim',
    execCalls,
  );
  check(
    r.executed.filter((l) => l.includes('launched')).length === 3 &&
      !r.failed,
    'open: each launch reported as launched',
    r.executed,
  );
}

// ── metachar rejection happens before execFile ─────────────────────────
{
  execCalls.length = 0;
  const metas = ['&', '|', ';', '<', '>', '$', '`', "'", '"', '%', '\n'];
  const batch = metas.map((m) => open(`ok${m}evil`));
  const r = await run(batch);
  check(execCalls.length === 0, 'open: metachar targets never reach execFile', execCalls);
  check(
    r.executed.every((l) => l.includes('skipped') && l.includes('shell metacharacter')),
    'open: every metachar rejected with a reason (& | ; < > $ ` \' " % newline)',
    r.executed,
  );
  check(
    r.executed.length === batch.length && !r.failed && !r.done,
    'open: rejected targets fail soft — batch completes, no throw',
    r.executed.length,
  );

  const empty = await run([open(''), open('   ')]);
  check(
    empty.executed.every((l) => l.includes('empty open target')),
    'open: empty / whitespace target rejected',
    empty.executed,
  );
}

// ── exec failure is a soft per-action note, not a crash ────────────────
{
  execCalls.length = 0;
  execFileFails = true;
  const r = await run([open('someapp')]);
  execFileFails = false;
  check(
    execCalls.length === 1 &&
      r.executed.length === 1 &&
      r.executed[0].includes('skipped') &&
      r.executed[0].includes('start exited'),
    'open: a failed start lands as a skipped note, batch lives on',
    r.executed,
  );
}

// ── lease-free: open completes while another agent holds the input ─────
// The proof is behavioral: hold the real lease, run a pure-open batch —
// if open took the lease this would queue behind 'other-agent' until the
// 60s timeout; completing immediately (with no onLeaseWait) is the pass.
{
  const release = await lease.acquireInputLease('other-agent');
  try {
    execCalls.length = 0;
    let waited = false;
    const t0 = Date.now();
    const r = await run([open('notepad')], { onLeaseWait: () => (waited = true) });
    check(
      r.executed[0]?.includes('launched') && Date.now() - t0 < 5000 && !waited,
      'open: launches while another agent holds the input lease — no wait',
      { waited, executed: r.executed },
    );
    check(
      lease.leaseHolder() === 'other-agent',
      'open: never disturbed the holder',
      lease.leaseHolder(),
    );
    check(
      nutCalls.length === 0,
      'open: no nut-js input calls — it is not a pointer action',
      nutCalls,
    );

    // Contrast: the same held lease makes a click batch wait — proving
    // the open path above isn't just observing a dead lease.
    let clickWaited = false;
    const pending = run([{ kind: 'click', x: 960, y: 540, screenIndex: 0 }], {
      onLeaseWait: (w) => (clickWaited = w),
      agentId: 'waiter',
    });
    await new Promise((r2) => setTimeout(r2, 50));
    check(
      clickWaited === true && lease.leaseHolder() === 'other-agent',
      'contrast: a pointer batch DOES queue behind the held lease',
      clickWaited,
    );
    release();
    const clickRes = await pending;
    check(
      nutCalls.some((c) => c.api === 'mouse.move') &&
        clickRes.executed.some((l) => l.startsWith('click')),
      'contrast: released lease lets the click run',
      { nutCalls, executed: clickRes.executed },
    );
  } finally {
    release();
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
