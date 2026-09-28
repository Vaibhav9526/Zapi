/**
 * Bun preload for scripts/selfsettings-smoke.mts — the electron + nut-js
 * environment a real `CompanionManager` needs to be constructed and driven
 * through `processUserText` without touching the OS or the network.
 *
 * Superset of store-preload.ts's electron stub. The load-bearing extras:
 *  - `desktopCapturer.getSources → []`: a turn that survives the
 *    self-settings/parser gates lands in the normal talk path, which bails
 *    on an empty screenshot list BEFORE any model call — that bail is what
 *    lets the smoke assert "fell through" with zero network.
 *  - `clipboard`/`screen`/`shell`/`systemPreferences`: inert so any code
 *    path that drifts toward dictation, coordinate math, or OS open calls
 *    records nothing and touches nothing.
 *  - nut-js recorder: cheap insurance — a regression that reaches
 *    typeText/agent-driver can never type into the focused window.
 *
 * Bun-only (Bun.plugin). Run:
 *   bun --preload ./scripts/companion-stub-preload.ts ./scripts/selfsettings-smoke.mts
 */
import { plugin } from 'bun';

/** Every fake input call, in order: { api, arg }. */
export const nutCalls: Array<{ api: string; arg: unknown }> = [];
const record = (api: string, arg: unknown): void => {
  nutCalls.push({ api, arg });
};

/** Text the fake clipboard received — asserted on when a case lands in
 *  the dictation/clipboard branch by mistake. */
export const clipboardWrites: string[] = [];

try {
plugin({
  name: 'zapi-companion-stub',
  setup(build) {
    build.module('electron', () => ({
      exports: {
        app: {
          getPath: (name: string): string => {
            if (name !== 'userData') {
              throw new Error(`[companion-stub] unsupported getPath(${name})`);
            }
            const dir = process.env.ZAPI_SMOKE_USERDATA;
            if (!dir) {
              throw new Error('[companion-stub] $ZAPI_SMOKE_USERDATA is not set');
            }
            return dir;
          },
          getVersion: (): string => '0.0.0-smoke',
          setLoginItemSettings: (): void => {},
        },
        safeStorage: {
          isEncryptionAvailable: () => process.env.ZAPI_SMOKE_NO_ENC !== '1',
          encryptString: (s: string) =>
            Buffer.concat([Buffer.from([0x01]), Buffer.from(s, 'utf-8')]),
          decryptString: (b: Buffer) => {
            if (process.env.ZAPI_SMOKE_NO_ENC === '1') {
              throw new Error('[companion-stub] decryptString: encryption not available');
            }
            if (b.length > 0 && b[0] === 0x01) return b.subarray(1).toString('utf-8');
            throw new Error('[companion-stub] decryptString: not a stub ciphertext');
          },
        },
        clipboard: {
          writeText: (t: string): void => {
            clipboardWrites.push(t);
          },
          readText: (): string => clipboardWrites[clipboardWrites.length - 1] ?? '',
        },
        // Empty sources → captureAllDisplays yields [], which is the
        // talk turn's documented early-exit (the can't-see reply) and,
        // crucially, stops before streamMind / any provider.
        desktopCapturer: {
          getSources: async (): Promise<never[]> => [],
        },
        screen: {
          getAllDisplays: () => [
            { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
          ],
          getPrimaryDisplay: () => ({
            id: 7,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scaleFactor: 1,
          }),
          getDisplayNearestPoint: () => ({
            id: 7,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            scaleFactor: 1,
          }),
          getCursorScreenPoint: () => ({ x: 960, y: 540 }),
        },
        shell: {
          openPath: async () => '',
          showItemInFolder: (): void => {},
          openExternal: async (): Promise<void> => {},
        },
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
          getMediaAccessStatus: () => 'granted',
        },
      },
      loader: 'object',
    }));

    // Same recorder as agent-stub-preload: even a stray code path must not
    // move the developer's cursor or type into the focused window.
    build.module('@nut-tree-fork/nut-js', () => ({
      exports: {
        mouse: {
          move: async (t: unknown) => record('mouse.move', t),
          click: async (b: unknown) => record('mouse.click', b),
          doubleClick: async (b: unknown) => record('mouse.doubleClick', b),
          pressButton: async (b: unknown) => record('mouse.pressButton', b),
          releaseButton: async (b: unknown) => record('mouse.releaseButton', b),
          scrollUp: async (n: unknown) => record('mouse.scrollUp', n),
          scrollDown: async (n: unknown) => record('mouse.scrollDown', n),
          scrollLeft: async (n: unknown) => record('mouse.scrollLeft', n),
          scrollRight: async (n: unknown) => record('mouse.scrollRight', n),
          getPosition: async () => ({ x: 960, y: 540 }),
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
        Point: class NutPoint {
          constructor(public x: number, public y: number) {}
        },
        Key: {},
        straightTo: (p: unknown) => ({ to: p }),
        curveTo: (p: unknown) => ({ to: p }),
        straightToRel: (p: unknown) => ({ to: p }),
      },
      loader: 'object',
    }));
  },
});
} catch (err) {
  (globalThis as unknown as { __companionStubError?: string }).__companionStubError = String(err);
}
