/**
 * Smoke test for key-store.ts (safeStorage-backed API keys).
 *
 * Bun-ONLY (uses the Bun.plugin electron stub):
 *   bun --preload ./scripts/store-preload.ts ./scripts/keystore-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0.
 *
 * Covers:
 *  a) enc mode: set/get/delete/status roundtrip; on-disk blob carries
 *     the 'enc:' tag and never the plaintext;
 *  b) 'fishaudio' flows through KEY_NAMES → getKeyStatus like the rest;
 *  c) no-encryption host (ZAPI_SMOKE_NO_ENC=1): set writes a 'plain:'
 *     tagged blob and roundtrip still works — degraded, not broken;
 *  d) 'enc:' blob read with the credential store gone → null (honest
 *     failure — never a wrong key);
 *  e) legacy untagged base64 blob still decodes (back-compat);
 *  f) set('') deletes the entry.
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
  skip('keystore', 'requires bun --preload electron stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-keystore-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;
const KEY_FILE = path.join(tmp, 'zapi-keys.json');

const ks = await import('../src/main/services/key-store');

function readBlob(name: string): string | null {
  try {
    const file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8')) as {
      encryptedKeys?: Record<string, string>;
    };
    return file.encryptedKeys?.[name] ?? null;
  } catch {
    return null;
  }
}

// ── a) encrypted roundtrip ─────────────────────────────────────────────
{
  delete process.env.ZAPI_SMOKE_NO_ENC;
  check(ks.isEncryptionAvailable() === true, 'stub: encryption available in enc mode');

  ks.setApiKey('anthropic', 'sk-ant-secret');
  const blob = readBlob('anthropic');
  check(blob !== null && blob.startsWith('enc:'), 'enc write: blob tagged enc:', blob);
  check(blob !== null && !blob.includes('sk-ant-secret'), 'enc write: plaintext never on disk', blob);
  check(ks.getApiKey('anthropic') === 'sk-ant-secret', 'enc read: roundtrips', ks.getApiKey('anthropic'));
  check(ks.hasApiKey('anthropic') === true, 'hasApiKey: true after set');

  ks.setApiKey('anthropic', '');
  check(ks.getApiKey('anthropic') === null && readBlob('anthropic') === null, 'set("") deletes the entry');

  ks.setApiKey('openai', 'sk-oai-x');
  ks.deleteApiKey('openai');
  check(ks.getApiKey('openai') === null && !ks.hasApiKey('openai'), 'deleteApiKey removes entry');
}

// ── b) fishaudio flows through the status map ───────────────────────────
{
  ks.setApiKey('fishaudio', 'fish-key-123');
  const status = ks.getKeyStatus();
  check(
    typeof status === 'object' &&
      Object.keys(status).sort().join(',') === 'anthropic,elevenlabs,fishaudio,groq,openai' &&
      Object.values(status).every((v) => typeof v === 'boolean'),
    'status shape: all five providers, booleans only (keys never leak)',
    status,
  );
  check(status.fishaudio === true, 'status: fishaudio key reported', status);
  ks.deleteApiKey('fishaudio');
  check(ks.getKeyStatus().fishaudio === false, 'status: fishaudio clears after delete');
}

// ── c) degraded host: 'plain:' tag, no crash, roundtrip works ──────────
{
  process.env.ZAPI_SMOKE_NO_ENC = '1';
  check(ks.isEncryptionAvailable() === false, 'stub: encryption unavailable in no-enc mode');
  ks.setApiKey('groq', 'gsk_secret');
  const blob = readBlob('groq');
  check(blob !== null && blob.startsWith('plain:'), 'no-enc write: tagged plain: (not pretending encrypted)', blob);
  check(ks.getApiKey('groq') === 'gsk_secret', 'no-enc read: roundtrips');
  delete process.env.ZAPI_SMOKE_NO_ENC;
  // Reading the plain blob back WITH encryption available must also work.
  check(ks.getApiKey('groq') === 'gsk_secret', 'plain: blob still readable after host regains encryption');
}

// ── d) enc: blob on a host that lost its credential store → honest null ─
{
  ks.setApiKey('elevenlabs', 'xi-secret');
  const blob = readBlob('elevenlabs');
  check(blob !== null && blob.startsWith('enc:'), 'setup: enc blob written', blob);
  process.env.ZAPI_SMOKE_NO_ENC = '1';
  check(ks.getApiKey('elevenlabs') === null, 'enc blob undecryptable without credential store → null, not garbage');
  check(ks.hasApiKey('elevenlabs') === true, 'hasApiKey still true (blob exists; user re-enters)');
  delete process.env.ZAPI_SMOKE_NO_ENC;
}

// ── e) legacy untagged blob decodes ─────────────────────────────────────
{
  const file = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8')) as {
    encryptedKeys: Record<string, string>;
  };
  file.encryptedKeys['local_test'] = Buffer.from('legacy-plain-key', 'utf-8').toString('base64');
  fs.writeFileSync(KEY_FILE, JSON.stringify(file));
  check(ks.getApiKey('local_test') === 'legacy-plain-key', 'legacy untagged blob decodes');
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
