import type { Routine } from '../../shared/types';

/**
 * Routine scheduler — fires agent routines on a shared 15s tick.
 *
 * One timer for all routines: each tick re-reads the list (so upserts,
 * deletes, and enable flips take effect without a restart) and computes
 * next-due per routine rather than tracking per-routine timers:
 *
 *   interval — due when now ≥ lastRunAt + intervalMinutes; a routine
 *              that has never run is due immediately on the first tick
 *              ("check downloads every 30m" starts now, not in 30m).
 *   daily    — due at the next local HH:MM strictly after the last run;
 *              never-run routines anchor to now, so a daily created at
 *              15:00 for 09:00 waits for tomorrow instead of retro-firing.
 *
 * `routinesMuted` is deliberately NOT consulted here — muting silences
 * the done-announcement, not the run itself; the onFire consumer owns
 * that decision. Zero Electron deps — the smoke test drives `tick()`
 * with an injected clock.
 */

const TICK_MS = 15_000;
const MINUTE_MS = 60_000;

export interface RoutineSchedulerDeps {
  listRoutines: () => Routine[];
  /** Called for each routine that is due this tick. */
  onFire: (routine: Routine) => void;
  /** Persist bookkeeping after a fire (lastRunAt). */
  markRun: (id: string, ts: number) => void;
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
  /** Tick cadence override for tests. Defaults to 15s. */
  tickMs?: number;
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: RoutineSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Settings changed upstream — re-evaluate schedules immediately. */
  reload(): void {
    if (this.timer) this.tick();
  }

  /**
   * One evaluation pass — public so tests can drive it without timers.
   * A throwing onFire still gets markRun stamped (a broken routine
   * shouldn't refire every tick and burn the provider).
   */
  tick(): void {
    if (this.running) return; // a tick in flight (slow onFire) can't re-enter
    this.running = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      for (const routine of this.deps.listRoutines()) {
        if (!routine.enabled) continue;
        if (!this.isDue(routine, now)) continue;
        try {
          this.deps.onFire(routine);
        } catch (err) {
          console.error(`[Zapi] routine "${routine.name || routine.id}" fired with error:`, err);
        }
        this.deps.markRun(routine.id, now);
      }
    } finally {
      this.running = false;
    }
  }

  private isDue(routine: Routine, now: number): boolean {
    if (routine.kind === 'interval') {
      const intervalMs = (routine.intervalMinutes ?? 0) * MINUTE_MS;
      if (intervalMs <= 0) return false;
      if (routine.lastRunAt === undefined) return true; // never ran → first tick
      return now >= routine.lastRunAt + intervalMs;
    }

    // daily — next local HH:MM strictly after the anchor (last run, or
    // now for a fresh routine). setDate(+1) handles DST: a 'day' is not
    // always 24h, so we never add fixed milliseconds.
    const [hh, mm] = (routine.timeOfDay ?? '').split(':').map(Number);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return false;
    }
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    // Anchor 'never run' to a tick ago — the routine whose exact HH:MM is
    // *right now* must fire today, not roll to tomorrow.
    const anchor = routine.lastRunAt ?? now - 1;
    if (next.getTime() <= anchor) next.setDate(next.getDate() + 1);
    return now >= next.getTime();
  }
}
