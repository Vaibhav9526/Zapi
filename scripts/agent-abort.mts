/**
 * Abort + per-batch-cap behavior of runAgentActions, plus the pointer-only
 * onAction echo gate.
 *
 * Bun-ONLY — the driver imports `electron` and dynamically imports
 * `@nut-tree-fork/nut-js`, so it must run against the recording stubs in
 * agent-stub-preload.ts. Those stubs are the point: a real nut-js would
 * move the developer's cursor and type into their focused window.
 *
 *   bun --preload ./scripts/agent-stub-preload.ts ./scripts/agent-abort.mts
 * Under any other runner it prints SKIP and exits 0 — a skipped test must
 * never masquerade as PASS.
 *
 * Covers:
 *  A) abort mid-batch: resolves (no hang), stops early, reports the
 *     remaining actions as skipped, and the whole call returns far sooner
 *     than an unaborted batch;
 *  B) per-batch cap: 40 actions execute at most 30 and the drop is logged;
 *  C) onAction fires for pointer kinds only (move/click/dclick/rclick/drag)
 *     and never for type/key/scroll/wait;
 *  D) onLeaseWait contract: true while queued, then exactly one false when
 *     the wait ends — granted OR aborted — so the caller's status card
 *     can't be left reading 'waiting'.
 */
import type { AgentAction, ScreenCapture } from '../src/shared/types';
import { runAgentActions } from '../src/main/services/agent-driver';
import { acquireInputLease, leaseHolder } from '../src/main/services/input-lease';

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
  skip('agent driver abort/cap', 'requires bun --preload agent-stub-preload.ts');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

// The driver dedupes module state per process, so import it dynamically
// after the preload has installed its stubs. (A cast is type-only — read the
// property by its real name, don't destructure it off globalThis.)
const nutCalls = (
  globalThis as unknown as { __nutCalls: Array<{ api: string; arg: unknown }> }
).__nutCalls;

const MAX_ACTIONS_PER_BATCH = 30; // mirrors agent-driver.ts
const POINTER_KINDS = new Set<AgentAction['kind']>(['move', 'click', 'dclick', 'rclick', 'drag']);

/** One fake display: 2880px screenshot of a 1920x1080 screen at the origin. */
const shot: ScreenCapture = {
  dataBase64: '',
  displayId: 7,
  imageWidth: 2880,
  imageHeight: 1620,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isCursorScreen: true,
};

const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Entries in `executed` that are real actions, not driver notices. */
function realActions(executed: string[]): string[] {
  return executed.filter(
    (e) => !e.startsWith('batch capped') && !e.startsWith('stopped —'),
  );
}

// ── C) onAction fires for pointer kinds only ────────────────────────────
{
  const probe: AgentAction[] = [
    { kind: 'move', x: 100, y: 100, screenIndex: 0 },
    { kind: 'click', x: 120, y: 120, screenIndex: 0 },
    { kind: 'dclick', x: 140, y: 140, screenIndex: 0 },
    { kind: 'rclick', x: 160, y: 160, screenIndex: 0 },
    { kind: 'drag', x: 180, y: 180, x2: 260, y2: 300, screenIndex: 0 },
    // Empty text on purpose: the driver short-circuits before auto-typer,
    // so this can never type into a real window.
    { kind: 'type', text: '' },
    { kind: 'key', text: 'ctrl+s' },
    { kind: 'scroll', direction: 'down', amount: 2 },
    { kind: 'wait', amount: 0 },
  ];
  const echoes: Array<{ kind: AgentAction['kind']; x: number; y: number }> = [];
  const res = await runAgentActions(probe, [shot], {
    onAction: (a) => echoes.push({ kind: a.kind, x: a.x, y: a.y }),
  });
  const kinds = echoes.map((e) => e.kind).sort();
  check(
    res.executed.length >= probe.length,
    'probe: every action attempted',
    res.executed,
  );
  check(
    JSON.stringify(kinds) === JSON.stringify([...POINTER_KINDS].sort()),
    'echo: onAction fires for exactly the 5 pointer kinds',
    kinds,
  );
  check(
    !kinds.includes('type') && !kinds.includes('key') &&
      !kinds.includes('scroll') && !kinds.includes('wait'),
    'echo: no echo for type/key/scroll/wait',
    kinds,
  );
  // The pointer echo must carry the acted point, and a drag its endpoint.
  const dragEcho = echoes.find((e) => e.kind === 'drag');
  check(
    dragEcho !== undefined && dragEcho.x === 260 && dragEcho.y === 300,
    'echo: drag echo anchors on the drop point',
    dragEcho,
  );
  check(
    !res.failed,
    'probe: no action failed (stub satisfied every call)',
    res.executed.filter((e) => e.includes('failed')),
  );
  // Proof the fake nut-js served these calls. Without this the suite would
  // still pass if interception silently failed and the real native module
  // moved the developer's cursor instead.
  const apis = nutCalls.map((c) => c.api);
  // 6 moves for 5 pointer actions: a drag moves twice (grab, then drop).
  check(
    apis.filter((a) => a === 'mouse.move').length === 6,
    'stub: pointer actions were served by the recorder, not real nut-js',
    apis,
  );
  check(
    apis.includes('keyboard.pressKey') && apis.includes('mouse.click'),
    'stub: key + click went through the recorder',
    apis,
  );
  check(
    // 16 calls for the 5 pointer actions + key + scroll: 6 moves (a drag
    // moves twice), 2 clicks (left + right), 1 double-click, one
    // press/release pair for the drag, 2 key presses + 2 releases for
    // 'ctrl+s', 1 scroll. `wait` and the empty `type` are pure JS, so they
    // never reach the recorder — which is the point: no stray input fired.
    apis.filter((a) => a === 'mouse.move').length === 6 &&
      apis.filter((a) => a === 'mouse.click').length === 2 &&
      apis.filter((a) => a === 'mouse.doubleClick').length === 1 &&
      apis.filter((a) => a === 'mouse.pressButton').length === 1 &&
      apis.filter((a) => a === 'mouse.releaseButton').length === 1 &&
      apis.filter((a) => a === 'keyboard.pressKey').length === 2 &&
      apis.filter((a) => a === 'keyboard.releaseKey').length === 2 &&
      apis.filter((a) => a === 'mouse.scrollDown').length === 1 &&
      apis.length === 16,
    'stub: recorded call set matches the probe batch exactly',
    apis,
  );
}

// ── A) abort mid-batch ──────────────────────────────────────────────────
{
  const TOTAL = 40;
  const batch: AgentAction[] = Array.from({ length: TOTAL }, () => ({
    kind: 'wait' as const,
    amount: 50,
  }));
  const controller = new AbortController();
  const started = now();
  const run = runAgentActions(batch, [shot], { signal: controller.signal });
  // ~200ms in: with 50ms waits + the 140ms inter-action gap, a couple of
  // actions are done and the rest must never run.
  setTimeout(() => controller.abort(), 200);
  const res = await run;
  const elapsed = now() - started;
  const real = realActions(res.executed);
  const abortNote = res.executed.find((e) => e.startsWith('stopped —'));

  check(
    typeof elapsed === 'number' && elapsed < 3000,
    'abort: call resolved promptly instead of running the batch',
    { elapsedMs: Math.round(elapsed) },
  );
  check(real.length < TOTAL, 'abort: fewer actions executed than submitted', {
    executed: real.length,
    submitted: TOTAL,
  });
  check(abortNote !== undefined, 'abort: driver logged the abort', res.executed);
  const remaining = /remaining skipped\)/.exec(abortNote ?? '');
  const skippedCount = remaining ? Number(remaining[0].replace(/\D+/g, '')) : 0;
  check(
    remaining !== null && /\((\d+) remaining skipped\)/.test(abortNote ?? '') &&
      Number(/\((\d+) remaining skipped\)/.exec(abortNote ?? '')?.[1] ?? '0') > 0,
    'abort: reports the remaining actions as skipped',
    { abortNote, skippedCount },
  );
  check(
    res.failed === true && res.message === 'stopped',
    'abort: result marked failed/stopped',
    { failed: res.failed, message: res.message },
  );
}

// ── B) per-batch cap ────────────────────────────────────────────────────
{
  const TOTAL = 40;
  const batch: AgentAction[] = Array.from({ length: TOTAL }, () => ({
    kind: 'wait' as const,
    amount: 0,
  }));
  const res = await runAgentActions(batch, [shot]);
  const real = realActions(res.executed);
  check(
    real.length === MAX_ACTIONS_PER_BATCH,
    'cap: exactly the per-batch maximum executed',
    { executed: real.length, expected: MAX_ACTIONS_PER_BATCH },
  );
  check(
    real.length <= MAX_ACTIONS_PER_BATCH && real.length < TOTAL,
    'cap: executed count never exceeds the cap',
    { executed: real.length, submitted: TOTAL },
  );
  const capNote = res.executed.find((e) => e.startsWith('batch capped'));
  check(
    capNote !== undefined && capNote.includes(String(TOTAL - MAX_ACTIONS_PER_BATCH)),
    'cap: driver logs how many tags it dropped',
    capNote,
  );
  check(!res.failed && !res.done, 'cap: plain cap is not a failure', {
    failed: res.failed,
    done: res.done,
  });
}

// ── D) onLeaseWait fires one clear per wait, however the wait ends ─────
{
  // Grant: another agent holds the input lease, this batch queues, then
  // gets promoted. The clear must land exactly once, on the grant.
  const held = await acquireInputLease('holder-grant');
  const events: boolean[] = [];
  const pending = runAgentActions(
    [{ kind: 'click', x: 120, y: 120, screenIndex: 0 }],
    [shot],
    { agentId: 'queued-agent', onLeaseWait: (w) => events.push(w) },
  );
  await sleep(80);
  check(
    events.length >= 1 && events[0] === true,
    'lease: onLeaseWait(true) fires while the batch is queued',
    events,
  );
  held();
  const granted = await pending;
  check(
    events.filter((e) => e === false).length === 1 && events[events.length - 1] === false,
    'lease: exactly one onLeaseWait(false) on grant',
    events,
  );
  check(
    !granted.failed && granted.executed.some((e) => e.includes('click')),
    'lease: the granted batch actually ran its action',
    granted.executed,
  );
  check(leaseHolder() === null, 'lease: released after the granted batch');
}

// Abort while queued: the wait never resolves, so the lease itself sends
// no clear — the driver's catch has to, or the card says 'waiting' for a
// turn that is already gone.
{
  const held = await acquireInputLease('holder-abort');
  const ctl = new AbortController();
  const events: boolean[] = [];
  const nutBefore = nutCalls.length;
  const pending = runAgentActions(
    [{ kind: 'click', x: 200, y: 200, screenIndex: 0 }],
    [shot],
    {
      agentId: 'aborted-agent',
      signal: ctl.signal,
      onLeaseWait: (w) => events.push(w),
    },
  );
  await sleep(80);
  check(
    events[0] === true,
    'lease: abort-while-queued still announced the wait first',
    events,
  );
  ctl.abort();
  const res = await pending;
  held();
  check(
    events.filter((e) => e === false).length === 1,
    'lease: exactly one onLeaseWait(false) after an abort-while-queued',
    events,
  );
  check(
    res.failed && res.message === 'stopped',
    'lease: abort-while-queued reports stopped',
    { failed: res.failed, message: res.message },
  );
  check(
    nutCalls.length === nutBefore,
    'lease: nothing reached the desktop for the aborted batch',
    nutCalls.slice(nutBefore).map((c) => c.api),
  );
  check(leaseHolder() === null, 'lease: free after the aborted batch');
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
void sleep;
