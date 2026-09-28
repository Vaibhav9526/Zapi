/**
 * Smoke test for the TTS OS-voice fallback in companion-manager.ts:
 * when the configured provider can't speak — missing API key, thrown
 * error (e.g. Fish Audio's 402 'insufficient credit'), or a null
 * synthesis — the reply is handed to `callbacks.onSpeakText(text, rate)`,
 * which index.ts wires 1:1 to `sendToOverlays(IPC.SPEAK_TEXT, …)` so the
 * overlay's speechSynthesis reads it. The callback args ARE the IPC
 * payload, so asserting them here asserts the wire contract.
 *
 * Bun-ONLY (uses the companion electron+nut-js stub):
 *   bun --preload ./scripts/companion-stub-preload.ts ./scripts/speak-fallback-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — a skipped
 * test must never masquerade as PASS.
 *
 * Covers:
 *  a) missing key → SPEAK_TEXT emit, tag-stripped text + voiceSpeed rate
 *  b) provider throws / returns null → same emit (both providers)
 *  c) provider returns audio → NO emit
 *  d) speakReplies off → no emit; empty-after-strip text → no emit;
 *     the 'system voice' cue fires once per session, not per turn;
 *     speakLine drives the same emit end-to-end.
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
  skip('speak-fallback: all cases', 'requires bun --preload companion stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-speakfb-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;

const { CompanionManager } = await import('../src/main/companion-manager');
const settingsStore = await import('../src/main/services/settings-store');
const keyStore = await import('../src/main/services/key-store');
import type { FlickySettings } from '../src/shared/types';

// ── Recording callbacks ────────────────────────────────────────────────
// speakTexts mirrors what sendToOverlays(IPC.SPEAK_TEXT, text, rate)
// would forward — same args, same order.
const speakTexts: Array<{ text: string; rate: number }> = [];
const errors: string[] = [];

const mgr = new CompanionManager({
  onVoiceStateChanged: () => {},
  onTranscriptUpdate: () => {},
  onAiResponseChunk: () => {},
  onAiResponseComplete: () => {},
  onError: (m) => errors.push(m),
  onScene: () => {},
  onSceneCue: () => {},
  onAgentStatus: () => {},
  onAgentAction: () => {},
  onTypeFulfilled: () => {},
  onSettingsChanged: (_s: FlickySettings) => {},
  onMemoryStatsChanged: () => {},
  onChatEntryAdded: () => {},
  onStartAudioCapture: () => {},
  onStopAudioCapture: () => {},
  onPlayAudio: () => {},
  onStopAudio: () => {},
  onCursorVisibilityChanged: () => {},
  onStreamVisibilityChanged: () => {},
  onSpeakText: (text, rate) => speakTexts.push({ text, rate }),
});
mgr.stopRoutines();

type PrivateMgr = {
  synthesizeSpeech: (text: string) => Promise<Buffer | null>;
  speakLine: (text: string, isCurrent: () => boolean) => Promise<void>;
  fishTts: { synthesize: (t: string, o: unknown) => Promise<Buffer | null> };
  tts: { synthesize: (t: string, o: unknown) => Promise<Buffer | null> };
};
const priv = mgr as unknown as PrivateMgr;

const FALLBACK_CUE = 'speaking with system voice — voice provider unavailable';
const synth = (t: string) => priv.synthesizeSpeech(t);

// ── a) missing key → emit, cleaned text, rate arg ──────────────────────
{
  settingsStore.set('speakReplies', true);
  settingsStore.set('ttsProvider', 'fishaudio');
  settingsStore.set('voiceSpeed', 1.1);

  const ret = await synth('there you go. [MEMO:likes tea][FILE:notes.md]\nbody\n[/FILE]');
  check(ret === null, 'missing key: synthesizeSpeech returns null (no audio)');
  check(
    speakTexts.length === 1 &&
      speakTexts[0].text === 'there you go.' &&
      speakTexts[0].rate === 1.1,
    'missing key: SPEAK_TEXT payload is tag-stripped text + settings.voiceSpeed',
    speakTexts,
  );
  check(
    errors.some((e) => e === FALLBACK_CUE),
    'missing key: once-per-session system-voice cue surfaced',
    errors,
  );

  // Second miss → still emits voice but does not repeat the cue.
  const before = errors.length;
  speakTexts.length = 0;
  await synth('again.');
  check(
    speakTexts.length === 1 && speakTexts[0].rate === 1.1,
    'missing key: every failed turn still gets a voice',
    speakTexts,
  );
  check(
    errors.filter((e) => e === FALLBACK_CUE).length === 1 &&
      errors.length === before,
    'missing key: fallback cue fires once per session, not per turn',
    errors,
  );

  // Text that strips to nothing never reaches the overlay at all.
  speakTexts.length = 0;
  const emptyRet = await synth('[MEMO:only a memo]');
  check(
    emptyRet === null && speakTexts.length === 0,
    'missing key: tag-only text emits no SPEAK_TEXT',
    speakTexts,
  );
}

// ── b) provider failure → same emit ────────────────────────────────────
{
  // A key makes the provider reachable; the synth itself rejects.
  keyStore.setApiKey('fishaudio', 'smoke-fake-key');
  priv.fishTts = {
    synthesize: async () => {
      throw new Error('402 insufficient credit');
    },
  };

  speakTexts.length = 0;
  const ret = await synth('an error happened. [TYPE:should-not-type]');
  check(ret === null, 'provider throw: synthesizeSpeech returns null');
  check(
    speakTexts.length === 1 &&
      speakTexts[0].text === 'an error happened.' &&
      speakTexts[0].rate === 1.1,
    'provider throw: SPEAK_TEXT emitted with cleaned text + rate',
    speakTexts,
  );

  // Provider that resolves null (timeout/voice-not-found shapes) also
  // falls back through the same seam.
  priv.fishTts = { synthesize: async () => null };
  speakTexts.length = 0;
  await synth('null audio answer');
  check(
    speakTexts.length === 1 && speakTexts[0].text === 'null audio answer',
    'provider null: SPEAK_TEXT emitted on null audio',
    speakTexts,
  );

  // Same contract on the ElevenLabs branch — the fallback is not
  // provider-specific.
  settingsStore.set('ttsProvider', 'elevenlabs');
  keyStore.setApiKey('elevenlabs', 'smoke-fake-key');
  priv.tts = {
    synthesize: async () => {
      throw new Error('elevenlabs 500');
    },
  };
  speakTexts.length = 0;
  await synth('elevenlabs down');
  check(
    speakTexts.length === 1 && speakTexts[0].text === 'elevenlabs down',
    'provider throw (elevenlabs): SPEAK_TEXT emitted',
    speakTexts,
  );
  settingsStore.set('ttsProvider', 'fishaudio');
}

// ── c) provider success → NO emit ──────────────────────────────────────
{
  priv.fishTts = { synthesize: async () => Buffer.alloc(64) };
  speakTexts.length = 0;
  const ret = await synth('real audio reply');
  check(
    Buffer.isBuffer(ret) && ret.length === 64,
    'provider success: audio buffer returned',
    ret,
  );
  check(
    speakTexts.length === 0,
    'provider success: no SPEAK_TEXT emit — real TTS wins',
    speakTexts,
  );
}

// ── d) gates: speakReplies off / speakLine plumbing ────────────────────
{
  // speakReplies off: synth bails before the provider — no emit, no call.
  settingsStore.set('speakReplies', false);
  let synthCalled = false;
  priv.fishTts = {
    synthesize: async () => {
      synthCalled = true;
      return null;
    },
  };
  speakTexts.length = 0;
  const ret = await synth('muted reply');
  check(
    ret === null && !synthCalled && speakTexts.length === 0,
    'speakReplies off: no provider call, no SPEAK_TEXT',
    { ret, synthCalled },
  );

  // End-to-end through speakLine (the mode-toggle confirm path): the
  // canned line reaches the overlay voice with the current rate.
  settingsStore.set('speakReplies', true);
  settingsStore.set('ttsProvider', 'fishaudio');
  keyStore.setApiKey('fishaudio', 'smoke-fake-key');
  priv.fishTts = { synthesize: async () => null };
  speakTexts.length = 0;
  await priv.speakLine('slower. [MEMO:x]', () => true);
  check(
    speakTexts.length === 1 && speakTexts[0].text === 'slower.' && speakTexts[0].rate === 1.1,
    'speakLine: canned line falls back to SPEAK_TEXT, stripped + rated',
    speakTexts,
  );
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
