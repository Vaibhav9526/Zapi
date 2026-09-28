/**
 * Smoke test for the voice self-settings parser in companion-manager.ts
 * (private applyVoiceSelfSetting + the <8-word gate in processUserText).
 *
 * Bun-ONLY (uses the companion electron+nut-js stub):
 *   bun --preload ./scripts/companion-stub-preload.ts ./scripts/selfsettings-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — the `electron`
 * import in companion-manager cannot be satisfied without the bun preload
 * stub, and a skipped test must never masquerade as PASS.
 *
 * The parser is a private instance method that mutates real settings
 * through the same setters the panel uses, so the test drives a real
 * CompanionManager through its real entry point: `processUserText`
 * (reachable at runtime despite `private`). Stubbed deps make that safe:
 * desktopCapturer→[] means a non-trigger transcript exits via the
 * can't-see-your-screen bail BEFORE any model call, so "fell through" is
 * observable with zero network.
 *
 * Covers:
 *  a) fire cases — speed/mute/listen commands → right setter + value,
 *     plus the spoken confirmation line;
 *  b) normalization — wake-word lead, case, 'my'/'the' variants;
 *  c) clamps — voiceSpeed floor 0.7;
 *  d) adjacent mode toggles in the same early branches (dictation);
 *  e) the widened grammar — synonym cores ('don't talk', 'hush',
 *     'talk to me', 'turn off listening') and the fixed tail words
 *     ('please', 'yourself', 'to me', 'a bit', …) — anchored ^…$ so
 *     mid-sentence mentions can never fire;
 *  f) non-trigger cases — real questions, near-miss mentions, and
 *     >8-word transcripts MUST fall through to the normal turn
 *     (can't-see bail) untouched.
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
  skip('self-settings: all cases', 'requires bun --preload companion stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-selfsettings-'));
process.env.ZAPI_SMOKE_USERDATA = tmp;

const { CompanionManager } = await import('../src/main/companion-manager');
const settingsStore = await import('../src/main/services/settings-store');
import type { FlickySettings } from '../src/shared/types';

// ── Recording callbacks ────────────────────────────────────────────────
const completes: string[] = [];
const captureModes: string[] = [];
let captureStops = 0;
const errors: string[] = [];

const mgr = new CompanionManager({
  onVoiceStateChanged: () => {},
  onTranscriptUpdate: () => {},
  onAiResponseChunk: () => {},
  onAiResponseComplete: (t) => completes.push(t),
  onError: (m) => errors.push(m),
  onScene: () => {},
  onSceneCue: () => {},
  onAgentStatus: () => {},
  onAgentAction: () => {},
  onTypeFulfilled: () => {},
  onSettingsChanged: (_s: FlickySettings) => {},
  onMemoryStatsChanged: () => {},
  onChatEntryAdded: () => {},
  onStartAudioCapture: (m) => captureModes.push(m),
  onStopAudioCapture: () => captureStops++,
  onPlayAudio: () => {},
  onStopAudio: () => {},
  onCursorVisibilityChanged: () => {},
  onStreamVisibilityChanged: () => {},
});
mgr.stopRoutines(); // the constructor started the scheduler; no routines to fire anyway

type PrivateMgr = {
  processUserText: (
    text: string,
    opts?: { source?: 'voice' | 'routine' | 'suggestion' | 'typed'; agentId?: string },
  ) => Promise<void>;
};

async function turn(text: string): Promise<void> {
  await (mgr as unknown as PrivateMgr).processUserText(text, { source: 'voice' });
}

function lastComplete(): string | undefined {
  return completes[completes.length - 1];
}

/** Restore a deterministic baseline before each case. */
function resetSettings(): void {
  settingsStore.set('voiceSpeed', 1.0);
  settingsStore.set('speakReplies', true);
  settingsStore.set('routinesMuted', false);
  settingsStore.set('alwaysOnEnabled', false);
  settingsStore.set('dictationEnabled', false);
  settingsStore.set('agentEnabled', true);
  completes.length = 0;
  captureModes.length = 0;
  captureStops = 0;
}

// The win32 empty-screenshot bail — observable proof a transcript reached
// the normal talk path (and never a provider).
const CANT_SEE = "i can't see your screen right now — screen capture failed.";

// ── a) voice speed ─────────────────────────────────────────────────────
{
  resetSettings();
  await turn('talk slower');
  check(
    settingsStore.get('voiceSpeed') === 0.85 && lastComplete() === 'slower.',
    "fire: 'talk slower' → voiceSpeed 1.0 → 0.85, confirms 'slower.'",
    { speed: settingsStore.get('voiceSpeed'), line: lastComplete() },
  );

  await turn('speak faster');
  check(
    settingsStore.get('voiceSpeed') === 1.0 && lastComplete() === 'faster.',
    "fire: 'speak faster' → voiceSpeed back to 1.0, confirms 'faster.'",
    { speed: settingsStore.get('voiceSpeed'), line: lastComplete() },
  );

  settingsStore.set('voiceSpeed', 0.75);
  await turn('slow down');
  check(
    settingsStore.get('voiceSpeed') === 0.7 && lastComplete() === 'slower.',
    "clamp: 'slow down' at 0.75 clamps to the 0.7 floor, not 0.6",
    settingsStore.get('voiceSpeed'),
  );
}

// ── b) spoken replies ──────────────────────────────────────────────────
{
  resetSettings();
  await turn('stop talking');
  check(
    settingsStore.get('speakReplies') === false && lastComplete() === 'okay, quiet now.',
    "fire: 'stop talking' → speakReplies false",
    { v: settingsStore.get('speakReplies'), line: lastComplete() },
  );

  await turn('start talking');
  check(
    settingsStore.get('speakReplies') === true && lastComplete() === 'talking again.',
    "fire: 'start talking' → speakReplies true",
    { v: settingsStore.get('speakReplies'), line: lastComplete() },
  );

  await turn('be quiet');
  check(
    settingsStore.get('speakReplies') === false,
    "fire: 'be quiet' → speakReplies false",
  );
}

// ── c) routine announcements ───────────────────────────────────────────
{
  resetSettings();
  await turn('mute routines');
  check(
    settingsStore.get('routinesMuted') === true && lastComplete() === 'routines muted.',
    "fire: 'mute routines' → routinesMuted true",
    { v: settingsStore.get('routinesMuted'), line: lastComplete() },
  );

  await turn('unmute routines');
  check(
    settingsStore.get('routinesMuted') === false && lastComplete() === 'routines unmuted.',
    "fire: 'unmute routines' → routinesMuted false",
  );

  await turn('mute my routines');
  check(
    settingsStore.get('routinesMuted') === true,
    "fire: 'mute my routines' → 'my' variant also muted",
  );
}

// ── d) always-on listening ─────────────────────────────────────────────
{
  resetSettings();
  await turn('listen always');
  check(
    settingsStore.get('alwaysOnEnabled') === true &&
      captureModes.length === 1 && captureModes[0] === 'vad' &&
      lastComplete() === 'always listening.',
    "fire: 'listen always' → alwaysOn true + overlay mic gate opened in vad mode",
    { v: settingsStore.get('alwaysOnEnabled'), captureModes, line: lastComplete() },
  );

  await turn('stop listening');
  check(
    settingsStore.get('alwaysOnEnabled') === false &&
      captureStops === 1 &&
      lastComplete() === "i'll stop listening.",
    "fire: 'stop listening' → alwaysOn false + mic gate closed",
    { v: settingsStore.get('alwaysOnEnabled'), captureStops, line: lastComplete() },
  );
}

// ── e) normalization: wake word, case, 'the' ───────────────────────────
{
  resetSettings();
  await turn('hey zapi, talk slower');
  check(
    settingsStore.get('voiceSpeed') === 0.85 && lastComplete() === 'slower.',
    "fire: 'hey zapi, talk slower' → wake-word lead stripped",
    { speed: settingsStore.get('voiceSpeed'), line: lastComplete() },
  );

  await turn('Zapi, mute the routines');
  check(
    settingsStore.get('routinesMuted') === true,
    "fire: 'Zapi, mute the routines' → case + 'the' variant",
  );
}

// ── f) adjacent mode toggles in the same early branches ────────────────
{
  resetSettings();
  await turn('start dictating');
  check(
    settingsStore.get('dictationEnabled') === true && lastComplete() === 'dictation on.',
    "toggle: 'start dictating' → dictationEnabled true",
    { v: settingsStore.get('dictationEnabled'), line: lastComplete() },
  );
  await turn('stop dictating');
  check(
    settingsStore.get('dictationEnabled') === false && lastComplete() === 'dictation off.',
    "toggle: 'stop dictating' → dictationEnabled false",
    { v: settingsStore.get('dictationEnabled'), line: lastComplete() },
  );
}

// ── g) widened grammar: synonym cores + fixed tails ────────────────────
// Every core is anchored ^…$ with an optional tail of fixed short words
// (please/thanks/now/yourself/to me/a bit/…). These pin the widened
// contract the parser now accepts — 'stop announcing yourself' fired only
// after the tail list landed.
{
  resetSettings();
  await turn('stop announcing yourself');
  check(
    settingsStore.get('speakReplies') === false && lastComplete() === 'okay, quiet now.',
    "fire: 'stop announcing yourself' — 'yourself' tail hits speakReplies off",
    { v: settingsStore.get('speakReplies'), line: lastComplete() },
  );

  resetSettings();
  await turn("don't talk");
  check(
    settingsStore.get('speakReplies') === false,
    "fire: \"don't talk\" → negative-command core — speakReplies false",
    settingsStore.get('speakReplies'),
  );

  resetSettings();
  await turn("don't talk to me");
  check(
    settingsStore.get('speakReplies') === false,
    "fire: \"don't talk to me\" — off-branch wins over the 'to me' on-core",
    settingsStore.get('speakReplies'),
  );

  resetSettings();
  await turn('talk to me');
  check(
    settingsStore.get('speakReplies') === true && lastComplete() === 'talking again.',
    "fire: 'talk to me' → speakReplies true",
    { v: settingsStore.get('speakReplies'), line: lastComplete() },
  );

  resetSettings();
  await turn('hush');
  check(
    settingsStore.get('speakReplies') === false,
    "fire: 'hush' → speakReplies false",
    settingsStore.get('speakReplies'),
  );

  resetSettings();
  await turn('stay quiet now');
  check(
    settingsStore.get('speakReplies') === false,
    "fire: 'stay quiet now' → 'stay' core + 'now' tail",
    settingsStore.get('speakReplies'),
  );

  resetSettings();
  await turn('talk slower please');
  check(
    settingsStore.get('voiceSpeed') === 0.85 && lastComplete() === 'slower.',
    "fire: 'talk slower please' → tail 'please' — speed −0.15",
    settingsStore.get('voiceSpeed'),
  );

  resetSettings();
  await turn('talk a bit faster');
  check(
    settingsStore.get('voiceSpeed') === 1.15 && lastComplete() === 'faster.',
    "fire: 'talk a bit faster' → infix 'a bit' — speed +0.15",
    settingsStore.get('voiceSpeed'),
  );

  resetSettings();
  await turn('speaking more slowly now');
  check(
    settingsStore.get('voiceSpeed') === 0.85,
    "fire: 'speaking more slowly now' → gerund + 'more slowly' + tail",
    settingsStore.get('voiceSpeed'),
  );

  resetSettings();
  await turn('mute your routines');
  check(
    settingsStore.get('routinesMuted') === true && lastComplete() === 'routines muted.',
    "fire: 'mute your routines' → 'your' possessive variant",
    settingsStore.get('routinesMuted'),
  );

  resetSettings();
  settingsStore.set('routinesMuted', true);
  await turn('let the routines speak');
  check(
    settingsStore.get('routinesMuted') === false && lastComplete() === 'routines unmuted.',
    "fire: 'let the routines speak' → unmute branch",
    { v: settingsStore.get('routinesMuted'), line: lastComplete() },
  );

  resetSettings();
  await turn('stop listening please');
  check(
    settingsStore.get('alwaysOnEnabled') === false &&
      captureStops === 1 &&
      lastComplete() === "i'll stop listening.",
    "fire: 'stop listening please' → alwaysOn false + mic gate closed",
    { v: settingsStore.get('alwaysOnEnabled'), captureStops, line: lastComplete() },
  );

  resetSettings();
  await turn('never stop listening');
  check(
    settingsStore.get('alwaysOnEnabled') === true && captureModes[0] === 'vad',
    "fire: 'never stop listening' → alwaysOn true (negative phrasing, positive setting)",
    settingsStore.get('alwaysOnEnabled'),
  );

  resetSettings();
  await turn('turn off listening');
  check(
    settingsStore.get('alwaysOnEnabled') === false && captureStops === 1,
    "fire: 'turn off listening' → alwaysOn false",
    settingsStore.get('alwaysOnEnabled'),
  );
}

// ── h) non-trigger cases: real questions must fall through ─────────────
{
  resetSettings();
  await turn('what is the weather');
  check(
    settingsStore.get('voiceSpeed') === 1.0 &&
      settingsStore.get('speakReplies') === true &&
      lastComplete() === CANT_SEE,
    "no fire: 'what is the weather' falls through to the talk path",
    { line: lastComplete() },
  );

  resetSettings();
  await turn('tell me about routines');
  check(
    settingsStore.get('routinesMuted') === false && lastComplete() === CANT_SEE,
    "no fire: 'tell me about routines' is a question, not 'mute routines'",
    { v: settingsStore.get('routinesMuted'), line: lastComplete() },
  );

  resetSettings();
  await turn('why are routines muted in this app');
  check(
    settingsStore.get('routinesMuted') === false && lastComplete() === CANT_SEE,
    "no fire: 'why are routines muted…' doesn't match the anchored command",
    { line: lastComplete() },
  );

  // Mid-sentence mentions: every core is ^…$ anchored, so a command
  // phrase embedded in real prose can never fire even under 8 words —
  // and a word that isn't on the tail list ('about', 'like that') still
  // fails the anchor.
  const nearMisses: Array<[string, 'voiceSpeed' | 'speakReplies' | 'routinesMuted' | 'alwaysOnEnabled']> = [
    ['i hope you stop talking soon', 'speakReplies'],
    ['can you talk slower', 'voiceSpeed'],
    ['she told me to be quiet', 'speakReplies'],
    ['please stop talking to the dog', 'speakReplies'],
    ['be quiet about it', 'speakReplies'],
    ["don't you talk to me like that", 'speakReplies'],
    ['did you stop listening earlier', 'alwaysOnEnabled'],
  ];
  for (const [text, field] of nearMisses) {
    resetSettings();
    const baseline = settingsStore.get(field);
    await turn(text);
    check(
      settingsStore.get(field) === baseline && lastComplete() === CANT_SEE,
      `no fire: '${text}' → anchored cores reject mid-sentence mentions`,
      { field, value: settingsStore.get(field), line: lastComplete() },
    );
  }
}

// ── i) the <8-word gate: longer transcripts never reach the parser ─────
{
  resetSettings();
  await turn('can you please talk slower when you answer me back');
  check(
    settingsStore.get('voiceSpeed') === 1.0 && lastComplete() === CANT_SEE,
    'no fire: 10-word plea containing "talk slower" skips the parser entirely',
    { speed: settingsStore.get('voiceSpeed'), line: lastComplete() },
  );

  resetSettings();
  await turn('how do i mute the routines when i am busy');
  check(
    settingsStore.get('routinesMuted') === false && lastComplete() === CANT_SEE,
    'no fire: 10-word question containing "mute the routines" skips the parser',
    { v: settingsStore.get('routinesMuted'), line: lastComplete() },
  );
}

// Sanity: the test never reached a model call or a native input. The
// empty-capture bail is the only path that can prove that, so assert it
// ran instead of trusting that no network happened. Two once-per-session
// error cues are legitimate: the missing-TTS-key toast and (since the
// OS-voice fallback landed) the 'system voice' notice — each at most once.
const KNOWN_CUES = [
  'key in the panel to hear replies',
  'speaking with system voice — voice provider unavailable',
];
check(
  errors.length <= 2 && errors.every((e) => KNOWN_CUES.some((k) => e.includes(k))),
  'sanity: only the once-per-session TTS cues surfaced',
  errors,
);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
