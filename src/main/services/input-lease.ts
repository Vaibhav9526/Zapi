/**
 * Input lease — the global FIFO mutex around physical input.
 *
 * nut-js drives the ONE real cursor and keyboard: two agents emitting
 * input at once would interleave garbage (a drag split by a type burst,
 * clicks landing under the other agent's move). Agents reason in
 * parallel; only physical actions serialize here. The lease is held for
 * the duration of one action batch, not per action — interleaving mid-
 * batch is exactly what the lease exists to prevent.
 *
 * Pure module state, no Electron deps — it stays smoke-testable.
 */

import type { AgentPhase } from '../../shared/types';

/** Releasing is idempotent — a driver in a finally path can't double-fault. */
export type LeaseRelease = () => void;

export interface AcquireOptions {
  /**
   * Rejects with 'input lease wait timed out' after this long. A stuck
   * holder (driver bug, hung native call) must not deadlock every other
   * agent forever. Default 60s.
   */
  timeoutMs?: number;
  /** Cancels the wait — the caller's turn AbortSignal. */
  signal?: AbortSignal;
  /** Fires when the caller queues behind another holder (true) and when it wins the lease (false). */
  onQueued?: (waiting: boolean, position: number) => void;
}

/**
 * What a wait notification means for an agent's status card.
 *
 * This lives beside the queue rather than in the runtime for two
 * reasons: it is the module that produces the signal, and it stays
 * Electron-free so the ordering is smoke-testable. The rule it encodes is
 * the one that keeps a 'waiting' card honest:
 *
 *   - queued   → 'waiting'
 *   - granted  → 'acting', but only from 'waiting'. A grant that lands
 *                after the card already moved on must not resurrect a
 *                status the user has already seen past.
 *   - a turn that is no longer current → null, i.e. no emit at all: a
 *     stopped run is not queued, it is gone. (That is the abort-while-
 *     queued case, and the reason this takes `turnIsCurrent` instead of
 *     trusting the caller to check it first.)
 */
export function leaseWaitPhase(
  waiting: boolean,
  currentPhase: AgentPhase | null,
  turnIsCurrent: boolean,
): AgentPhase | null {
  if (!turnIsCurrent) return null;
  if (waiting) return 'waiting';
  return currentPhase === 'waiting' ? 'acting' : null;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface Waiter {
  agentId: string;
  resolve: (release: LeaseRelease) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  options?: AcquireOptions;
}

let holder: string | null = null;
const queue: Waiter[] = [];

/** Agent id currently holding the lease, or null when free. */
export function leaseHolder(): string | null {
  return holder;
}

/** Number of agents queued behind the holder. */
export function leaseQueueLength(): number {
  return queue.length;
}

function notifyWaiters(): void {
  queue.forEach((w, i) => {
    try {
      w.options?.onQueued?.(true, i + 1);
    } catch { /* a broken callback must not stall the lease */ }
  });
}

function detach(w: Waiter): void {
  if (w.timer) clearTimeout(w.timer);
  if (w.onAbort) w.options?.signal?.removeEventListener('abort', w.onAbort);
}

function makeRelease(agentId: string): LeaseRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (holder === agentId) holder = null;
    const next = queue.shift();
    if (next) {
      detach(next);
      holder = next.agentId;
      try {
        next.options?.onQueued?.(false, 0);
      } catch { /* ignore */ }
      next.resolve(makeRelease(next.agentId));
      notifyWaiters();
    }
  };
}

/**
 * Take the input lease for `agentId`. Resolves to a release function —
 * callers must invoke it in a finally. While queued the caller's
 * `onQueued` callback fires with its 1-based position each time the
 * queue shifts, and exactly once with `false` when the lease is granted.
 *
 * A wait that ENDS BADLY (timeout, or the caller's signal aborting) does
 * not call `onQueued(false)`: there is no lease to announce, and the
 * rejected promise is the terminal signal. The caller's catch is what
 * clears its 'waiting' state — see the driver's `onLeaseWait` contract.
 */
export function acquireInputLease(
  agentId: string,
  options?: AcquireOptions,
): Promise<LeaseRelease> {
  // Fast path: free lease, nobody waiting.
  if (holder === null && queue.length === 0) {
    holder = agentId;
    return Promise.resolve(makeRelease(agentId));
  }

  return new Promise<LeaseRelease>((resolve, reject) => {
    const w: Waiter = {
      agentId,
      resolve,
      reject,
      timer: null,
      onAbort: null,
      options,
    };

    w.timer = setTimeout(() => {
      const idx = queue.indexOf(w);
      if (idx >= 0) queue.splice(idx, 1);
      notifyWaiters();
      reject(new Error('input lease wait timed out'));
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(w.timer);
        reject(new Error('input lease wait aborted'));
        return;
      }
      w.onAbort = () => {
        const idx = queue.indexOf(w);
        if (idx >= 0) queue.splice(idx, 1);
        detach(w);
        notifyWaiters();
        reject(new Error('input lease wait aborted'));
      };
      options.signal.addEventListener('abort', w.onAbort, { once: true });
    }

    queue.push(w);
    notifyWaiters();
  });
}
