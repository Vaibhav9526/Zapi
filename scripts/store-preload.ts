/**
 * Bun preload stub for the `electron` module (used by store-smoke only).
 *
 * settings-store.ts and usage-store.ts do `import { app } from 'electron'`
 * and call `app.getPath('userData')`. Outside Electron that module does not
 * exist, so this preload registers a virtual `electron` module whose `app`
 * points userData at the temp dir in $ZAPI_SMOKE_USERDATA.
 *
 * Run: bun --preload ./scripts/store-preload.ts ./scripts/<script>.mts
 * (Bun-only: uses Bun.plugin; under node/tsx this file is never loaded.)
 */
import { plugin } from 'bun';

plugin({
  name: 'zapi-electron-stub',
  setup(build) {
    build.module('electron', () => ({
      exports: {
        app: {
          getPath: (name: string): string => {
            if (name !== 'userData') {
              throw new Error(`[electron-stub] unsupported getPath(${name})`);
            }
            const dir = process.env.ZAPI_SMOKE_USERDATA;
            if (!dir) {
              throw new Error('[electron-stub] $ZAPI_SMOKE_USERDATA is not set');
            }
            return dir;
          },
        },
        // Deterministic stand-in for safeStorage: ciphertext = 0x01 +
        // utf8 bytes; decrypt throws on anything not produced by this
        // stub so legacy/corrupt-blob code paths get exercised for real.
        // ZAPI_SMOKE_NO_ENC=1 simulates a host with no credential store.
        safeStorage: {
          isEncryptionAvailable: () => process.env.ZAPI_SMOKE_NO_ENC !== '1',
          encryptString: (s: string) =>
            Buffer.concat([Buffer.from([0x01]), Buffer.from(s, 'utf-8')]),
          decryptString: (b: Buffer) => {
            // Real Electron throws when the credential store is gone —
            // that's what turns a migrated 'enc:' blob into a clean null.
            if (process.env.ZAPI_SMOKE_NO_ENC === '1') {
              throw new Error('[electron-stub] decryptString: encryption not available');
            }
            if (b.length > 0 && b[0] === 0x01) return b.subarray(1).toString('utf-8');
            throw new Error('[electron-stub] decryptString: not a stub ciphertext');
          },
        },
      },
      loader: 'object',
    }));
  },
});
