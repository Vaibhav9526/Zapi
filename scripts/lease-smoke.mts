/**
 * Smoke test for input-lease.ts — the global FIFO mutex serializing
 * physical input across agents.
 *
 *   bun scripts/lease-smoke.mts        (plain bun — module has no Electron deps)
 *
 * Covers:
 *  a) FIFO: a acquires → b,c queue → release promotes in order
 *  b) onQueued callbacks see true+position while waiting, false on grant
 *  c) holder()/queueLength() introspection
 *  d) acquire timeout rejects a wait behind a stuck holder
 *  e) AbortSignal cancels a queued wait
 *  f) release is idempotent — double-release doesn't skip the queue
 *  g) leaseWaitPhase: the status-card ordering — queued → 'waiting',
 *     grant → back to 'acting', abort-while-queued → no emit
 */
import {
  acquireInputLease,
  leaseHolder,
  leaseQueueLength,
  leaseWaitPhase,
} from '../src/main/services/input-lease';
import type { AgentPhase } from '../src/shared/types';

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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── a/b/c) FIFO order, wait callbacks, introspection ────────────────────
{
  const releaseA = await acquireInputLease('agent-a');
  check(leaseHolder() === 'agent-a', 'fifo: a holds the lease', leaseHolder());

  const bEvents: Array<readonly [boolean, number]> = [];
  const cEvents: Array<readonly [boolean, number]> = [];
  let bGot: (() => void) | null = null;
  let cGot: (() => void) | null = null;
  const pB = acquireInputLease('agent-b', {
    onQueued: (w, pos) => bEvents.push([w, pos]),
  }).then((r) => { bGot = r; return 'b'; });
  const pC = acquireInputLease('agent-c', {
    onQueued: (w, pos) => cEvents.push([w, pos]),
  }).then((r) => { cGot = r; return 'c'; });
  await tick();

  check(leaseQueueLength() === 2, 'fifo: two queued behind a', leaseQueueLength());
  check(
    // b re-notifies when c joins behind it — every event still says pos 1.
    bEvents.length === 2 && bEvents.every((e) => e[0] === true && e[1] === 1),
    'wait cb: b queued at position 1 (re-announced on queue shift)',
    bEvents,
  );
  check(
    cEvents.length === 1 && cEvents[0][0] === true && cEvents[0][1] === 2,
    'wait cb: c queued at position 2',
    cEvents,
  );

  releaseA();
  const first = await Promise.race([pB, pC]);
  check(first === 'b' && leaseHolder() === 'agent-b', 'fifo: b promoted first', first);
  check(
    cEvents.length === 2 && cEvents[1][0] === true && cEvents[1][1] === 1,
    'wait cb: c re-queued at position 1 after promotion',
    cEvents,
  );

  bGot!();
  await pC;
  check(leaseHolder() === 'agent-c' && leaseQueueLength() === 0, 'fifo: c promoted last');
  check(
    cEvents.some((e) => e[0] === false),
    'wait cb: c saw waiting=false on grant',
    cEvents,
  );
  cGot!();
  check(leaseHolder() === null, 'fifo: lease free after all releases');
}

// ── d) acquire timeout rejects behind a stuck holder ────────────────────
{
  const stuck = await acquireInputLease('stuck');
  let err: unknown = null;
  try {
    await acquireInputLease('impatient', { timeoutMs: 50 });
  } catch (e) {
    err = e;
  }
  check(
    err instanceof Error && err.message.includes('timed out'),
    'timeout: queued wait rejects after timeoutMs',
    err,
  );
  check(leaseQueueLength() === 0, 'timeout: waiter removed from queue', leaseQueueLength());
  stuck();
  check(leaseHolder() === null, 'timeout: holder released cleanly afterwards');
}

// ── e) AbortSignal cancels a queued wait ────────────────────────────────
{
  const held = await acquireInputLease('holder');
  const ctl = new AbortController();
  let err: unknown = null;
  const p = acquireInputLease('canceller', { signal: ctl.signal }).catch((e) => (err = e));
  ctl.abort();
  await p;
  check(
    err instanceof Error && err.message.includes('aborted'),
    'abort: queued wait rejects on signal',
    err,
  );
  check(leaseQueueLength() === 0, 'abort: waiter removed from queue', leaseQueueLength());
  held();
}

// ── f) double-release is idempotent ─────────────────────────────────────
{
  const r1 = await acquireInputLease('x');
  let yGot = false;
  const pY = acquireInputLease('y').then((r) => { yGot = true; return r; });
  await tick();
  r1();
  r1(); // second call must be a no-op, not a skip-past-y
  await tick();
  check(yGot === true && leaseHolder() === 'y', 'idempotent: y got the lease despite double-release');
  const ry = await pY;
  ry();
  check(leaseHolder() === null, 'idempotent: lease free at end');
}

// ── g) status-card ordering: lease wait → AgentPhase ────────────────────
// The runtime feeds this function its current status and whether its turn
// is still current, then emits whatever comes back. Sequence here mirrors
// exactly that loop, so a regression in the mapping is a test failure.
{
  let phase: AgentPhase | null = 'acting';
  const seen: string[] = [];
  const feed = (waiting: boolean, turnIsCurrent: boolean): void => {
    const next = leaseWaitPhase(waiting, phase, turnIsCurrent);
    if (next === null) return;
    phase = next;
    seen.push(next);
  };

  // Queued mid-step, then granted: 'waiting' while parked, 'acting' the
  // moment the lease is ours. The missing 'acting' is the bug the audit
  // reported (card stuck on 'waiting' through the whole batch).
  feed(true, true);
  check(
    phase === 'waiting',
    'order: queued → the card says waiting',
    { phase, seen },
  );
  feed(false, true);
  check(
    JSON.stringify(seen) === JSON.stringify(['waiting', 'acting']),
    'order: queued → grant → waiting then acting',
    seen,
  );

  // Abort while queued: no emit at all, from any starting phase.
  check(
    leaseWaitPhase(true, 'thinking', false) === null,
    'order: a dead turn never enters waiting',
  );
  check(
    leaseWaitPhase(false, 'waiting', false) === null,
    'order: abort-while-queued → no acting emit',
  );

  // A grant with nothing outstanding must not resurrect a status.
  check(
    leaseWaitPhase(false, 'acting', true) === null &&
      leaseWaitPhase(false, 'thinking', true) === null &&
      leaseWaitPhase(false, 'done', true) === null &&
      leaseWaitPhase(false, null, true) === null,
    'order: grant only restores a card that is actually saying waiting',
  );
  check(
    leaseWaitPhase(true, null, true) === 'waiting',
    'order: a live turn always enters waiting when it queues',
  );
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
