import * as electron from 'electron';
import { execFile } from 'node:child_process';
import { acquireInputLease } from './input-lease';
import { typeText } from './auto-typer';
import type { AgentAction, ScreenCapture } from '../../shared/types';

/**
 * Executes [ACT:...] actions via the nut-js native input module. The
 * module is loaded lazily (same pattern as auto-typer) so a missing or
 * broken native binding degrades agent mode to a clean failure instead
 * of crashing the main process at import time.
 */

type NutJs = typeof import('@nut-tree-fork/nut-js');
type NutKey = import('@nut-tree-fork/nut-js').Key;

let nutJs: NutJs | null = null;
let loadAttempted = false;

async function load(): Promise<NutJs | null> {
  if (loadAttempted) return nutJs;
  loadAttempted = true;
  try {
    nutJs = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.error('[Zapi] agent driver native module unavailable:', err);
    nutJs = null;
    // Don't latch the failure — a transient load error (antivirus lock
    // at startup, dll still extracting) must not disable agent mode for
    // the whole process lifetime. The next turn retries the import.
    loadAttempted = false;
  }
  return nutJs;
}

export interface AgentRunHooks {
  /** Fires after a pointer action succeeds so the overlay can echo a click ripple. */
  onAction?: (info: {
    x: number;
    y: number;
    label: string;
    kind: AgentAction['kind'];
  }) => void;
  /**
   * AbortSignal from the agent loop's turn controller — checked between
   * actions and inside waits, so AGENT_STOP actually stops a step
   * instead of letting the batch run to completion.
   */
  signal?: AbortSignal;
  /**
   * Identity for the input lease — the caller's agent id. Multi-agent
   * runs share the one real cursor/keyboard via this lease.
   */
  agentId?: string;
  /**
   * Fires true while this batch queues behind another agent's input
   * lease (overlay shows 'waiting'), then exactly once with false when
   * that wait ends — granted, aborted, or timed out. Caller maps true to
   * AGENT_STATUS phase:'waiting' and false back to 'acting' (see
   * `leaseWaitPhase`). The false is not optional: dropping it is what
   * left a card reading 'waiting' while the driver was already moving
   * the real cursor.
   */
  onLeaseWait?: (waiting: boolean) => void;
}

export interface AgentRunResult {
  done: boolean;
  failed: boolean;
  message: string;
  /** Human-readable log line per action attempted, in order. */
  executed: string[];
}

/** Breathing room between actions so the UI can react between events. */
const ACTION_GAP_MS = 140;
const MAX_WAIT_MS = 5000;
/**
 * One model reply can emit any number of [ACT:] tags — without a cap a
 * runaway response fires hundreds of real clicks in a single step.
 * agentMaxSteps bounds iterations; this bounds each batch.
 */
const MAX_ACTIONS_PER_BATCH = 30;

/** Resolves early when the signal fires — abort never waits out a sleep. */
function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/**
 * Display-space logical px → the physical px nut-js expects on Windows.
 * Electron reports display bounds in DIP while libnut positions the
 * cursor in raw pixels, so a 150%-scaled display needs the logical
 * coordinate multiplied by its scaleFactor. macOS works in points
 * already, so no scaling there.
 */
function scaleFactorFor(action: AgentAction, screenshots: ScreenCapture[]): number {
  if (process.platform !== 'win32') return 1;
  const capture = screenshots[action.screenIndex ?? 0];
  if (!capture) return 1;
  try {
    const display = electron.screen.getAllDisplays().find((d) => d.id === capture.displayId);
    return display?.scaleFactor || 1;
  } catch {
    // Logical×1 is correct for unscaled displays — the common case —
    // so a screen-API hiccup degrades gracefully instead of failing
    // every pointer action in the batch.
    return 1;
  }
}

/**
 * Scale factor of the display that actually contains a point — needed
 * for cross-display drags, whose destination may live on a monitor with
 * a different scaleFactor than the source's. Action coords are logical
 * DIP, which is exactly what getDisplayNearestPoint takes.
 */
function scaleFactorAtPoint(x: number, y: number): number {
  if (process.platform !== 'win32') return 1;
  try {
    return electron.screen.getDisplayNearestPoint({ x, y }).scaleFactor || 1;
  } catch {
    return 1;
  }
}

/**
 * Union of every display's logical bounds. Pointer targets get clamped
 * into this rect so a hallucinated coordinate (negative, or past the
 * last monitor) lands at the nearest edge instead of throwing inside
 * libnut or silently warping somewhere unexpected.
 */
function displayBoundsUnion(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  try {
    const displays = electron.screen.getAllDisplays();
    if (displays.length === 0) return null;
    return {
      minX: Math.min(...displays.map((d) => d.bounds.x)),
      minY: Math.min(...displays.map(d => d.bounds.y)),
      maxX: Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)),
      maxY: Math.max(...displays.map((d) => d.bounds.y + d.bounds.height)),
    };
  } catch {
    return null;
  }
}

/** Friendly key names → nut-js Key values. Unknown names → null. */
function mapKey(lib: NutJs, name: string): NutKey | null {
  const { Key } = lib;
  const k = name.trim().toLowerCase();
  // Under darwin the OS key is Command — LeftCmd — while LeftWin is the
  // Windows spelling. Keying it off platform keeps 'cmd+k' working on
  // both without two tables.
  const superKey = process.platform === 'darwin' ? Key.LeftCmd : Key.LeftWin;
  const named: Record<string, NutKey> = {
    ctrl: Key.LeftControl, control: Key.LeftControl,
    shift: Key.LeftShift,
    alt: Key.LeftAlt, option: Key.LeftAlt,
    win: superKey, meta: superKey, cmd: superKey,
    command: superKey, super: superKey,
    enter: Key.Enter, return: Key.Enter,
    esc: Key.Escape, escape: Key.Escape,
    space: Key.Space, ' ': Key.Space,
    tab: Key.Tab,
    backspace: Key.Backspace,
    delete: Key.Delete, del: Key.Delete,
    insert: Key.Insert, ins: Key.Insert,
    up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
    home: Key.Home, end: Key.End,
    pageup: Key.PageUp, pgup: Key.PageUp,
    pagedown: Key.PageDown, pgdn: Key.PageDown,
    capslock: Key.CapsLock, numlock: Key.NumLock,
    scrolllock: Key.ScrollLock, pause: Key.Pause, menu: Key.Menu,
    printscreen: Key.Print, prtsc: Key.Print, print: Key.Print,
    // Punctuation aliases — combos like 'ctrl+-' / 'ctrl+shift+/' parse
    // to a punctuation token that has to resolve.
    '-': Key.Minus, minus: Key.Minus,
    '=': Key.Equal, equal: Key.Equal, plus: Key.Equal,
    ',': Key.Comma, comma: Key.Comma,
    '.': Key.Period, period: Key.Period,
    '/': Key.Slash, slash: Key.Slash,
    '\\': Key.Backslash, backslash: Key.Backslash,
    ';': Key.Semicolon, semicolon: Key.Semicolon,
    "'": Key.Quote, quote: Key.Quote, apostrophe: Key.Quote,
    '`': Key.Grave, grave: Key.Grave, backquote: Key.Grave,
    '[': Key.LeftBracket, leftbracket: Key.LeftBracket,
    ']': Key.RightBracket, rightbracket: Key.RightBracket,
  };
  const hit = named[k];
  if (hit !== undefined) return hit;
  // F1..F24 and single letters/digits resolve by enum member name.
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(k) || /^[a-z]$/.test(k)) {
    return (Key as unknown as Record<string, NutKey>)[k.toUpperCase()] ?? null;
  }
  if (/^[0-9]$/.test(k)) {
    return (Key as unknown as Record<string, NutKey>)[`Num${k}`] ?? null;
  }
  return null;
}

const MODIFIER_KEYS = new Set<string>([
  'ctrl', 'control', 'shift', 'alt', 'option', 'win', 'meta', 'cmd', 'command', 'super',
]);

/** Only these kinds move or click the real cursor — the onAction ripple keys off this. */
const POINTER_KINDS = new Set<AgentAction['kind']>(['move', 'click', 'dclick', 'rclick', 'drag']);

/**
 * `open` is the one action that hands a model-authored string to a command
 * interpreter, so the target is validated here and nowhere else. The rule is
 * a whitelist by omission: accept a bare target — URL, app name, or absolute
 * path — and refuse anything carrying a shell metacharacter:
 *
 *   & | ; < > % ` ' " $ and any newline
 *
 * Refusing every quote is deliberate. It removes the need to reason about how
 * a path and its surrounding quotes compose, and it makes a path containing
 * an apostrophe (a real hazard under cmd's quote stripping) fail loudly
 * instead of executing something else. `%` covers %VAR% expansion, so the
 * environment can never be spliced in. Spaces are fine — execFile quotes the
 * argv element for us, which is why the helper below never builds a string.
 */
const SHELL_METACHARS = /[&|;<>%`'"$\r\n]/;

/** `start` returns immediately; the cap only guards a wedged cmd.exe. */
const OPEN_TIMEOUT_MS = 10_000;

function validateOpenTarget(raw: string): string {
  const target = raw.trim();
  if (!target) throw new Error('empty open target');
  if (SHELL_METACHARS.test(target)) {
    throw new Error('open target rejected: shell metacharacter');
  }
  return target;
}

/**
 * `cmd /d /s /c start "" "<target>"` — the Windows idiom for "open this with
 * whatever handles it": a URL goes to the default browser, an app name
 * resolves through PATH / App Paths, a file opens by association. The empty
 * first argument is `start`'s window-title slot, not the target; `/d` skips
 * AutoRun and `/s` is the quoting rule the idiom is written against.
 */
function launchTarget(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'cmd',
      ['/d', '/s', '/c', 'start', '', target],
      { windowsHide: true, timeout: OPEN_TIMEOUT_MS },
      (err) => {
        if (!err) {
          resolve();
          return;
        }
        const code = (err as { code?: number | string }).code;
        reject(new Error(`start exited ${code ?? 'with an error'}`));
      },
    );
  });
}

function describe(action: AgentAction): string {
  const at = action.x !== undefined ? ` ${Math.round(action.x)},${Math.round(action.y ?? 0)}` : '';
  switch (action.kind) {
    case 'click': return `click${at}`;
    case 'dclick': return `double-click${at}`;
    case 'rclick': return `right-click${at}`;
    case 'move': return `move${at}`;
    case 'drag': return `drag${at} → ${Math.round(action.x2 ?? 0)},${Math.round(action.y2 ?? 0)}`;
    case 'type': return `type "${(action.text ?? '').slice(0, 30)}${(action.text ?? '').length > 30 ? '…' : ''}"`;
    case 'key': return `key ${action.text ?? ''}`;
    case 'open': return `open ${(action.text ?? '').slice(0, 60)}${(action.text ?? '').length > 60 ? '…' : ''}`;
    case 'scroll': return `scroll ${action.direction ?? 'down'} ${action.amount ?? 3}`;
    case 'wait': return `wait ${action.amount ?? 0}ms`;
    case 'done': return `done${action.text ? `: ${action.text}` : ''}`;
    case 'fail': return `fail${action.text ? `: ${action.text}` : ''}`;
  }
}

/**
 * Run a batch of parsed actions in order. Individual action failures
 * are logged into `executed` and the batch continues — a stale click
 * target shouldn't abort the rest of the plan. Only [ACT:done] /
 * [ACT:fail] stop the loop early. Never throws.
 */
export async function runAgentActions(
  actions: AgentAction[],
  screenshots: ScreenCapture[],
  hooks?: AgentRunHooks,
): Promise<AgentRunResult> {
  const executed: string[] = [];
  const result: AgentRunResult = { done: false, failed: false, message: '', executed };
  const signal = hooks?.signal;
  const aborted = (): boolean => signal?.aborted === true;

  const lib = await load();
  if (!lib) {
    result.failed = true;
    result.message = 'automation unavailable';
    return result;
  }

  const { mouse, keyboard, Button, Point, straightTo } = lib;
  const bounds = displayBoundsUnion();
  // Defensive ceiling: a runaway model tag dump can't fire unbounded
  // real input events in one step.
  const batch = actions.slice(0, MAX_ACTIONS_PER_BATCH);
  // done/fail just set result fields — a batch of only those never
  // touches physical input, so it skips the lease entirely. `open` joins
  // them: it launches a process and never synthesizes an input event, so
  // holding the one real cursor/keyboard for it would needlessly block
  // other agents. A batch mixing `open` with pointer/key actions still
  // takes the lease for the whole batch (same rule as before).
  const LEASE_FREE_KINDS = new Set<AgentAction['kind']>(['done', 'fail', 'open']);
  const needsLease = batch.some((a) => !LEASE_FREE_KINDS.has(a.kind));

  // Physical input can't parallelize: nut-js owns the ONE real cursor
  // and keyboard, so batches serialize on the global input lease. Held
  // for the whole batch — interleaving mid-batch is the failure mode.
  let releaseLease: (() => void) | null = null;
  let announcedWait = false;
  try {
    if (needsLease) {
      releaseLease = await acquireInputLease(hooks?.agentId ?? 'main', {
        signal,
        onQueued: (waiting) => {
          announcedWait = waiting;
          try {
            hooks?.onLeaseWait?.(waiting);
          } catch { /* a broken hook must not stall the lease */ }
        },
      });
      if (announcedWait) {
        try {
          hooks?.onLeaseWait?.(false);
        } catch { /* ignore */ }
      }
      if (aborted()) {
        executed.push('stopped — user aborted (before first action)');
        result.failed = true;
        result.message = 'stopped';
        return result;
      }
    }

  for (let i = 0; i < batch.length; i++) {
    const action = batch[i];
    const label = describe(action);

    if (aborted()) {
      executed.push(`stopped — user aborted (${batch.length - i} remaining skipped)`);
      result.failed = true;
      result.message = 'stopped';
      break;
    }

    try {
      const sf = scaleFactorFor(action, screenshots);
      const point = (x?: number, y?: number): InstanceType<NutJs['Point']> => {
        // Clamp in logical space before the physical-pixel multiply.
        const lx = bounds ? clamp(x ?? 0, bounds.minX, bounds.maxX - 1) : (x ?? 0);
        const ly = bounds ? clamp(y ?? 0, bounds.minY, bounds.maxY - 1) : (y ?? 0);
        return new Point(Math.round(lx * sf), Math.round(ly * sf));
      };
      // Same clamp, caller-chosen scale factor — the drag destination
      // can live on a differently-scaled display than the source.
      const pointWithSf = (destSf: number) => (x?: number, y?: number): InstanceType<NutJs['Point']> => {
        const lx = bounds ? clamp(x ?? 0, bounds.minX, bounds.maxX - 1) : (x ?? 0);
        const ly = bounds ? clamp(y ?? 0, bounds.minY, bounds.maxY - 1) : (y ?? 0);
        return new Point(Math.round(lx * destSf), Math.round(ly * destSf));
      };
      const moveTo = async (x?: number, y?: number): Promise<void> => {
        if (x === undefined || y === undefined) throw new Error('missing coordinates');
        await mouse.move(straightTo(point(x, y)));
      };

      // Actions that log their own outcome (skipped, etc.) set this so
      // the generic `executed.push(label)` below doesn't double-report.
      let note: string | null = null;
      switch (action.kind) {
        case 'click':
          await moveTo(action.x, action.y);
          await mouse.click(Button.LEFT);
          break;
        case 'dclick':
          await moveTo(action.x, action.y);
          await mouse.doubleClick(Button.LEFT);
          break;
        case 'rclick':
          await moveTo(action.x, action.y);
          await mouse.click(Button.RIGHT);
          break;
        case 'move':
          await moveTo(action.x, action.y);
          break;
        case 'drag':
          await moveTo(action.x, action.y);
          await mouse.pressButton(Button.LEFT);
          try {
            // Scale the destination by the display it lands on — a drag
            // ending on a different-scaled monitor used to land short.
            const destSf = scaleFactorAtPoint(action.x2 ?? 0, action.y2 ?? 0);
            await mouse.move(straightTo(pointWithSf(destSf)(action.x2, action.y2)));
          } finally {
            // Always release — a stuck left button would drag-select
            // everything the user's cursor touches afterwards.
            await mouse.releaseButton(Button.LEFT);
          }
          break;
        case 'type':
          if (!action.text) {
            note = `${label} (skipped — empty text)`;
            break;
          }
          // Route through auto-typer's typeText so multi-line/unicode
          // payloads get the clipboard-paste path — a raw '\n' typed into
          // a chat box would submit the draft instead of wrapping it.
          if (!(await typeText(action.text))) {
            throw new Error('keystroke injection failed');
          }
          break;
        case 'key': {
          const parts = (action.text ?? '')
            .split('+')
            .map((p) => p.trim())
            .filter(Boolean);
          if (parts.length === 0) throw new Error('empty key combo');
          // nut-js expects modifier keys held before the trigger key,
          // so the combo order the model wrote is preserved only when
          // modifiers already lead — safest to re-order them first.
          const mods = parts.filter((p) => MODIFIER_KEYS.has(p.toLowerCase()));
          const rest = parts.filter((p) => !MODIFIER_KEYS.has(p.toLowerCase()));
          const keys = [...mods, ...rest].map((p) => {
            const key = mapKey(lib, p);
            if (key === null) throw new Error(`unknown key "${p}"`);
            return key;
          });
          // pressKey *holds* — track each press and release in reverse
          // inside finally so a mid-combo throw can't leave a modifier
          // logically down, hijacking every subsequent user keystroke.
          const pressed: NutKey[] = [];
          try {
            for (const k of keys) {
              await keyboard.pressKey(k);
              pressed.push(k);
            }
          } finally {
            for (const k of [...pressed].reverse()) {
              try {
                await keyboard.releaseKey(k);
              } catch { /* best-effort release — never mask the real error */ }
            }
          }
          break;
        }
        case 'open': {
          // Lease-free by construction (see LEASE_FREE_KINDS) and no
          // overlay ripple: nothing was clicked, so POINTER_KINDS is right
          // to exclude it. A rejected target is a normal per-action
          // failure — logged into `executed`, the batch keeps going.
          const raw = action.text ?? '';
          try {
            const target = validateOpenTarget(raw);
            await launchTarget(target);
            note = `${label} — launched`;
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            note = `${label} — skipped: ${why}`;
          }
          break;
        }
        case 'scroll': {
          const amount = clamp(Math.round(action.amount ?? 3), 0, 100);
          switch (action.direction) {
            case 'up': await mouse.scrollUp(amount); break;
            case 'left': await mouse.scrollLeft(amount); break;
            case 'right': await mouse.scrollRight(amount); break;
            default: await mouse.scrollDown(amount); break;
          }
          break;
        }
        case 'wait':
          await interruptibleDelay(clamp(action.amount ?? 0, 0, MAX_WAIT_MS), signal);
          break;
        case 'done':
          result.done = true;
          result.message = action.text ?? '';
          break;
        case 'fail':
          result.failed = true;
          result.message = action.text ?? '';
          break;
      }
      executed.push(note ?? label);
      // The overlay ripple only means "a pointer hit here" — emit it
      // after a successful pointer action; coord-less kinds (type, key,
      // scroll, wait) and failed actions get no phantom ripple at 0,0.
      if (POINTER_KINDS.has(action.kind)) {
        try {
          hooks?.onAction?.({
            x: action.kind === 'drag' ? (action.x2 ?? action.x ?? 0) : (action.x ?? 0),
            y: action.kind === 'drag' ? (action.y2 ?? action.y ?? 0) : (action.y ?? 0),
            label,
            kind: action.kind,
          });
        } catch { /* a broken hook must not eat the action */ }
      }
    } catch (err) {
      console.error(`[Zapi] agent action failed (${label}):`, err);
      executed.push(`${label} — failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (result.done || result.failed) break;
    if (i < batch.length - 1) await interruptibleDelay(ACTION_GAP_MS, signal);
  }

  if (actions.length > MAX_ACTIONS_PER_BATCH) {
    const dropped = actions.length - MAX_ACTIONS_PER_BATCH;
    console.warn(`[Zapi] agent batch capped at ${MAX_ACTIONS_PER_BATCH} actions (${actions.length} parsed)`);
    executed.push(`batch capped — ${dropped} action tag(s) dropped`);
  }
  } catch (err) {
    // Lease acquisition itself failed — nothing physical ran, so the
    // batch reports cleanly and releases whatever partial state exists.
    // The wait is over either way, so the caller's 'waiting' state is
    // cleared here: the lease does not notify onQueued(false) for a
    // failed wait (there is no grant to announce), and without this the
    // status card would keep saying 'queued' for a turn that is over.
    if (announcedWait) {
      announcedWait = false;
      try {
        hooks?.onLeaseWait?.(false);
      } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err);
    result.failed = true;
    result.message = aborted() || msg.includes('aborted') ? 'stopped' : `couldn't get input control — ${msg}`;
    executed.push(`lease wait failed: ${msg}`);
  } finally {
    // Held or not, this is safe to call — release is idempotent.
    releaseLease?.();
  }

  return result;
}
