/**
 * Smoke test for the Fish Audio free-tier model header: the `model`
 * header on every TTS request, the free-tier default, and the same
 * header on the key-validation probe.
 *
 * Bun-ONLY (uses the Bun.plugin electron stub for app.getPath /
 * safeStorage, both of which the settings + key stores need):
 *   bun --preload ./scripts/store-preload.ts ./scripts/fish-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — a skipped
 * test must never masquerade as PASS.
 *
 * fetch is replaced with a recorder, so no network call and no audio is
 * produced; every assertion is about the request we WOULD have sent.
 *
 * Covers:
 *  a) free-tier default on a fresh profile + on-disk persistence
 *  b) the `model` header goes out on every synthesize() call
 *  c) picking a paid model changes the header; an unknown value coerces
 *     back to free and is repaired on disk
 *  d) the key-validation fishaudio probe carries the same header
 *  e) a hand-edited settings file with a junk model is repaired at load
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  skip('fish tts model header', 'requires bun --preload store-preload.ts');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

// Temp userData BEFORE any store import, so DEFAULTS are what we read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-fish-smoke-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;
const SETTINGS_FILE = path.join(tmp, 'zapi-settings.json');

const settingsStore = await import('../src/main/services/settings-store');
const keyStore = await import('../src/main/services/key-store');
const { FishAudioTTS } = await import('../src/main/services/fish-audio-tts');
const { validateApiKey } = await import('../src/main/services/key-validation');

// ── fetch recorder ─────────────────────────────────────────────────────
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
const calls: Recorded[] = [];
const realFetch = globalThis.fetch;
let nextStatus = 200;
let nextBody = '{"error":{"message":"insufficient API credit"}}';
/** Minimal audio/* response so the TTS client's content-type guard is happy. */
const audioResponse = (): Response =>
  new Response(new Uint8Array([0x49, 0x44, 0x33, 0x00]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  calls.push({
    url: String(url),
    method: init.method ?? 'GET',
    headers: (init.headers ?? {}) as Record<string, string>,
    body: typeof init.body === 'string' ? init.body : '',
  });
  if (nextStatus === 200) return audioResponse();
  return new Response(nextBody, {
    status: nextStatus,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
const lastCall = (): Recorded | undefined => calls[calls.length - 1];
const header = (name: string): string | undefined => {
  const h = lastCall()?.headers ?? {};
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? String(h[hit]) : undefined;
};

// ── a) free-tier default ───────────────────────────────────────────────
{
  check(
    settingsStore.get('fishTtsModel') === 's2.1-pro-free',
    'default: fishTtsModel is the free tier on a fresh profile',
    settingsStore.get('fishTtsModel'),
  );
  check(
    settingsStore.DEFAULT_FISH_TTS_MODEL === 's2.1-pro-free' &&
      settingsStore.getFishTtsModel() === 's2.1-pro-free',
    'default: exported default + reader agree',
  );
  check(
    JSON.stringify([...settingsStore.FISH_TTS_MODELS]) ===
      JSON.stringify(['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1']),
    'default: the picker list matches the contract enum',
    [...settingsStore.FISH_TTS_MODELS],
  );
  check(
    settingsStore.coerceFishTtsModel('s1') === 's1' &&
      settingsStore.coerceFishTtsModel('  S2-Pro  ') === 's2-pro' &&
      settingsStore.coerceFishTtsModel('') === 's2.1-pro-free' &&
      settingsStore.coerceFishTtsModel('whisper-1') === 's2.1-pro-free' &&
      settingsStore.coerceFishTtsModel(undefined) === 's2.1-pro-free' &&
      settingsStore.coerceFishTtsModel(7) === 's2.1-pro-free',
    'coerce: known values pass (trimmed/case-folded), junk → free',
  );
  // The account that prompted this: a free-tier key must not be sent the
  // paid model, which is what produced the 402.
  keyStore.setApiKey('fishaudio', 'free-tier-key');
  const tts = new FishAudioTTS();
  const audio = await tts.synthesize('hello', { voiceId: '' });
  check(audio.length === 4, 'tts: synthesize still returns the audio buffer', audio.length);
  check(
    lastCall()?.url === 'https://api.fish.audio/v1/tts' && lastCall()?.method === 'POST',
    'header: request still goes to the v1/tts endpoint',
    lastCall(),
  );
  check(header('model') === 's2.1-pro-free', 'header: model header is the free tier', header('model'));
  check(
    header('authorization') === 'Bearer free-tier-key' &&
      String(header('content-type')).toLowerCase() === 'application/json',
    'header: authorization + content-type unchanged',
  );
  check(
    !("model" in (JSON.parse(lastCall()?.body ?? '{}') as Record<string, unknown>)),
    'header: model is NOT duplicated into the body (spec says header only)',
    lastCall()?.body,
  );
  check(
    (JSON.parse(lastCall()?.body ?? '{}') as { text: string }).text === 'hello' &&
      (JSON.parse(lastCall()?.body ?? '{}') as { format: string }).format === 'mp3',
    'tts: body shape unchanged',
    lastCall()?.body,
  );
}

// ── b) the header goes out on EVERY call ──────────────────────────────
{
  const tts = new FishAudioTTS();
  const before = calls.length;
  await tts.synthesize('one', { voiceId: 'ref-1' });
  await tts.synthesize('two', { voiceId: 'ref-1', speed: 1.2 });
  const sent = calls.slice(before);
  check(
    sent.length === 2 && sent.every((c) => c.headers.model === 's2.1-pro-free'),
    'header: every synthesize() call carries the model header',
    sent.map((c) => c.headers.model),
  );
  check(
    header('model') === 's2.1-pro-free' && header('authorization') === 'Bearer free-tier-key',
    'header: last call still authenticated',
  );
}

// ── c) picking a paid model, and coercion on the way out ──────────────
{
  const tts = new FishAudioTTS();
  check(
    settingsStore.setFishTtsModel('s2.1-pro') === 's2.1-pro' &&
      settingsStore.getFishTtsModel() === 's2.1-pro',
    'set: a known paid model persists',
  );
  await tts.synthesize('paid', { voiceId: '' });
  check(header('model') === 's2.1-pro', 'header: a paid model override is honoured', header('model'));

  // A per-call override (voice picker's model preview) wins over the
  // setting for that request only.
  await tts.synthesize('preview', { voiceId: '', model: 's1' });
  check(header('model') === 's1', 'header: per-call model override wins', header('model'));
  check(
    settingsStore.getFishTtsModel() === 's2.1-pro',
    'set: a per-call override does not mutate the setting',
    settingsStore.getFishTtsModel(),
  );
  await tts.synthesize('back to setting', { voiceId: '', model: 'not-a-model' as never });
  check(
    header('model') === 's2.1-pro-free',
    'header: an unknown per-call model coerces to free, never goes on the wire verbatim',
    header('model'),
  );

  // Junk through the setter is repaired to free and persisted that way.
  check(
    settingsStore.setFishTtsModel('s2.1-pro-turbo') === 's2.1-pro-free' &&
      settingsStore.get('fishTtsModel') === 's2.1-pro-free',
    'set: an unknown model coerces to free',
    settingsStore.get('fishTtsModel'),
  );
  const onDisk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Record<string, unknown>;
  check(
    onDisk.fishTtsModel === 's2.1-pro-free',
    'set: the coerced value is what lands on disk',
    onDisk.fishTtsModel,
  );
}

// ── d) key-validation probe carries the same header ───────────────────
{
  calls.length = 0;
  settingsStore.setFishTtsModel('s2.1-pro-free');
  const ok = await validateApiKey('fishaudio', 'free-tier-key');
  check(ok.ok === true, 'probe: a 200 probe reports ok', ok);
  check(
    lastCall()?.url === 'https://api.fish.audio/v1/tts' && header('model') === 's2.1-pro-free',
    'probe: the fishaudio probe sends the model header (free tier)',
    { url: lastCall()?.url, model: header('model') },
  );
  check(
    header('authorization') === 'Bearer free-tier-key',
    'probe: authorization unchanged',
  );

  // And it follows the setting, so a user who picked a paid model and
  // has credit is probed against the same model they'll speak with.
  settingsStore.setFishTtsModel('s2.1-pro');
  calls.length = 0;
  await validateApiKey('fishaudio', 'paid-key');
  check(
    header('model') === 's2.1-pro',
    'probe: header follows the selected model',
    header('model'),
  );

  // The 402 the header prevents: a billing-tier rejection is reported as
  // "key accepted, request refused" rather than a bad key, because auth
  // already passed by the time the body is rejected. That leniency is
  // why the header matters — with it, a free key never gets here.
  nextStatus = 402;
  calls.length = 0;
  const broke = await validateApiKey('fishaudio', 'broke-key');
  check(
    broke.ok === true && /402/.test(broke.error ?? ''),
    'probe: a 402 reads as "key accepted, request refused" (not a bad key)',
    broke,
  );
  nextStatus = 401;
  const rejected = await validateApiKey('fishaudio', 'wrong-key');
  check(
    rejected.ok === false && /rejected/i.test(rejected.error ?? ''),
    'probe: a 401 is still a bad key',
    rejected,
  );
  nextStatus = 200;
}

// ── e) a junk model on disk is repaired at load ───────────────────────
{
  // Fresh process: the settings file is re-read by a new module instance,
  // so seed the file and re-import to prove the read-time coercion.
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ fishTtsModel: 'turbo-9000', fishVoiceId: 'ref-9' }),
  );
  const fresh = await import(`../src/main/services/settings-store?fresh=${Date.now()}`);
  check(
    fresh.get('fishTtsModel') === 's2.1-pro-free',
    'load: a junk model on disk is coerced to free at read',
    fresh.get('fishTtsModel'),
  );
  const repaired = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as Record<string, unknown>;
  check(
    repaired.fishTtsModel === 's2.1-pro-free' && repaired.fishVoiceId === 'ref-9',
    'load: the repair is written back without touching other settings',
    repaired,
  );
}

// ── f) the 400 'Reference not found' follow-up ──────────────────────
{
  const tts = new FishAudioTTS();
  nextStatus = 400;
  nextBody = '{"detail":"Reference not found"}';

  // No voice configured: the panel's Voice tab is the fix, so say so.
  settingsStore.set('fishVoiceId', '');
  let msg = '';
  try {
    await tts.synthesize('hi', { voiceId: '' });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  check(
    /paste a voice reference_id in the Voice tab/i.test(msg),
    '400: an unconfigured voice gets the Voice-tab hint',
    msg,
  );
  check(
    /Reference not found/i.test(msg),
    '400: the hint still quotes what the provider said',
    msg,
  );

  // A voice IS configured: then the id itself is wrong or revoked, which
  // the Voice tab hint would misdiagnose — stay generic.
  settingsStore.set('fishVoiceId', 'stale-reference-id');
  msg = '';
  try {
    await tts.synthesize('hi', { voiceId: '' });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  check(
    !/Voice tab/i.test(msg) && /error 400/i.test(msg),
    '400: with a voice set, the generic error is left alone',
    msg,
  );

  // A different 400 must not borrow the voice hint.
  nextBody = '{"error":{"message":"text is too long"}}';
  settingsStore.set('fishVoiceId', '');
  msg = '';
  try {
    await tts.synthesize('hi', { voiceId: '' });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  check(
    !/Voice tab/i.test(msg) && /too long/i.test(msg),
    '400: an unrelated 400 keeps its own message',
    msg,
  );
  nextStatus = 200;
  nextBody = '{"error":{"message":"insufficient API credit"}}';
}

globalThis.fetch = realFetch;

// Best-effort temp cleanup; never fails the run.
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
