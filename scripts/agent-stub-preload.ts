/**
 * Bun preload for the agent-driver abort test (scripts/agent-abort.mts).
 *
 * agent-driver.ts reaches the real desktop two ways, and a test must reach
 * neither:
 *  - `import * as electron` for display bounds / scale factors;
 *  - a dynamic `import('@nut-tree-fork/nut-js')` for mouse + keyboard, which
 *    on this machine is a real native module — a live `move`/`click` would
 *    hijack the developer's actual cursor and a live `pressKey` would type
 *    into whatever window is focused.
 *
 * So this preload swaps both for recorders. Everything the driver calls is
 * recorded in memory and asserted on by the test; nothing touches the OS.
 *
 * Bun-only (Bun.plugin). Run:
 *   bun --preload ./scripts/agent-stub-preload.ts ./scripts/agent-abort.mts
 */
import { plugin } from 'bun';

/** Every fake input call, in order: { api, arg }. */
export const nutCalls: Array<{ api: string; arg: unknown }> = [];
const record = (api: string, arg: unknown): void => {
  nutCalls.push({ api, arg });
};

/** Stand-in for nut-js's Point — the driver only reads .x / .y. */
class NutPoint {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

const KEY_NAMES = [
  'LeftControl', 'LeftShift', 'LeftAlt', 'LeftWin', 'LeftCmd',
  'Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'CapsLock', 'NumLock', 'ScrollLock', 'Pause', 'Menu', 'Print',
  'Minus', 'Equal', 'Comma', 'Period', 'Slash', 'Backslash',
  'Semicolon', 'Quote', 'Grave', 'LeftBracket', 'RightBracket',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => `Num${i}`),
];

/** mapKey() reads Key.LeftControl / Key.A / Key.Num1 — mirror them as strings. */
function nutKeyStub(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEY_NAMES) out[name] = name;
  return out;
}

try {
plugin({
  name: 'zapi-agent-stub',
  setup(build) {
    // A single fake display: 1920x1080 at the origin, scale 1, so the
    // driver's bounds clamp has something real to work against.
    build.module('electron', () => ({
      exports: {
        app: {
          getPath: (name: string): string => {
            void name;
            return process.env.ZAPI_SMOKE_USERDATA ?? process.cwd();
          },
        },
        screen: {
          getAllDisplays: () => [
            { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
          ],
          getDisplayNearestPoint: () => ({
            id: 7,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scaleFactor: 1,
          }),
          getPrimaryDisplay: () => ({
            id: 7,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scaleFactor: 1,
          }),
          getCursorScreenPoint: () => ({ x: 960, y: 540 }),
        },
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      },
      loader: 'object',
    }));

    // Force the bare specifier to our fake, even though the real package is
    // installed in node_modules — otherwise a stray mouse.move would move
    // the developer's cursor for real. `build.module` is used rather than
    // onResolve because Bun keeps resolving an installed package from disk
    // (verified: onResolve left the real module in place).
    build.module('@nut-tree-fork/nut-js', () => ({
      exports: {
        mouse: {
          move: async (target: unknown) => record('mouse.move', target),
          click: async (button: unknown) => record('mouse.click', button),
          doubleClick: async (button: unknown) => record('mouse.doubleClick', button),
          pressButton: async (button: unknown) => record('mouse.pressButton', button),
          releaseButton: async (button: unknown) => record('mouse.releaseButton', button),
          scrollUp: async (n: unknown) => record('mouse.scrollUp', n),
          scrollDown: async (n: unknown) => record('mouse.scrollDown', n),
          scrollLeft: async (n: unknown) => record('mouse.scrollLeft', n),
          scrollRight: async (n: unknown) => record('mouse.scrollRight', n),
          getPosition: async () => new NutPoint(960, 540),
        },
        keyboard: {
          pressKey: async (k: unknown) => record('keyboard.pressKey', k),
          releaseKey: async (k: unknown) => record('keyboard.releaseKey', k),
          type: async (t: unknown) => record('keyboard.type', t),
        },
        screen: {
          width: async () => 1920,
          height: async () => 1080,
        },
        Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
        Point: NutPoint,
        Key: nutKeyStub(),
        straightTo: (p: unknown) => ({ to: p }),
        curveTo: (p: unknown) => ({ to: p }),
        straightToRel: (p: unknown) => ({ to: p }),
      },
      loader: 'object',
    }));
  },
});
} catch (err) {
  (globalThis as unknown as { __agentStubError?: string }).__agentStubError = String(err);
}

(globalThis as unknown as { __nutCalls: Array<{ api: string; arg: unknown }> }).__nutCalls =
  nutCalls;
