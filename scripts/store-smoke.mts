/**
 * Smoke test for settings-store.ts and usage-store.ts.
 *
 * Bun-ONLY (uses Bun.plugin stub + process.execPath respawn):
 *   bun --preload ./scripts/store-preload.ts ./scripts/store-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — the `electron`
 * import in the stores cannot be satisfied without the bun preload stub,
 * and a skipped test must never masquerade as PASS.
 *
 * Covers:
 *  - settings roundtrip: partial seed file -> defaults merge on load,
 *    set() of every new field (ttsProvider, fishVoiceId, alwaysOnEnabled,
 *    dictationEnabled, dictationShortcut, agentEnabled, agentMaxSteps,
 *    customOpenAIModel), raw-disk assertion, and a fresh-process reload
 *    via store-read-helper.
 *  - usage month rollover: fake past-month file + recordTalkTurn() ->
 *    counters reset into the current-month bucket.
 *
 * Console-assert style: PASS/FAIL/SKIP lines, a summary, exit 1 on failure.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  skip('settings: roundtrip', 'requires bun --preload electron stub');
  skip('usage: month rollover', 'requires bun --preload electron stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./store-preload.ts', import.meta.url));
const helper = fileURLToPath(new URL('./store-read-helper.mts', import.meta.url));

// ── Temp userData dir + seed files (BEFORE first store import) ──────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-store-smoke-'));
process.env.ZAPI_SMOKE_USERDATA = dir;
const settingsPath = path.join(dir, 'zapi-settings.json');
const usagePath = path.join(dir, 'zapi-usage.json');

const now = new Date();
const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const pastMonth = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;

// Partial seed: only two keys, so the load path must merge the rest
// from DEFAULTS.
fs.writeFileSync(
  settingsPath,
  JSON.stringify({ speakReplies: false, agentMaxSteps: 42 }),
);
// Stale bucket with nonzero counters: the next record must roll over.
fs.writeFileSync(
  usagePath,
  JSON.stringify({
    month: pastMonth,
    talkTurns: 5,
    agentMessages: 7,
    dictationUtterances: 9,
  }),
);

// Cold-cache imports: first store access reads the seed files from disk.
const settingsStore = await import('../src/main/services/settings-store');
const usageStore = await import('../src/main/services/usage-store');

// ── Settings: defaults merge ────────────────────────────────────────────
{
  const all = settingsStore.getAll();
  check(
    all.speakReplies === false && all.agentMaxSteps === 42,
    'settings: seeded keys survive defaults merge',
    { speakReplies: all.speakReplies, agentMaxSteps: all.agentMaxSteps },
  );
  check(
    all.ttsProvider === 'fishaudio' &&
      all.fishVoiceId === '' &&
      all.alwaysOnEnabled === false &&
      all.dictationEnabled === false &&
      all.dictationShortcut === 'Ctrl+Alt+D' &&
      all.agentEnabled === true &&
      all.customOpenAIModel === '',
    'settings: new fields fall back to defaults when absent',
    {
      ttsProvider: all.ttsProvider,
      fishVoiceId: all.fishVoiceId,
      alwaysOnEnabled: all.alwaysOnEnabled,
      dictationEnabled: all.dictationEnabled,
      dictationShortcut: all.dictationShortcut,
      agentEnabled: all.agentEnabled,
      customOpenAIModel: all.customOpenAIModel,
    },
  );
}

// ── Settings: set() every new field, verify via get + raw disk ──────────
{
  settingsStore.set('ttsProvider', 'elevenlabs');
  settingsStore.set('fishVoiceId', 'fid-123');
  settingsStore.set('alwaysOnEnabled', true);
  settingsStore.set('dictationEnabled', true);
  settingsStore.set('dictationShortcut', 'Ctrl+Alt+T');
  settingsStore.set('agentEnabled', false);
  settingsStore.set('agentMaxSteps', 25);
  settingsStore.set('customOpenAIModel', 'gpt-9-custom');

  const all = settingsStore.getAll();
  check(
    all.ttsProvider === 'elevenlabs' &&
      all.fishVoiceId === 'fid-123' &&
      all.alwaysOnEnabled === true &&
      all.dictationEnabled === true &&
      all.dictationShortcut === 'Ctrl+Alt+T' &&
      all.agentEnabled === false &&
      all.agentMaxSteps === 25 &&
      all.customOpenAIModel === 'gpt-9-custom',
    'settings: new fields roundtrip through set/get',
  );

  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
    string,
    unknown
  >;
  check(
    raw.ttsProvider === 'elevenlabs' &&
      raw.fishVoiceId === 'fid-123' &&
      raw.alwaysOnEnabled === true &&
      raw.dictationEnabled === true &&
      raw.dictationShortcut === 'Ctrl+Alt+T' &&
      raw.agentEnabled === false &&
      raw.agentMaxSteps === 25 &&
      raw.customOpenAIModel === 'gpt-9-custom' &&
      raw.speakReplies === false,
    'settings: values persisted to zapi-settings.json on disk',
    raw,
  );

  check(
    settingsStore.get('dictationShortcut') === 'Ctrl+Alt+T',
    'settings: dictationShortcut readable via typed get',
    settingsStore.get('dictationShortcut'),
  );
}

// ── Settings: agent profiles (multi-agent) ──────────────────────────────
{
  // The seed file above has no `agents` key, so the loader must seed the
  // default profile — this is the pre-multi-agent install path.
  const agents = settingsStore.listAgents();
  const main = agents.find((a) => a.id === 'main');
  check(
    agents.length >= 1 && !!main && main.archived === false,
    'agents: legacy settings file seeds the default main profile',
    agents,
  );

  const created = settingsStore.createAgent('Scout', '(o_o)', '#00b8d9');
  check(
    !!created.id &&
      created.name === 'Scout' &&
      created.kaomoji === '(o_o)' &&
      created.archived === false,
    'agents: createAgent honours name/kaomoji and returns a usable id',
    created,
  );

  check(
    settingsStore.renameAgent(created.id, 'Pathfinder'),
    'agents: renameAgent updates an existing profile',
  );
  check(
    settingsStore.listAgents().find((a) => a.id === created.id)?.name === 'Pathfinder',
    'agents: renamed name reads back through listAgents',
  );
  check(
    settingsStore.renameAgent('nope', 'X') === false,
    'agents: renameAgent on an unknown id is a no-op false',
  );

  check(
    settingsStore.archiveAgent(created.id) &&
      settingsStore.listAgents().find((a) => a.id === created.id)?.archived === true,
    'agents: archiveAgent marks the profile archived (keeps history)',
  );
  check(
    settingsStore.archiveAgent('main') === false &&
      settingsStore.listAgents().find((a) => a.id === 'main')?.archived === false,
    'agents: archiveAgent refuses main and leaves it active',
  );
}

// ── Usage: month rollover ───────────────────────────────────────────────
{
  usageStore.recordTalkTurn();
  const s = usageStore.getStats();
  check(
    s.month === curMonth &&
      s.talkTurns === 1 &&
      s.agentMessages === 0 &&
      s.dictationUtterances === 0,
    'usage: past-month file rolls over and counters reset on record',
    s,
  );
  usageStore.recordAgentMessage();
  usageStore.recordDictationUtterance();
  const s2 = usageStore.getStats();
  check(
    s2.month === curMonth &&
      s2.talkTurns === 1 &&
      s2.agentMessages === 1 &&
      s2.dictationUtterances === 1,
    'usage: same-month records accumulate',
    s2,
  );
  check(
    s2.perAgent?.main?.talkTurns === 1 &&
      s2.perAgent?.main?.agentMessages === 1 &&
      s2.perAgent?.main?.dictationUtterances === 1,
    'usage: totals are mirrored into the per-agent row for main',
    s2.perAgent,
  );

  // A second agent gets its own row without disturbing main's totals.
  usageStore.recordTalkTurn('scout');
  const s3 = usageStore.getStats();
  check(
    s3.talkTurns === 2 &&
      s3.perAgent?.main?.talkTurns === 1 &&
      s3.perAgent?.scout?.talkTurns === 1,
    'usage: a named agentId increments its own row and the shared total',
    s3,
  );
}

// ── Fresh-process reload (cold module cache reads disk) ─────────────────
{
  const res = spawnSync(
    process.execPath,
    ['--preload', preload, helper],
    {
      cwd: root,
      env: { ...process.env, ZAPI_SMOKE_USERDATA: dir },
      encoding: 'utf-8',
    },
  );
  check(res.status === 0, 'reload: helper exits 0', {
    status: res.status,
    stderr: String(res.stderr ?? '').slice(-500),
  });
  let payload: {
    settings: Record<string, unknown>;
    usage: Record<string, unknown>;
  } | null = null;
  try {
    const lastLine = String(res.stdout ?? '').trim().split('\n').pop() ?? '';
    payload = JSON.parse(lastLine) as typeof payload;
  } catch (err) {
    payload = null;
    void err;
  }
  check(
    payload !== null &&
      payload.settings.ttsProvider === 'elevenlabs' &&
      payload.settings.fishVoiceId === 'fid-123' &&
      payload.settings.alwaysOnEnabled === true &&
      payload.settings.dictationEnabled === true &&
      payload.settings.dictationShortcut === 'Ctrl+Alt+T' &&
      payload.settings.agentEnabled === false &&
      payload.settings.agentMaxSteps === 25 &&
      payload.settings.customOpenAIModel === 'gpt-9-custom' &&
      payload.settings.speakReplies === false,
    'reload: fresh process sees persisted settings from disk',
    payload?.settings,
  );
  check(
    payload !== null &&
      payload.usage.month === curMonth &&
      // 2 talk turns: one on 'main', one on 'scout' (see the per-agent block).
      payload.usage.talkTurns === 2 &&
      payload.usage.agentMessages === 1 &&
      payload.usage.dictationUtterances === 1 &&
      payload.usage.perAgent?.main?.talkTurns === 1 &&
      payload.usage.perAgent?.scout?.talkTurns === 1,
    'reload: fresh process sees rolled-over usage + per-agent rows from disk',
    payload?.usage,
  );
}

// Best-effort temp cleanup; never fails the run.
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
