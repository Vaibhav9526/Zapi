/**
 * Smoke test for routines.ts + settings-store routine CRUD.
 *
 * Bun-ONLY (store access needs the electron stub):
 *   bun --preload ./scripts/store-preload.ts ./scripts/routines-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0.
 *
 * Drives RoutineScheduler.tick() directly with an injected clock — no
 * timers, deterministic. Covers interval firing cadence, daily next-
 * HH:MM including tomorrow rollover, disabled routines, markRun
 * persistence through the real store, and reload() picking up edits.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`SKIP ${name} :: ${reason}`);
}

if (typeof Bun === 'undefined') {
  skip('routines', 'requires bun --preload electron stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-routines-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;

const store = await import('../src/main/services/settings-store');
const { RoutineScheduler } = await import('../src/main/services/routines');

// Fake wall clock — every getTime() below feeds the scheduler.
let now = Date.now();
const fired: string[] = [];

const scheduler = new RoutineScheduler({
  listRoutines: () => store.listRoutines(),
  onFire: (r) => fired.push(r.id),
  markRun: (id, ts) => store.markRoutineRun(id, ts),
  now: () => now,
});

/** Local-time 'HH:MM' for a Date — used to build anchored daily cases. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── store CRUD ─────────────────────────────────────────────────────────
{
  const r = store.upsertRoutine({
    agentId: 'main', name: 'download check', kind: 'interval',
    intervalMinutes: 5, task: 'check the downloads folder', enabled: true,
  });
  check(!!r.id && r.id.startsWith('routine-'), 'crud: create generates an id', r.id);
  store.markRoutineRun(r.id, 1_700_000_000_000);
  // An update that forgets lastRunAt must not wipe scheduler bookkeeping.
  const updated = store.upsertRoutine({ ...r, name: 'renamed', lastRunAt: undefined });
  check(
    updated.name === 'renamed' && updated.lastRunAt === 1_700_000_000_000,
    'crud: upsert preserves lastRunAt on edit',
    updated,
  );
  check(store.deleteRoutine(r.id) === true && store.listRoutines().length === 0, 'crud: delete removes');
  store.setRoutinesMuted(true);
  check(store.get('routinesMuted') === true, 'crud: routinesMuted roundtrips');
  store.setRoutinesMuted(false);
}

// ── interval cadence ───────────────────────────────────────────────────
{
  const r = store.upsertRoutine({
    agentId: 'main', name: 'five-min', kind: 'interval',
    intervalMinutes: 5, task: 'peek', enabled: true,
  });
  fired.length = 0;
  scheduler.tick(); // never ran → due on first tick
  check(fired.length === 1 && fired[0] === r.id, 'interval: never-run fires on first tick', fired);
  scheduler.tick(); // just fired → not due
  check(fired.length === 1, 'interval: not due again one tick later', fired);
  now += 4 * 60_000;
  scheduler.tick();
  check(fired.length === 1, 'interval: still not due before interval elapses', fired);
  now += 1 * 60_000 + 1_000; // now == lastRunAt + 5min + ε
  scheduler.tick();
  check(fired.length === 2, 'interval: fires at lastRunAt+intervalMinutes', fired);
  store.deleteRoutine(r.id);
}

// ── daily: next local HH:MM + tomorrow rollover ─────────────────────────
{
  const anchor = new Date();
  anchor.setHours(9, 30, 0, 0);
  now = anchor.getTime() - 60_000; // 09:29 today
  const r = store.upsertRoutine({
    agentId: 'main', name: 'morning brief', kind: 'daily',
    timeOfDay: '09:30', task: 'summarize', enabled: true,
  });
  fired.length = 0;
  scheduler.tick();
  check(fired.length === 0, 'daily: not due before timeOfDay', fired);
  now = anchor.getTime(); // 09:30 exactly
  scheduler.tick();
  check(fired.length === 1 && fired[0] === r.id, 'daily: fires at HH:MM', fired);
  now = anchor.getTime() + 30 * 60_000; // 10:00 same day
  scheduler.tick();
  check(fired.length === 1, 'daily: does not refire same day', fired);
  const tomorrow = anchor.getTime() + 24 * 60 * 60_000 + 1_000; // 09:30 +ε tomorrow
  now = tomorrow;
  scheduler.tick();
  check(fired.length === 2, 'daily: fires again next day (rollover)', fired);
  store.deleteRoutine(r.id);

  // Never-run daily created after its time already passed → tomorrow.
  const late = new Date();
  late.setHours(9, 0, 0, 0);
  now = late.getTime() + 60 * 60_000; // 10:00
  const r2 = store.upsertRoutine({
    agentId: 'main', name: 'eight-am', kind: 'daily',
    timeOfDay: '08:00', task: 'x', enabled: true,
  });
  fired.length = 0;
  scheduler.tick();
  check(fired.length === 0, 'daily: fresh routine does not retro-fire a missed time', fired);
  now += 22 * 60 * 60_000; // tomorrow 08:00
  scheduler.tick();
  check(fired.length === 1 && fired[0] === r2.id, 'daily: tomorrow rollover fires for fresh routine', fired);
  store.deleteRoutine(r2.id);
}

// ── disabled / malformed routines never fire ────────────────────────────
{
  const off = store.upsertRoutine({
    agentId: 'main', name: 'off', kind: 'interval',
    intervalMinutes: 1, task: 'x', enabled: false,
  });
  const bad = store.upsertRoutine({
    agentId: 'main', name: 'bad-daily', kind: 'daily',
    timeOfDay: '25:99', task: 'x', enabled: true,
  });
  fired.length = 0;
  scheduler.tick();
  check(fired.length === 0, 'disabled + malformed routines never fire', fired);
  store.deleteRoutine(off.id);
  store.deleteRoutine(bad.id);
}

// ── reload() picks up edits; empty list is a no-op ──────────────────────
{
  fired.length = 0;
  scheduler.start();
  scheduler.tick();
  check(fired.length === 0, 'scheduler: no routines → no-op tick', fired);
  // Simulate a settings change mid-run: upsert then reload.
  const r = store.upsertRoutine({
    agentId: 'main', name: 'late-add', kind: 'interval',
    intervalMinutes: 1, task: 'x', enabled: true,
  });
  scheduler.reload();
  check(fired.length === 1 && fired[0] === r.id, 'reload: new routine visible on next tick', fired);
  scheduler.stop();
  store.deleteRoutine(r.id);
}

// ── persistence: lastRunAt survives a settings reload from disk ────────
{
  const r = store.upsertRoutine({
    agentId: 'main', name: 'persist-me', kind: 'interval',
    intervalMinutes: 60, task: 'x', enabled: true,
  });
  store.markRoutineRun(r.id, 1_700_123_456_789);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, 'zapi-settings.json'), 'utf-8'),
  ) as { routines: Array<{ id: string; lastRunAt?: number }> };
  const row = onDisk.routines.find((x) => x.id === r.id);
  check(row?.lastRunAt === 1_700_123_456_789, 'markRun: lastRunAt persisted to disk', row);
  store.deleteRoutine(r.id);
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
