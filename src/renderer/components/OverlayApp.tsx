import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type {
  VoiceState,
  SceneCue,
  AgentProfile,
  AgentStatus,
  AgentAction,
  TypeRequest,
  DisplayInfo,
  CaptureMode,
  FlickySettings,
} from '../../shared/types';
import { Waveform } from './Waveform';
import { InkLayer, usePrefersReducedMotion } from './InkLayer';

// Vite resolves `new URL(..., import.meta.url)` at build time and emits
// the worklet as a static asset. The `.js` file is hand-written plain
// JS (worklets must be), so it isn't part of the TS compilation unit;
// we only need its URL to feed `audioWorklet.addModule()`.
const captureWorkletUrl = new URL('../audio-capture-worklet.js', import.meta.url).href;

// UI chimes (synthesized by scripts/gen-sfx.mts). `new URL(...,
// import.meta.url)` makes vite emit each wav as a bundled asset so the
// packaged app resolves it — same convention as the worklet above. Keys
// are the IPC.PLAY_SFX names main emits.
const SFX_URLS: Record<string, string> = {
  'agent-launch': new URL('../assets/sfx/agent-launch.wav', import.meta.url).href,
  'agent-done': new URL('../assets/sfx/agent-done.wav', import.meta.url).href,
  'agent-needs-you': new URL('../assets/sfx/agent-needs-you.wav', import.meta.url).href,
  heard: new URL('../assets/sfx/heard.wav', import.meta.url).href,
};

// Offset the companion cursor ~1/5 inch (≈19px at 96dpi) down-right
// of the real mouse so the tip doesn't sit directly on top of it.
const FOLLOW_OFFSET_X = 14;
const FOLLOW_OFFSET_Y = 8;

const POINTING_PHRASES = [
  'right here!',
  'found it!',
  'this one!',
  'over here!',
  'look!',
  'here it is!',
  'this thing!',
  'see this?',
];

function randomPhrase(): string {
  return POINTING_PHRASES[Math.floor(Math.random() * POINTING_PHRASES.length)];
}

// ── VAD tuning (always-on mode) ─────────────────────────────────────
// The worklet posts one 128-sample quantum per message at 16 kHz, so
// thresholds are in RMS amplitude and durations in wall-clock ms. The
// speech threshold adapts: after capture opens we measure ~1.5s of room
// tone and take max(floor, 2.5×ambientP90), so a noisy room doesn't read
// as constant speech. An utterance also needs 3 consecutive voiced
// quanta before it opens — lone clicks/pops never become turns.
const VAD_FLOOR = 0.02;
const VAD_AMBIENT_MULT = 2.5;
const VAD_CALIB_MS = 1500;
const VAD_VOICED_RUN = 3;
// A contaminated window (user talks through calibration) must never
// deafen the mic: candidates above VAD_CALIB_LOUD retry the window,
// and the accepted threshold is hard-capped so speech peaks — which
// run hotter than any room hum — always clear it.
const VAD_THRESHOLD_CAP = 0.12;
const VAD_CALIB_LOUD = 0.08;
const VAD_CALIB_RETRIES = 2;
const VAD_SILENCE_END_MS = 800;
const VAD_MIN_MS = 350;
const VAD_MAX_MS = 20_000;

// Kaomoji buddy faces — a tiny chip by the companion cursor that mirrors
// voice state so users can tell at a glance what Zapi is doing.
const BUDDY_FACE: Partial<Record<VoiceState, string>> = {
  listening: '◕ ‿ ◕',
  processing: '◔ _ ◔',
  responding: '^ ω ^',
  acting: '⌐■_■',
};

type CursorMode = 'following' | 'navigating' | 'holding' | 'returning';

/**
 * Action kinds whose echo carries a real display-local point. The driver
 * fills `x: action.x ?? 0` for every kind, so a coord-less action reports
 * (0, 0) — drawing one at its reported point put every keystroke's marker
 * in the display corner. Only these kinds get an on-screen marker; the rest
 * pulse as a chip beside the status pill.
 */
const SPATIAL_ECHO_KINDS: ReadonlySet<AgentAction['kind']> = new Set([
  'move', 'click', 'dclick', 'rclick', 'drag',
]);

interface AgentEcho {
  id: number;
  /** Display-local anchor; only meaningful when `spatial` is true. */
  x: number;
  y: number;
  label: string;
  kind: AgentAction['kind'];
  /** false → chip beside the status pill, never a marker on screen. */
  spatial: boolean;
  /** Agent that produced it, when main stamped one on the echo. */
  agentId?: string;
  /** Resolved accent from that agent's profile; undefined = default amber. */
  color?: string;
  /** That agent's kaomoji, used as the caption's prefix. */
  kaomoji?: string;
}

/**
 * The echo payload as main actually sends it. `AgentAction` carries an
 * optional `agentId` that main now stamps, but the preload's inline
 * callback type hasn't picked the field up yet — so widen once here instead
 * of casting at each use site. When the preload adopts the field this alias
 * collapses to plain `AgentAction`.
 */
type AgentEchoPayload = AgentAction & { x: number; y: number; label: string };

/** One agent's latest status plus its emit order, for "most recent" picks. */
interface TrackedStatus {
  status: AgentStatus;
  seq: number;
}

/**
 * Pill priority when several agents are live: whichever is actually
 * driving the mouse outranks one thinking about it, which outranks one
 * parked waiting for a turn. Ties fall back to the most recent emit.
 */
const PHASE_PRIORITY: Record<string, number> = { acting: 3, waiting: 2, thinking: 1 };
const ACTIVE_PHASES = new Set<string>(['acting', 'waiting', 'thinking']);
const UNKNOWN_KAOMOJI = '🤖';

function agentName(profiles: Map<string, AgentProfile>, id: string | undefined): string {
  if (!id) return 'agent';
  const hit = profiles.get(id);
  if (hit) return hit.name;
  // 'main' predates profiles and is still the default agent id.
  return id === 'main' ? 'Zapi' : id;
}
function agentKaomoji(profiles: Map<string, AgentProfile>, id: string | undefined): string {
  return (id && profiles.get(id)?.kaomoji) || UNKNOWN_KAOMOJI;
}

/**
 * Accent for a pill. The default agent deliberately gets none so the pill
 * keeps its house amber — a second agent's colour only shows up when the
 * lease actually moved off 'main'.
 */
function pillAccent(profiles: Map<string, AgentProfile>, id: string | undefined): string | undefined {
  if (!id || id === 'main') return undefined;
  return profiles.get(id)?.color;
}

/**
 * agentId → profile, for the pill's kaomoji / name. Loaded once on mount and
 * refreshed when a status names an agent we have no profile for — the panel
 * can create agents at runtime and there's no profiles-changed event, so a
 * status naming an unknown id is the only signal available.
 */
function useAgentProfiles(knownIdsKey: string): Map<string, AgentProfile> {
  const [profiles, setProfiles] = useState<Map<string, AgentProfile>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    window.flicky
      .getAgents()
      .then((list) => {
        if (cancelled) return;
        setProfiles(new Map((list ?? []).map((p) => [p.id, p])));
      })
      .catch(() => {
        /* cosmetic only — fall back to the agent id */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missing = useMemo(
    () => (knownIdsKey ? knownIdsKey.split(',') : []).filter((id) => !profiles.has(id)),
    [knownIdsKey, profiles],
  );
  useEffect(() => {
    if (missing.length === 0) return;
    window.flicky
      .getAgents()
      .then((list) => setProfiles(new Map((list ?? []).map((p) => [p.id, p]))))
      .catch(() => {
        /* leave the fallback in place */
      });
  }, [missing.join(',')]);

  return profiles;
}

/** Display-local render of one agent echo, shaped by its action kind. */
function AgentEchoView({ echo }: { echo: AgentEcho }) {
  // The accent rides on a custom property so one rule can tint every
  // element of the echo; absent, each rule keeps its built-in amber.
  const style: CSSProperties = {
    left: echo.x,
    top: echo.y,
    ...(echo.color ? ({ '--echo-accent': echo.color } as CSSProperties) : {}),
  };
  // Only pointer kinds land here, so the label is always worth a caption.
  // The kaomoji prefix is what tells two concurrent agents' ripples apart.
  const caption = echo.label ? (
    <span className="agent-echo-chip">
      {echo.kaomoji ? `${echo.kaomoji} ` : ''}
      {echo.label}
    </span>
  ) : null;
  switch (echo.kind) {
    case 'dclick':
      // Second ring chases the first so a double-click reads as two hits.
      return (
        <div className="agent-echo" style={style} aria-hidden>
          <span className="agent-echo-ring" />
          <span className="agent-echo-ring delay" />
          {caption}
        </div>
      );
    case 'rclick':
      return (
        <div className="agent-echo" style={style} aria-hidden>
          <span className="agent-echo-ring dashed" />
          {caption}
        </div>
      );
    case 'drag':
      // Main sends no drag endpoint (the echo payload is
      // {x, y, label, kind}), so a drag reads as its grab point. The
      // .agent-echo-drag styles stay for whenever it does send one.
      return (
        <div className="agent-echo" style={style} aria-hidden>
          <span className="agent-echo-ring dashed" />
          {caption}
        </div>
      );
    case 'move':
      // A bare dot — a move is a hover, not a hit, so no ring.
      return (
        <div className="agent-echo" style={style} aria-hidden>
          <span className="agent-echo-dot" />
          {caption}
        </div>
      );
    default:
      // click and any future pointer kind fall back to the plain ripple.
      return (
        <div className="agent-echo" style={style} aria-hidden>
          <span className="agent-echo-ring" />
          {caption}
        </div>
      );
  }
}

/**
 * Non-spatial echo glyph: typing, a keystroke, a scroll notch and the
 * wait/done/fail beats have no point on screen, so they narrate
 * themselves in the stack beside the run's progress pill instead of
 * claiming a coordinate the driver never had. Returns the glyph only —
 * the caller owns the shared stack container so concurrent echoes stack
 * instead of piling onto one another at the same fixed spot.
 */
function AgentEchoGlyph({ echo }: { echo: AgentEcho }) {
  switch (echo.kind) {
    case 'type':
      return (
        <span className="agent-echo-key" aria-hidden>
          ⌨
        </span>
      );
    case 'key':
      return (
        <span className="agent-echo-key" aria-hidden>
          <kbd>{echo.label || 'key'}</kbd>
        </span>
      );
    case 'scroll': {
      // Main sends no direction field, but describe() bakes it into the
      // label ("scroll up 3"), so recover it from there.
      const dir = /up|down|left|right/i.exec(echo.label ?? '')?.[0].toLowerCase();
      return (
        <span className={`agent-echo-scroll scroll-${dir ?? 'down'}`} aria-hidden>
          {dir === 'up' ? '▲▲' : dir === 'left' ? '◀◀' : dir === 'right' ? '▶▶' : '▼▼'}
        </span>
      );
    }
    default:
      // wait / done / fail: the label is the whole message ("wait 750ms",
      // "task complete"), so show it rather than a bare glyph.
      return <span className="agent-echo-chip-label">{echo.label}</span>;
  }
}

export function OverlayApp() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [cursorMode, setCursorMode] = useState<CursorMode>('following');
  const [companionPos, setCompanionPos] = useState({ x: 0, y: 0 });
  const [isCursorOnThisDisplay, setIsCursorOnThisDisplay] = useState(false);
  // Ref mirror for the sfx handler — IPC callbacks can't read render
  // state, and a broadcast chime must play on exactly one overlay.
  const cursorOnDisplayRef = useRef(false);
  const [typeToast, setTypeToast] = useState<TypeRequest | null>(null);
  const typeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Seeded synchronously from the window's launch arguments so the first
  // cursor-position message already has a coordinate space to map into.
  const displayRef = useRef<DisplayInfo | null>(window.flicky.getDisplayInfo());
  // Render-facing mirror of displayRef — refs don't re-render, so DPI /
  // resolution changes would otherwise leave InkLayer painting with stale
  // bounds until some unrelated state update happened to refresh it.
  const [displayInfo, setDisplayInfo] = useState<DisplayInfo | null>(displayRef.current);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnAnimRef = useRef<number | null>(null);
  const cursorPosRef = useRef({ x: 0, y: 0 });
  const companionPosRef = useRef({ x: 0, y: 0 });

  // ── Scene (draw strokes + point cues) ─────────────────────────────
  // Main sends SCENE { cues } once, then SCENE_CUE beat indexes that
  // reveal cues[0..i] cumulatively. InkLayer owns the strokes; point
  // cues hop the companion cursor here (ported from walkthrough logic).
  const [sceneCues, setSceneCues] = useState<SceneCue[]>([]);
  const [sceneBeat, setSceneBeat] = useState<number | null>(null);
  const [inkFading, setInkFading] = useState(false);
  const [scenePoint, setScenePoint] = useState<{ cue: SceneCue; phrase: string } | null>(null);
  const inkFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of sceneCues for the beat handler — read here instead of
  // inside a setState updater, which React may invoke twice in dev.
  const sceneCuesRef = useRef<SceneCue[]>([]);
  sceneCuesRef.current = sceneCues;

  // ── Agent echo ────────────────────────────────────────────────────
  // Keyed by agentId: several agents can be live at once, and the single
  // pill below shows the lease holder among them.
  const [agentStatuses, setAgentStatuses] = useState<Map<string, TrackedStatus>>(
    () => new Map(),
  );
  const statusesRef = useRef<Map<string, TrackedStatus>>(new Map());
  const statusSeqRef = useRef(0);
  const [agentEchoes, setAgentEchoes] = useState<AgentEcho[]>([]);
  const agentEchoIdRef = useRef(0);
  // Terminal-outcome flash: done/failed phases show a tinted pill that
  // fades itself out, independent of the acting pill below.
  const [outcomeVisible, setOutcomeVisible] = useState(false);
  const outcomeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Always-on (vad) indicator ─────────────────────────────────────
  // True while the capture gate is open in vad mode — the mic is hot and
  // hands-free turns can start. Separate from voiceState, which describes
  // the turn, not the gate.
  const [vadGateOpen, setVadGateOpen] = useState(false);
  // 'Heard you' tick: bumped every time an utterance ships to main, with
  // its own visibility window so the flash reads even mid-pulse.
  const [heardTick, setHeardTick] = useState(0);
  const [heardVisible, setHeardVisible] = useState(false);
  const heardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Cursor toggle ─────────────────────────────────────────────────
  // Main keeps overlays alive for ink even with the cursor off — the
  // renderer cooperates by hiding only the cursor chrome (triangle, halo,
  // bubble) while ink, echoes, pills, buddy, and indicators keep rendering.
  const [cursorEnabled, setCursorEnabled] = useState(true);
  // Reduced motion: snap the return glide (CSS covers the rest).
  const reducedMotion = usePrefersReducedMotion();
  // ── Contextual hints ──────────────────────────────────────────────
  // All seeded from settings below; defaults match DEFAULT_SETTINGS so a
  // failed read behaves like a fresh install, not a broken overlay.
  const [pttShortcut, setPttShortcut] = useState('Ctrl+Alt+X');
  const [alwaysOnEnabled, setAlwaysOnEnabled] = useState(false);
  const [dictationEnabled, setDictationEnabled] = useState(false);
  /** True while the capture gate is open in ptt mode (talk turn). */
  const [pttGateOpen, setPttGateOpen] = useState(false);
  // Idle guidance: shown after 12s of quiet hands-free idleness.
  const [idleHintVisible, setIdleHintVisible] = useState(false);
  const idleHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mic capture ──────────────────────────────────────────────────────
  // The audio graph (stream → AudioContext → AudioWorkletNode → destination)
  // is built once on first PTT and kept warm across turns. Start/stop just
  // toggles a flag inside the worklet so we don't pay getUserMedia or
  // worklet-module-load latency on every press.
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** true while getUserMedia / addModule are in flight. */
  const micStartingRef = useRef(false);
  /** set by stopMic so a pending start can bail before attaching. */
  const micStopRequestedRef = useRef(false);
  /** Peak RMS since the last level report; reported ~20×/s to main. */
  const micPeakRef = useRef(0);
  const micLevelSentAtRef = useRef(0);
  // ── VAD state (always-on 'vad' capture mode) ──────────────────────
  // In 'ptt' mode every chunk is forwarded live (behavior unchanged).
  // In 'vad' mode chunks are buffered here and shipped as one utterance.
  const captureModeRef = useRef<CaptureMode>('ptt');
  const vadChunksRef = useRef<Int16Array[]>([]);
  const vadSamplesRef = useRef(0);
  const vadActiveRef = useRef(false);
  const vadStartAtRef = useRef(0);
  const vadLastSpeechAtRef = useRef(0);
  /** Adaptive speech threshold — floor until room-tone calibration lands. */
  const vadThresholdRef = useRef(VAD_FLOOR);
  /** Room-tone RMS samples gathered during the calibration window. */
  const vadCalibRmsRef = useRef<number[]>([]);
  const vadCalibStartRef = useRef(0);
  const vadCalibratingRef = useRef(false);
  /** Contaminated-window retries used (reset per capture). */
  const vadCalibAttemptsRef = useRef(0);
  /** Consecutive voiced quanta while no utterance is open (pop guard). */
  const vadVoicedRunRef = useRef(0);
  /** Pre-open chunks held so the run-up audio isn't clipped on open. */
  const vadPendingRef = useRef<Int16Array[]>([]);
  const voiceStateRef = useRef<VoiceState>('idle');

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  // ── TTS playback (cancelable) ───────────────────────────────────────
  const ttsRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  // Lazy chime elements, one per known sfx name — created on first play
  // so an idle overlay never spins up audio it never uses.
  const sfxRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Same-name burst guard: a launch→done beat can fire within a frame of
  // each other on fast runs, and a double-struck chime reads as a glitch,
  // not an echo. Different names still overlap freely.
  const sfxLastRef = useRef<Map<string, number>>(new Map());
  const playSfx = useCallback((name: string) => {
    const url = SFX_URLS[name];
    if (!url) return;
    const now = Date.now();
    if (now - (sfxLastRef.current.get(name) ?? -Infinity) < 400) return;
    sfxLastRef.current.set(name, now);
    let el = sfxRef.current.get(name);
    if (!el) {
      el = new Audio(url);
      // Chimes sit under the UI — loud enough to notice, never a beep.
      el.volume = 0.35;
      sfxRef.current.set(name, el);
    }
    el.currentTime = 0;
    void el.play().catch(() => {
      // Autoplay-policy or a torn-down window — a missed chime must never
      // take the overlay down, so rejections are swallowed quietly.
    });
  }, []);
  // Bumped by every stop. A play() still in flight compares the epoch it
  // captured against this one, so an interrupt reads as an interrupt
  // instead of a playback failure.
  const ttsEpochRef = useRef(0);
  const stopCurrentTts = useCallback(() => {
    ttsEpochRef.current += 1;
    const current = ttsRef.current;
    if (!current) return;
    try {
      // Drop onended first: clearing src can fire it, and a stale handler
      // would revoke a URL that a later buffer may have recycled.
      current.audio.onended = null;
      current.audio.pause();
      current.audio.currentTime = 0;
      current.audio.src = '';
    } catch { /* ignore */ }
    URL.revokeObjectURL(current.url);
    ttsRef.current = null;
  }, []);

  // ── OS-voice fallback (speechSynthesis) ─────────────────────────────
  // Main emits speak-text when no TTS provider is configured — the
  // platform voice reads the reply instead. Every call cancels the
  // current utterance first: a stale paragraph must never talk over a
  // newer reply.
  const stopOsVoice = useCallback(() => {
    try {
      window.speechSynthesis?.cancel();
    } catch { /* some Electron builds expose a dead stub — ignore */ }
  }, []);
  const speakText = useCallback((text: string, rate: number) => {
    const synth = window.speechSynthesis;
    if (!synth || !text) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    // rate arrives from main; clamp into the Web Speech range so a
    // malformed value can't throw.
    utterance.rate = Number.isFinite(rate) ? Math.min(10, Math.max(0.1, rate)) : 1;
    utterance.pitch = 1;
    // Prefer a natural Microsoft en-* voice (Windows-first target).
    // getVoices() can return [] until 'voiceschanged' fires — falling
    // through to the platform default is fine; nothing blocks on it.
    const voices = synth.getVoices();
    const preferred =
      voices.find((v) => /^en[-_]/i.test(v.lang) && /zira|aria|guy/i.test(v.name)) ??
      voices.find((v) => /^en[-_]/i.test(v.lang));
    if (preferred) utterance.voice = preferred;
    synth.speak(utterance);
  }, []);

  useEffect(() => {
    const resetVad = () => {
      vadChunksRef.current = [];
      vadSamplesRef.current = 0;
      vadActiveRef.current = false;
      vadStartAtRef.current = 0;
      vadLastSpeechAtRef.current = 0;
      // Restart room-tone calibration on every capture so a changed
      // environment (moved rooms, new fan hum) re-baselines instead of
      // inheriting a stale threshold from the last turn.
      vadThresholdRef.current = VAD_FLOOR;
      vadCalibRmsRef.current = [];
      vadCalibStartRef.current = performance.now();
      vadCalibratingRef.current = true;
      vadCalibAttemptsRef.current = 0;
      vadVoicedRunRef.current = 0;
      vadPendingRef.current = [];
    };

    // Close the calibration window and lift the threshold above the
    // room's own 90th-percentile hum. max() keeps quiet rooms on the
    // tested floor instead of chasing the noise floor into breath and
    // circuit-hiss territory.
    const maybeFinalizeVadCalib = (now: number) => {
      if (!vadCalibratingRef.current) return;
      if (now - vadCalibStartRef.current < VAD_CALIB_MS) return;
      const samples = vadCalibRmsRef.current;
      if (samples.length === 0) {
        vadCalibratingRef.current = false;
        return;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * (sorted.length - 1)))];
      const candidate = Math.max(VAD_FLOOR, VAD_AMBIENT_MULT * p90);
      // Always-on captures stay open indefinitely, so a threshold set
      // from a speech-contaminated window would deafen the mic until the
      // next capture — retry the window instead of accepting it.
      if (candidate > VAD_CALIB_LOUD && vadCalibAttemptsRef.current < VAD_CALIB_RETRIES) {
        vadCalibAttemptsRef.current += 1;
        vadCalibRmsRef.current = [];
        vadCalibStartRef.current = now;
        return;
      }
      vadCalibratingRef.current = false;
      vadCalibRmsRef.current = [];
      vadCalibAttemptsRef.current = 0;
      vadThresholdRef.current = Math.min(VAD_THRESHOLD_CAP, candidate);
    };

    const flushVadUtterance = () => {
      const chunks = vadChunksRef.current;
      const startedAt = vadStartAtRef.current;
      const now = performance.now();
      resetVad();
      if (chunks.length === 0) return;
      // Drop blips shorter than a syllable — keypresses, clicks, noise.
      if (now - startedAt < VAD_MIN_MS) return;
      let total = 0;
      for (const c of chunks) total += c.length;
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      window.flicky.sendVadUtterance(merged.buffer);
      // 'Heard you' tick — the utterance left the building. Restart the
      // flash window so rapid back-to-back turns re-trigger visibly.
      if (heardTimerRef.current) clearTimeout(heardTimerRef.current);
      setHeardTick((t) => t + 1);
      setHeardVisible(true);
      heardTimerRef.current = setTimeout(() => {
        heardTimerRef.current = null;
        setHeardVisible(false);
      }, 900);
    };

    const handleVadChunk = (pcm: Int16Array, rms: number) => {
      // Never let Zapi hear itself — TTS playback and agent chatter
      // would otherwise loop back through the open mic as new turns.
      const vs = voiceStateRef.current;
      if (vs === 'processing' || vs === 'responding' || vs === 'acting') {
        resetVad();
        return;
      }
      const now = performance.now();
      // Feed the room-tone measurement while the window is open.
      // Detection below already uses whatever threshold is current,
      // so early speech still trips the conservative floor.
      if (vadCalibratingRef.current) {
        if (vadCalibRmsRef.current.length < 256) vadCalibRmsRef.current.push(rms);
        maybeFinalizeVadCalib(now);
      }
      const isSpeech = rms > vadThresholdRef.current;
      if (!vadActiveRef.current) {
        if (!isSpeech) {
          vadVoicedRunRef.current = 0;
          vadPendingRef.current = [];
          return;
        }
        // Run-up gate: hold the first quanta and only open after a
        // short sustained run, so clicks and pops die right here.
        vadPendingRef.current.push(pcm.slice());
        if (vadPendingRef.current.length > 8) vadPendingRef.current.shift();
        vadVoicedRunRef.current += 1;
        if (vadVoicedRunRef.current < VAD_VOICED_RUN) return;
        vadActiveRef.current = true;
        vadStartAtRef.current = now;
        vadLastSpeechAtRef.current = now;
        vadChunksRef.current = vadPendingRef.current;
        vadPendingRef.current = [];
        vadVoicedRunRef.current = 0;
        vadSamplesRef.current = vadChunksRef.current.reduce((n, c) => n + c.length, 0);
        return;
      }
      if (isSpeech) {
        vadLastSpeechAtRef.current = now;
        vadChunksRef.current.push(pcm.slice());
        vadSamplesRef.current += pcm.length;
        // Cap runaway utterances (a TV left on, a long monologue) so
        // one message never grows without bound — ship what we have.
        if (now - vadStartAtRef.current >= VAD_MAX_MS) flushVadUtterance();
      } else {
        // Keep trailing silence in the buffer so word endings aren't
        // clipped, then end the utterance after a natural pause.
        vadChunksRef.current.push(pcm.slice());
        vadSamplesRef.current += pcm.length;
        if (now - vadLastSpeechAtRef.current >= VAD_SILENCE_END_MS) flushVadUtterance();
      }
    };

    const ensureGraph = async (): Promise<AudioWorkletNode | null> => {
      if (workletNodeRef.current) return workletNodeRef.current;
      if (micStartingRef.current) return null;
      micStartingRef.current = true;
      micStopRequestedRef.current = false;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
        });
        // If a stop arrived while we were waiting on getUserMedia, the
        // user has already released the key. Don't bother building the
        // graph; the next press will re-enter and rebuild.
        if (micStopRequestedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        const ctx = new AudioContext({ sampleRate: 16000 });
        await ctx.audioWorklet.addModule(captureWorkletUrl);
        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, 'capture-processor');
        node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          // Cheap RMS so the panel's mic check (and any future meter)
          // can show that sound is actually arriving. Throttled to
          // ~20 Hz; the chunk itself is forwarded untouched in ptt mode.
          const pcm = new Int16Array(e.data);
          let sum = 0;
          for (let i = 0; i < pcm.length; i++) {
            const s = pcm[i] / 32768;
            sum += s * s;
          }
          const rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
          if (rms > micPeakRef.current) micPeakRef.current = rms;
          const now = performance.now();
          if (now - micLevelSentAtRef.current > 50) {
            micLevelSentAtRef.current = now;
            // Speech RMS sits around 0.05–0.3; scale so normal talking
            // fills most of the meter.
            window.flicky.reportMicLevel(Math.min(1, micPeakRef.current * 4));
            micPeakRef.current = 0;
          }
          if (captureModeRef.current === 'vad') {
            handleVadChunk(pcm, rms);
          } else {
            window.flicky.sendAudioChunk(e.data);
          }
        };
        // Pull-graph: source → worklet → destination. The worklet
        // leaves its outputs zeroed when 'enabled', so connecting to
        // destination is silent — we only need it so the audio engine
        // schedules `process()`.
        source.connect(node);
        node.connect(ctx.destination);
        mediaStreamRef.current = stream;
        audioCtxRef.current = ctx;
        workletNodeRef.current = node;
        return node;
      } catch (err) {
        console.error('[Zapi] Mic capture init failed:', err);
        // Nobody reads the overlay's devtools console on a packaged
        // build. Translate the DOMException into something a person can
        // act on and hand it to main, which shows it in the panel.
        const e = err as { name?: string; message?: string };
        const friendly =
          e.name === 'NotAllowedError' || e.name === 'SecurityError'
            ? 'microphone access is blocked for Zapi. Allow it in your OS privacy settings.'
            : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
              ? 'no microphone was found. Plug one in or pick a default input device in your sound settings.'
              : e.name === 'NotReadableError'
                ? 'the microphone is busy or unreadable — another app may be holding it.'
                : `${e.name ?? 'Error'}: ${e.message ?? String(err)}`;
        window.flicky.reportMicError(friendly);
        return null;
      } finally {
        micStartingRef.current = false;
      }
    };

    const startMic = async (mode: CaptureMode) => {
      // Reset the stop flag at the top so subsequent presses always
      // get a fresh start signal. On the very first press, ensureGraph
      // also resets this; on press 2+, ensureGraph short-circuits with
      // the existing node and would never clear the flag — leaving it
      // stuck `true` and silently bailing every subsequent call.
      micStopRequestedRef.current = false;
      captureModeRef.current = mode;
      // Reset unconditionally, not just for vad: a vad→ptt switch with a
      // half-buffered utterance would otherwise leave the partial sitting
      // in the buffer (never shipped, never dropped) until the next vad
      // turn, and a restart-without-STOP re-baselines room tone instead
      // of inheriting a stale threshold. PTT never reads these refs.
      resetVad();
      const node = await ensureGraph();
      // If a stop landed between ensureGraph resolving and now, don't
      // open the gate — the worklet stays muted.
      if (!node || micStopRequestedRef.current) return;
      node.port.postMessage('start');
      // The gate is genuinely open only now — a bailed start must not
      // light the always-on indicator.
      setVadGateOpen(mode === 'vad');
      setPttGateOpen(mode === 'ptt');
    };

    const stopMic = () => {
      // Flag for any in-flight ensureGraph to bail before opening the
      // gate. If the graph already exists, just mute the worklet —
      // tearing down would force a fresh getUserMedia next turn.
      micStopRequestedRef.current = true;
      workletNodeRef.current?.port.postMessage('stop');
      setVadGateOpen(false);
      setPttGateOpen(false);
      // Drop any half-spoken utterance — the turn is over, and holding
      // onto it would ship stale audio into the next capture.
      resetVad();
    };

    const unsubStart = window.flicky.onStartCapture((payload) => startMic(payload?.mode ?? 'ptt'));
    const unsubStop = window.flicky.onStopCapture(() => stopMic());

    // Play TTS audio. Any previous playback is interrupted first so
    // back-to-back responses don't stack on top of each other.
    const unsubPlayAudio = window.flicky.onPlayAudio(async (audioData) => {
      stopCurrentTts();
      const epoch = ttsEpochRef.current;
      try {
        const blob = new Blob([audioData], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsRef.current = { audio, url };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (ttsRef.current?.audio === audio) ttsRef.current = null;
        };
        await audio.play();
      } catch (err) {
        // An interrupt (stop-audio, a newer buffer) aborts a pending
        // play(); that rejection is the stop path working, not a failure.
        if (epoch === ttsEpochRef.current) {
          console.error('[Zapi] Audio playback failed:', err);
          stopCurrentTts();
        }
      }
    });

    // Main broadcasts 'stop-audio' to every overlay on each cancel
    // boundary (new turn, agent step, app quit). A buffer already handed
    // to the overlay would otherwise keep playing under the interruption —
    // same for the OS voice, which has no buffer reference to key on.
    const unsubStopAudio = window.flicky.onStopAudio(() => {
      stopCurrentTts();
      stopOsVoice();
    });

    return () => {
      unsubStart();
      unsubStop();
      unsubPlayAudio();
      unsubStopAudio();
      // Silence any in-flight TTS too — the overlay going away (display
      // unplug) must not leave an orphaned voice talking to an empty room.
      stopCurrentTts();
      stopOsVoice();
      // Real teardown on unmount — stopMic only mutes the worklet so
      // back-to-back PTT turns stay warm. When the overlay actually
      // goes away (display unplug, app quit) we release the mic and
      // close the AudioContext.
      micStopRequestedRef.current = true;
      setVadGateOpen(false);
      setPttGateOpen(false);
      if (heardTimerRef.current) {
        clearTimeout(heardTimerRef.current);
        heardTimerRef.current = null;
      }
      workletNodeRef.current?.port.postMessage('stop');
      workletNodeRef.current?.disconnect();
      workletNodeRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, [stopCurrentTts, stopOsVoice]);

  const setCursorModeSync = useCallback((mode: CursorMode) => {
    setCursorMode(mode);
  }, []);

  const setCompanionPosSync = useCallback((pos: { x: number; y: number }) => {
    companionPosRef.current = pos;
    setCompanionPos(pos);
  }, []);

  const startReturnAnimation = useCallback(() => {
    setCursorModeSync('returning');

    // Audit note: this glide is the overlay's only rAF loop and it always
    // terminates — arrival snaps it shut, and a frame cap below guarantees
    // it even if the cursor target keeps moving (multi-monitor jitter).
    // Reduced motion skips the glide and snaps straight home.
    if (reducedMotion) {
      const raw = cursorPosRef.current;
      setCompanionPosSync({ x: raw.x + FOLLOW_OFFSET_X, y: raw.y + FOLLOW_OFFSET_Y });
      setCursorModeSync('following');
      returnAnimRef.current = null;
      return;
    }

    let frames = 0;
    const animate = () => {
      const raw = cursorPosRef.current;
      const target = { x: raw.x + FOLLOW_OFFSET_X, y: raw.y + FOLLOW_OFFSET_Y };
      const current = companionPosRef.current;
      const dx = target.x - current.x;
      const dy = target.y - current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      frames += 1;
      if (dist < 2 || frames > 120) {
        setCompanionPosSync(target);
        setCursorModeSync('following');
        returnAnimRef.current = null;
        return;
      }

      const next = { x: current.x + dx * 0.08, y: current.y + dy * 0.08 };
      setCompanionPosSync(next);
      returnAnimRef.current = requestAnimationFrame(animate);
    };

    returnAnimRef.current = requestAnimationFrame(animate);
  }, [setCursorModeSync, setCompanionPosSync, reducedMotion]);

  useEffect(() => {
    if (cursorMode === 'following') {
      setCompanionPosSync({
        x: cursorPos.x + FOLLOW_OFFSET_X,
        y: cursorPos.y + FOLLOW_OFFSET_Y,
      });
    }
    cursorPosRef.current = cursorPos;
  }, [cursorPos, cursorMode, setCompanionPosSync]);

  // Hop the companion cursor to a scene point cue (display-local coords).
  const hopToScenePoint = useCallback((cue: SceneCue) => {
    const bounds = displayRef.current?.bounds;
    setScenePoint({ cue, phrase: randomPhrase() });
    setCompanionPosSync({
      x: cue.x - (bounds?.x ?? 0),
      y: cue.y - (bounds?.y ?? 0),
    });
    setCursorModeSync('navigating');
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setCursorModeSync('holding');
    }, 650);
  }, [setCompanionPosSync, setCursorModeSync]);

  useEffect(() => {
    // Cursor toggle + hint settings: seed from stored settings (defaults
    // above on read failure), then follow live changes.
    const applyHintSettings = (s: FlickySettings) => {
      setCursorEnabled(s.isClickyCursorEnabled);
      setPttShortcut(s.pushToTalkShortcut || 'Ctrl+Alt+X');
      setAlwaysOnEnabled(s.alwaysOnEnabled);
      setDictationEnabled(s.dictationEnabled);
    };
    window.flicky
      .getSettings()
      .then(applyHintSettings)
      .catch(() => {});
    const unsubSettingsChanged = window.flicky.onSettingsChanged(applyHintSettings);

    // displayRef is seeded synchronously from launch args above; this
    // push also carries bounds updates after a DPI / resolution change.
    const unsubDisplayInfo = window.flicky.onDisplayInfo((info) => {
      displayRef.current = info;
      setDisplayInfo(info);
    });

    const unsubs = [
      window.flicky.onVoiceStateChanged(setVoiceState),
      window.flicky.onCursorPosition((pos) => {
        // Main now sends a `{ off: true }` pulse to whichever overlay
        // previously owned the cursor when it leaves that display.
        // We stop receiving regular updates entirely once the cursor
        // is off-display, which is why this signal is needed at all.
        if (pos.off) {
          setIsCursorOnThisDisplay(false);
          cursorOnDisplayRef.current = false;
          return;
        }
        const bounds = displayRef.current?.bounds;
        if (bounds) {
          const onThis =
            pos.x >= bounds.x && pos.x < bounds.x + bounds.width &&
            pos.y >= bounds.y && pos.y < bounds.y + bounds.height;
          setIsCursorOnThisDisplay(onThis);
          cursorOnDisplayRef.current = onThis;
          setCursorPos({ x: pos.x - bounds.x, y: pos.y - bounds.y });
        } else {
          // Bounds unknown — hide the companion rather than risk
          // showing it on every display. Will flip on as soon as
          // display-info arrives.
          setIsCursorOnThisDisplay(false);
          cursorOnDisplayRef.current = false;
          setCursorPos(pos);
        }
      }),
      window.flicky.onScene((scene) => {
        if (returnAnimRef.current) {
          cancelAnimationFrame(returnAnimRef.current);
          returnAnimRef.current = null;
        }
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        if (inkFadeTimerRef.current) {
          clearTimeout(inkFadeTimerRef.current);
          inkFadeTimerRef.current = null;
        }
        if (!scene) {
          // Fade ink out before dropping state so strokes don't blink
          // away mid-explanation when the scene ends.
          setSceneBeat(null);
          setScenePoint(null);
          // Clear the ref immediately (not on the fade timer) so a stray
          // beat landing mid-fade can't hop the cursor to a dead scene.
          sceneCuesRef.current = [];
          setInkFading(true);
          inkFadeTimerRef.current = setTimeout(() => {
            inkFadeTimerRef.current = null;
            setSceneCues([]);
            setInkFading(false);
          }, 600);
          holdTimerRef.current = setTimeout(() => {
            holdTimerRef.current = null;
            startReturnAnimation();
          }, 1500);
          return;
        }
        setInkFading(false);
        // Pin the ref synchronously — the matching SCENE_CUE beat can
        // arrive before React commits this update, and the beat handler
        // reads the ref, not the still-pending state.
        sceneCuesRef.current = scene.cues;
        setSceneCues(scene.cues);
        setSceneBeat(null);
        setScenePoint(null);
      }),
      window.flicky.onSceneCue((i) => {
        if (i === null) {
          // Beat stream ending — SCENE(null) will schedule the fade
          // and the cursor's return flight. Just clear point UI.
          setScenePoint(null);
          return;
        }
        setSceneBeat(i);
        const cue = sceneCuesRef.current[i];
        // Point cues steer the cursor instead of drawing; anything
        // off this display is another overlay's job — skip the hop
        // but still reveal the beat so strokes stay in sync.
        if (cue && cue.kind === 'point') {
          const b = displayRef.current?.bounds;
          const onThis = !b ||
            (cue.x >= b.x && cue.x < b.x + b.width &&
              cue.y >= b.y && cue.y < b.y + b.height);
          if (onThis) hopToScenePoint(cue);
        }
      }),
      window.flicky.onAgentStatus((s) => {
        // A late 'idle' that contradicts a newer status for the same agent
        // (lower step) is dropped rather than blanking the pill mid-turn.
        const prev = statusesRef.current.get(s.agentId);
        if (s.phase === 'idle' && prev && prev.status.phase !== 'idle' && s.step < prev.status.step) {
          return;
        }
        const next = new Map(statusesRef.current);
        next.set(s.agentId, { status: s, seq: ++statusSeqRef.current });
        statusesRef.current = next;
        setAgentStatuses(next);
        // Terminal phases flash their own tinted pill, then bow out on a
        // timer that matches the 3s CSS fade — a fresh status while one is
        // showing restarts the clock instead of stacking pills.
        if (s.phase === 'done' || s.phase === 'failed') {
          if (outcomeTimerRef.current) clearTimeout(outcomeTimerRef.current);
          setOutcomeVisible(true);
          outcomeTimerRef.current = setTimeout(() => {
            outcomeTimerRef.current = null;
            setOutcomeVisible(false);
          }, 3000);
        } else {
          if (outcomeTimerRef.current) {
            clearTimeout(outcomeTimerRef.current);
            outcomeTimerRef.current = null;
          }
          setOutcomeVisible(false);
        }
      }),
      window.flicky.onAgentAction((a) => {
        const bounds = displayRef.current?.bounds;
        const ox = bounds?.x ?? 0;
        const oy = bounds?.y ?? 0;
        const spatial = SPATIAL_ECHO_KINDS.has(a.kind);
        // Belt-and-braces for pointer kinds: the driver fills x/y with 0
        // when an action carries none, and a stray 0,0 marker reads as a
        // click in the display corner. Anything outside this overlay's
        // viewport can't be a point the user acted on, so drop it.
        if (spatial && bounds) {
          const lx = a.x - ox;
          const ly = a.y - oy;
          if (lx < 0 || ly < 0 || lx > bounds.width || ly > bounds.height) return;
        }
        const id = ++agentEchoIdRef.current;
        // Main stamps agentId on echoes now; read it through the widened
        // payload type and resolve the agent's accent once, here, so the
        // renderer never has to look a profile up per element.
        const payload = a as AgentEchoPayload;
        const agentId = payload.agentId;
        const profile = agentId ? profilesRef.current.get(agentId) : undefined;
        const echo: AgentEcho = {
          id,
          // Read positionally only for pointer kinds; for everything else
          // these are the driver's 0,0 filler and are never drawn.
          x: a.x - ox,
          y: a.y - oy,
          label: a.label,
          kind: a.kind,
          spatial,
          agentId,
          color: profile?.color,
          kaomoji: agentId ? agentKaomoji(profilesRef.current, agentId) : undefined,
        };
        // Cumulative cap ~8 so a flurry of actions never litters the
        // screen; each echo still fades on its own ~1.4s timer.
        setAgentEchoes((prev) => [...prev.slice(-7), echo]);
        setTimeout(() => {
          setAgentEchoes((prev) => prev.filter((e) => e.id !== id));
        }, 1400);
      }),
      window.flicky.onTypeFulfilled((req) => {
        if (typeToastTimerRef.current) clearTimeout(typeToastTimerRef.current);
        setTypeToast(req);
        typeToastTimerRef.current = setTimeout(() => {
          setTypeToast(null);
          typeToastTimerRef.current = null;
        }, 5000);
      }),
      // Named UI chimes (agent launch/done/needs-you, heard tick). If
      // main ever broadcasts instead of single-targeting, playing on
      // every overlay would echo the chime once per display — so only
      // the cursor-bearing overlay speaks (same rule as the type toast).
      window.flicky.onPlaySfx((name) => {
        if (cursorOnDisplayRef.current) playSfx(name);
      }),
      // OS-voice fallback (main emits when no TTS provider is set). Same
      // one-voice-per-setup rule as the chimes — broadcast or single
      // target, only the cursor-bearing overlay may speak.
      window.flicky.onSpeakText((text, rate) => {
        if (cursorOnDisplayRef.current) speakText(text, rate);
      }),
    ];

    return () => {
      unsubDisplayInfo();
      unsubSettingsChanged();
      unsubs.forEach((u) => u());
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (typeToastTimerRef.current) clearTimeout(typeToastTimerRef.current);
      if (inkFadeTimerRef.current) clearTimeout(inkFadeTimerRef.current);
      if (outcomeTimerRef.current) clearTimeout(outcomeTimerRef.current);
      for (const el of sfxRef.current.values()) {
        el.pause();
        el.src = '';
      }
      sfxRef.current.clear();
      if (returnAnimRef.current) cancelAnimationFrame(returnAnimRef.current);
    };
  }, [setCursorModeSync, setCompanionPosSync, startReturnAnimation, hopToScenePoint, playSfx, speakText]);

  useEffect(() => {
    if (voiceState === 'listening') {
      // User started a new turn — interrupt anything Zapi was saying.
      stopCurrentTts();
      stopOsVoice();
      setScenePoint(null);
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (returnAnimRef.current) {
        cancelAnimationFrame(returnAnimRef.current);
        returnAnimRef.current = null;
      }
      setCursorModeSync('following');
    }
  }, [voiceState, setCursorModeSync, stopCurrentTts, stopOsVoice]);

  // A scene counts as showing until its fade completes — the guidance
  // must not whisper over an explanation that just ended.
  const sceneActive = sceneCues.length > 0 || inkFading;

  // A busy agent counts as screen activity even when the mic pipeline is
  // idle: background runtimes never flip voiceState, so without this the
  // whisper would render under the agent's status pill mid-run.
  const agentBusy = [...agentStatuses.values()].some((t) =>
    ACTIVE_PHASES.has(t.status.phase),
  );

  // Idle guidance: after 12s of quiet hands-free idleness (vad gate hot,
  // nobody talking, nothing drawn), whisper how to start. Any state
  // change disarms the timer and hides the hint immediately.
  useEffect(() => {
    if (idleHintTimerRef.current) {
      clearTimeout(idleHintTimerRef.current);
      idleHintTimerRef.current = null;
    }
    setIdleHintVisible(false);
    if (!alwaysOnEnabled || !vadGateOpen || voiceState !== 'idle' || sceneActive || agentBusy) return;
    idleHintTimerRef.current = setTimeout(() => {
      idleHintTimerRef.current = null;
      setIdleHintVisible(true);
    }, 12000);
    return () => {
      if (idleHintTimerRef.current) {
        clearTimeout(idleHintTimerRef.current);
        idleHintTimerRef.current = null;
      }
    };
  }, [alwaysOnEnabled, vadGateOpen, voiceState, sceneActive, agentBusy]);

  const isNavigating = cursorMode === 'navigating';
  const isHolding = cursorMode === 'holding';

  // Scene point cues are authored against one specific display. Render
  // the annotated cursor only there so users with multiple monitors
  // don't see the cursor hopping on a screen the cue isn't on.
  const isPointOnThisDisplay = (() => {
    if (!scenePoint) return false;
    const b = displayRef.current?.bounds;
    if (!b) return true;
    const { cue } = scenePoint;
    return (
      cue.x >= b.x && cue.x < b.x + b.width &&
      cue.y >= b.y && cue.y < b.y + b.height
    );
  })();

  const showOnThisDisplay =
    isNavigating || isHolding ? isPointOnThisDisplay : isCursorOnThisDisplay;

  const cursorTransition = isNavigating
    ? 'left 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
    : cursorMode === 'following'
      ? 'left 0.05s linear, top 0.05s linear'
      : 'none';

  const showAnnotation = (isNavigating || isHolding) && isPointOnThisDisplay;
  const isMultiStep = (scenePoint?.cue.step ?? 0) > 0 && (scenePoint?.cue.total ?? 0) > 1;
  const buddyFace = BUDDY_FACE[voiceState] ?? null;

  // ── Pill selection ────────────────────────────────────────────────
  // One pill, several possible agents. Whoever is actually driving the
  // mouse wins; a waiting agent outranks one still thinking; ties go to the
  // most recent emit so the pill never flip-flops between equals.
  const tracked = useMemo(() => [...agentStatuses.values()], [agentStatuses]);
  const activeStatus =
    tracked
      .filter((t) => ACTIVE_PHASES.has(t.status.phase))
      .sort(
        (a, b) =>
          (PHASE_PRIORITY[b.status.phase] ?? 0) - (PHASE_PRIORITY[a.status.phase] ?? 0) ||
          b.seq - a.seq,
      )[0]?.status ?? null;
  const terminalStatus =
    tracked
      .filter((t) => t.status.phase === 'done' || t.status.phase === 'failed')
      .sort((a, b) => b.seq - a.seq)[0]?.status ?? null;
  const agentIdsKey = useMemo(
    () => [...agentStatuses.keys()].sort().join(','),
    [agentStatuses],
  );
  const profiles = useAgentProfiles(agentIdsKey);
  // Mirror for the echo handler, which resolves an agent's accent at echo
  // time and must not close over a stale profile map.
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  // Terminal run outcome takes over the pill slot from the acting pill —
  // never both at once.
  const outcomePhase =
    terminalStatus?.phase === 'done' || terminalStatus?.phase === 'failed'
      ? terminalStatus.phase
      : null;
  // 'Busy, ears off' — the vad gate is open but Zapi is speaking/acting,
  // so utterances are suppressed until it goes quiet again.
  const vadSuppressed =
    voiceState === 'processing' || voiceState === 'responding' || voiceState === 'acting';
  // The status pill keys off agent phases, not voiceState — voiceState is
  // mic-side and only the 'main' runtime flips it, so a background agent's
  // entire run (queued waiting included) used to render with no pill at
  // all even while it physically drove the mouse. The outcome flash was
  // already phase-keyed for the same reason.
  const pillShowing =
    (!!activeStatus && !outcomePhase) || (outcomeVisible && !!outcomePhase);

  // Non-spatial echo chips stack upward from a fixed slot just above the
  // pill. Shared between the render loop and the bottom-stack lift below.
  const echoChips = useMemo(
    () => agentEchoes.filter((e) => !e.spatial),
    [agentEchoes],
  );

  const displayBounds = displayInfo?.bounds ?? null;

  return (
    <div className="overlay-container">
      <InkLayer cues={sceneCues} beat={sceneBeat} fading={inkFading} bounds={displayBounds} />
      {showOnThisDisplay && (
        <>
          {/* Cursor chrome hides with the toggle — everything else in this
              fragment (buddy, waveform, spinner, drive glow) keeps rendering. */}
          {showAnnotation && cursorEnabled && (
            <div
              className="target-halo"
              style={{ left: companionPos.x, top: companionPos.y }}
            />
          )}

          {/* Amber breathing ring while an agent owns the mouse. 'main'
              covers its whole run via voiceState (thinking phases keep
              it steady); a background runtime can only prove it holds
              the input lease through an 'acting' phase, so a queued
              'waiting' agent deliberately shows no glow. */}
          {(voiceState === 'acting' || activeStatus?.phase === 'acting') && (
            <span
              className="agent-drive-glow"
              style={{ left: companionPos.x, top: companionPos.y }}
              aria-hidden
            />
          )}

          <div
            className={`cursor-triangle ${isNavigating || isHolding ? 'navigating' : ''}`}
            style={{
              left: companionPos.x,
              top: companionPos.y,
              transition: cursorTransition,
              display: cursorEnabled ? undefined : 'none',
            }}
          >
            <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="fl-front" x1="10%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#e0f2fe" />
                  <stop offset="50%" stopColor="#7dd3fc" />
                  <stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
              </defs>

              {/* Single glossy triangle — tip at upper-left, body trails down-right */}
              <polygon
                points="4,4 34,14 14,32"
                fill="url(#fl-front)"
                stroke="url(#fl-front)"
                strokeWidth="3"
                strokeLinejoin="round"
              />

              {/* Upper edge gloss highlight */}
              <polyline
                points="4,4 34,14"
                fill="none"
                stroke="rgba(255,255,255,0.65)"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <polyline
                points="4,4 14,32"
                fill="none"
                stroke="rgba(255,255,255,0.4)"
                strokeWidth="1"
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Kaomoji buddy face — state mirror next to the cursor. */}
          {buddyFace && (
            <div
              className="buddy-face"
              style={{
                left: companionPos.x + 44,
                // Drops below the voice word while listening — and one
                // row further when the vad mic dot occupies that slot,
                // otherwise the dot paints over the face's left edge.
                top:
                  voiceState === 'listening'
                    ? companionPos.y + (vadGateOpen ? 76 : 52)
                    : companionPos.y + 30,
              }}
              aria-hidden
            >
              {buddyFace}
            </div>
          )}

          {voiceState === 'listening' && (
            <div
              className="overlay-waveform"
              style={{ left: companionPos.x + 44, top: companionPos.y + 2 }}
            >
              <Waveform state="listening" bars={10} height={22} />
            </div>
          )}

          {/* Voice word — 'dictating' while a ptt capture runs under the
              dictation switch (words will type, not chat), 'listening'
              otherwise. Static text, so reduced-motion safe. */}
          {voiceState === 'listening' && (
            <div
              className="voice-label"
              style={{ left: companionPos.x + 44, top: companionPos.y + 28 }}
              aria-hidden
            >
              {dictationEnabled && pttGateOpen ? 'dictating' : 'listening'}
            </div>
          )}

          {voiceState === 'processing' && (
            <div
              className="processing-spinner"
              style={{ left: companionPos.x + 44, top: companionPos.y + 6 }}
            />
          )}

          {showAnnotation && scenePoint && cursorEnabled && (
            <div
              className="pointing-bubble"
              style={{
                left: companionPos.x + 44,
                top: companionPos.y - 8,
              }}
            >
              {isMultiStep && (
                <span className="step-badge">
                  {scenePoint.cue.step}
                  <span className="step-badge-total">/{scenePoint.cue.total}</span>
                </span>
              )}
              <span className="bubble-text">
                {isMultiStep ? (scenePoint.cue.text || scenePoint.phrase) : scenePoint.phrase}
              </span>
            </div>
          )}
        </>
      )}

      {/* Always-on indicator — hot mic while the vad gate is open. Lives
          outside the cursor fragment on purpose: it must still render with
          the cursor toggled off and on displays without the cursor. */}
      {vadGateOpen && showOnThisDisplay && (
        <div
          className="vad-indicator"
          style={{ left: companionPos.x + 44, top: companionPos.y + 52 }}
          aria-hidden
        >
          <span className={`vad-dot${vadSuppressed ? ' suppressed' : ''}`} aria-hidden>
            🎤
          </span>
          {heardVisible && (
            <span key={heardTick} className="vad-heard" aria-hidden>
              ✓
            </span>
          )}
        </div>
      )}

      {/* Bottom-center stack — fixed vad dot when the cursor isn't on this
          display, plus the idle whisper. One column so the two can never
          overlap; lifted as a unit when the agent pill owns the slot, and
          again past the echo-chip column so a mid-run type/wait pulse
          can't land on top of the whisper (fixed 96px ≈ three chips —
          riding the live count would bounce the stack every 1.4s). */}
      {(idleHintVisible || (vadGateOpen && !showOnThisDisplay)) && (
        <div
          className="overlay-bottom-stack"
          style={{ bottom: (pillShowing ? 64 : 24) + (echoChips.length > 0 ? 96 : 0) }}
          aria-hidden
        >
          {vadGateOpen && !showOnThisDisplay && (
            <div className="vad-indicator-fixed" aria-hidden>
              <span className={`vad-dot${vadSuppressed ? ' suppressed' : ''}`} aria-hidden>
                🎤
              </span>
              {heardVisible && (
                <span key={heardTick} className="vad-heard" aria-hidden>
                  ✓
                </span>
              )}
            </div>
          )}
          {idleHintVisible && (
            <span className="idle-hint">listening — say “hey zapi”</span>
          )}
        </div>
      )}

      {/* Agent action echoes. Pointer kinds draw a marker at the acted
          point; coord-less kinds (type/key/scroll/wait/done/fail) pulse as
          a glyph in the single shared stack above the status pill. */}
      {agentEchoes
        .filter((e) => e.spatial)
        .map((e) => (
          <AgentEchoView key={e.id} echo={e} />
        ))}
      {echoChips.length > 0 && (
        <div
          className="agent-echo-chip-pulse"
          style={{
            bottom: pillShowing ? 64 : 24,
            // A chip's accent can't ride on the glyph itself, so the
            // shared stack carries the newest echo's tint downward.
            ...(echoChips[echoChips.length - 1]?.color
              ? ({ '--echo-accent': echoChips[echoChips.length - 1].color } as CSSProperties)
              : {}),
          }}
          aria-hidden
        >
          {echoChips.map((e) => (
            <AgentEchoGlyph key={e.id} echo={e} />
          ))}
        </div>
      )}

      {/* Agent status pill while an agent drives or queues for the
          mouse/keyboard. The interrupt hint rides inside the pill text
          so it shares the pill's fade and ellipsis behavior for free.
          With several agents live this shows the lease holder, named
          and tinted in that agent's accent — except the default agent,
          which keeps the house amber so the common case looks unchanged.
          'waiting' gets a muted breathing variant so it never reads as
          actively driving. */}
      {activeStatus && !outcomePhase &&
        (() => {
          const accent = pillAccent(profiles, activeStatus.agentId);
          const waiting = activeStatus.phase === 'waiting';
          return (
            <div
              className={`agent-pill${waiting ? ' waiting' : ''}`}
              role="status"
              style={accent ? ({ '--echo-accent': accent } as CSSProperties) : undefined}
            >
              {agentKaomoji(profiles, activeStatus.agentId)}{' '}
              {agentName(profiles, activeStatus.agentId)}{' '}
              {activeStatus.phase === 'acting'
                ? 'working…'
                : waiting
                  ? 'waiting for input…'
                  : 'thinking…'}
              {` · step ${activeStatus.step}/${activeStatus.maxSteps}`}
              {activeStatus.message ? ` · ${activeStatus.message}` : ''}
              {` · press ${pttShortcut} to interrupt`}
            </div>
          );
        })()}

      {/* Terminal outcome flash — green for done, red for failed. */}
      {outcomeVisible && terminalStatus && outcomePhase &&
        (() => {
          const accent = pillAccent(profiles, terminalStatus.agentId);
          return (
            <div
              className={`agent-pill outcome-${outcomePhase}`}
              role="status"
              style={accent ? ({ '--echo-accent': accent } as CSSProperties) : undefined}
            >
              {agentKaomoji(profiles, terminalStatus.agentId)}{' '}
              {agentName(profiles, terminalStatus.agentId)} · {outcomePhase}
              {terminalStatus.message ? ` · ${terminalStatus.message}` : ''}
            </div>
          );
        })()}

      {typeToast && isCursorOnThisDisplay && (
        // Pill top edge sits ~57px from the bottom; a toast at the CSS
        // default of 56 would just touch it, so it lifts a little.
        <div
          className="type-toast"
          role="status"
          style={{ bottom: pillShowing ? 68 : 56 }}
        >
          <div className="type-toast-row">
            <span className="type-toast-icon" aria-hidden>
              {typeToast.autoTyped ? '⌨️' : '📋'}
            </span>
            <div className="type-toast-text">
              <div className="type-toast-title">
                {typeToast.autoTyped ? (
                  'Typed for you'
                ) : (
                  <>
                    Copied — press{' '}
                    <kbd>{window.flicky.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}</kbd> to paste
                  </>
                )}
              </div>
              <div className="type-toast-preview">&ldquo;{typeToast.preview}&rdquo;</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
