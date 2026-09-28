// ── Voice / State Machine ──────────────────────────────────────────────

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'responding'
  /** Agent mode: the model is driving the mouse/keyboard. */
  | 'acting';

export type BuddyNavigationMode =
  | 'followingCursor'
  | 'navigatingToTarget'
  | 'pointingAtTarget';

// ── Transcription ──────────────────────────────────────────────────────

export type TranscriptionProviderType = 'groq' | 'openai' | 'native';

export type GroqTranscriptionModel =
  | 'whisper-large-v3'
  | 'whisper-large-v3-turbo'
  | 'distil-whisper-large-v3-en';

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
}

/**
 * How the overlay's mic gate should behave when main starts capture:
 *  'ptt' — forward every PCM chunk to main live (push-to-talk turn)
 *  'vad' — run the local VAD, buffer voiced audio, and ship each finished
 *          utterance to main as one VAD_UTTERANCE message (always-on mode)
 */
export type CaptureMode = 'ptt' | 'vad';

// ── Overlay / Displays ─────────────────────────────────────────────────

export interface DisplayInfo {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

/**
 * Prefix used to hand an overlay window its display info through
 * `webPreferences.additionalArguments`, so the renderer can read it
 * synchronously at startup instead of racing an IPC message.
 */
export const DISPLAY_INFO_ARG_PREFIX = '--zapi-display-info=';

// ── Screen Capture ─────────────────────────────────────────────────────

export interface ScreenCapture {
  dataBase64: string;
  displayId: number;
  imageWidth: number;
  imageHeight: number;
  displayBounds: { x: number; y: number; width: number; height: number };
  isCursorScreen: boolean;
}

// ── Claude API ─────────────────────────────────────────────────────────

export type ClaudeModel = 'claude-sonnet-4-6' | 'claude-opus-4-6';

export type OpenAIModel = 'gpt-5' | 'gpt-5-mini' | 'gpt-4o';

/** Which service backs the Mind (reasoning) capability. */
export type MindProvider = 'anthropic' | 'openai' | 'ollama';

/** Extended-thinking budget mapping. */
export type ReasoningDepth = 'off' | 'medium' | 'deep';

/** System-prompt variant. */
export type ReplyTone = 'concise' | 'friendly' | 'detailed';

/** How the push-to-talk shortcut behaves. */
export type PttMode = 'hold' | 'toggle';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── Scene Cues (on-screen drawing + pointing) ──────────────────────────
// A response can carry an ordered list of cues. Point cues move the
// companion cursor; the rest are strokes drawn on the transparent
// overlay. All coordinates are display-space logical pixels, already
// mapped out of screenshot space by the parser in main.

export type SceneCueKind =
  | 'point'   // cursor hops to x,y with a caption bubble
  | 'arrow'   // marker stroke from (x,y) to (x2,y2) with arrowhead
  | 'circle'  // rough ellipse ring centred at (x,y), radii (w,h)
  | 'box'     // rough rounded rect at (x,y) sized (w,h)
  | 'hilite'  // translucent marker highlight at (x,y) sized (w,h)
  | 'path'    // freehand polyline through `points`
  | 'write'   // handwritten-style text label anchored at (x,y)
  | 'clear';  // wipe accumulated strokes mid-scene

export interface SceneCue {
  kind: SceneCueKind;
  /** Display-space anchor point. */
  x: number;
  y: number;
  /** Secondary geometry — arrow tip, unused otherwise. */
  x2?: number;
  y2?: number;
  /** Width / height for box, hilite; radii for circle. */
  w?: number;
  h?: number;
  /** Polyline vertices for 'path'. */
  points?: Array<{ x: number; y: number }>;
  /** Caption / label / written text. */
  text?: string;
  /** Which captured screenshot the cue was authored against. */
  screenIndex: number;
  /** 1-based position + count, set for 'point' cues so step UI works. */
  step?: number;
  total?: number;
}

export interface Scene {
  cues: SceneCue[];
}

// ── Agent Mode (computer control) ──────────────────────────────────────

export type AgentActionKind =
  | 'click'
  | 'dclick'
  | 'rclick'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'move'
  | 'wait'
  /** open → launch a URL (shell.openExternal), an app name, or a file path. */
  | 'open'
  | 'done'
  | 'fail';

export interface AgentAction {
  kind: AgentActionKind;
  /** Which agent performed this action (echo routing/attribution). */
  agentId?: string;
  /** Display-space logical coordinates for pointer actions. */
  x?: number;
  y?: number;
  /** Drag destination. */
  x2?: number;
  y2?: number;
  /** type → text; key → combo like "ctrl+s"; done/fail → message. */
  text?: string;
  /** scroll → wheel notches (+up/-down per direction field); wait → ms. */
  amount?: number;
  /** scroll direction. */
  direction?: 'up' | 'down' | 'left' | 'right';
  screenIndex?: number;
}

// ── Agent Profiles (multi-agent "Clickys" model) ───────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  /** Kaomoji face shown on the overlay/status for this agent. */
  kaomoji: string;
  /** Accent color for pills/badges. */
  color: string;
  createdAt: number;
  archived: boolean;
}

export type AgentPhase = 'idle' | 'thinking' | 'waiting' | 'acting' | 'done' | 'failed';

/**
 * A scheduled routine owned by an agent — runs `task` on an interval or
 * daily at a fixed time, posting results into that agent's chat.
 */
export interface Routine {
  id: string;
  agentId: string;
  name: string;
  /** 'interval' runs every intervalMinutes; 'daily' runs at timeOfDay HH:MM. */
  kind: 'interval' | 'daily';
  intervalMinutes?: number;
  timeOfDay?: string;
  /** The instruction the agent executes (talk-mode turn by default). */
  task: string;
  enabled: boolean;
  lastRunAt?: number;
}

/**
 * A file an agent produced (sheet, doc, image, code, ...). Stored under
 * the app's artifacts dir; surfaced as a pile on the agent's card/chat.
 */
export interface Artifact {
  id: string;
  agentId: string;
  /** Display title (usually filename). */
  title: string;
  /** Absolute path on disk. */
  path: string;
  /** Broad kind for icons. */
  kind: 'sheet' | 'doc' | 'image' | 'code' | 'other';
  createdAt: number;
  size?: number;
}

/** A proactive task card suggested for an agent. */
export interface Suggestion {
  id: string;
  agentId: string;
  title: string;
  /** The instruction run when accepted. */
  task: string;
  /** Why it was suggested (shown under the title). */
  reason?: string;
  createdAt: number;
  dismissed: boolean;
}

export interface AgentStatus {
  /** Which agent this status belongs to. */
  agentId: string;
  phase: AgentPhase;
  step: number;
  maxSteps: number;
  /** Last action description / result for the status line. */
  message?: string;
}

/**
 * A request from the model to type text into whatever field the user
 * has focused. Currently fulfilled via clipboard handoff (text copied
 * to clipboard, user presses ⌘V); a future "auto-type" mode will use
 * a native key-event hook to type directly when the user has opted in.
 */
export interface TypeRequest {
  text: string;
  /** What was typed/copied — surfaced in the toast UI for confirmation. */
  preview: string;
  /** True when the text was actually auto-typed; false when copied. */
  autoTyped: boolean;
}

// ── Local Connections (Ollama / OpenAI-compatible local endpoints) ─────

export interface OllamaModelInfo {
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
  digest?: string;
}

export interface LocalConnection {
  id: string;
  type: 'local' | 'external';
  label?: string;
  url: string;
  enabled: boolean;
  bearerEnabled: boolean;
  prefixId?: string;
  modelIds: string[];
  activeModelId?: string;
  tags: string[];
}

// ── API Keys ───────────────────────────────────────────────────────────

export type ApiKeyName = 'anthropic' | 'openai' | 'elevenlabs' | 'fishaudio' | 'groq';

export interface ApiKeyStatus {
  anthropic: boolean;
  openai: boolean;
  elevenlabs: boolean;
  fishaudio: boolean;
  groq: boolean;
}

/** Result of a live round-trip against a provider with a candidate key. */
export interface ApiKeyValidation {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** OS-level permission snapshot. Values are true when granted or when
 *  the platform has no such gate. */
export interface PermissionStatus {
  microphone: boolean;
  screen: boolean;
  accessibility: boolean;
  /** Raw OS status for the mic so the UI can distinguish "not asked yet"
   *  from "explicitly blocked". */
  microphoneStatus: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
}

// ── Voice / TTS ────────────────────────────────────────────────────────

/** Which speech provider synthesizes spoken replies. */
export type TtsProvider = 'elevenlabs' | 'fishaudio';
/** Fish Audio TTS model header. 's2.1-pro-free' = $0 dev tier (same quality). */
export type FishTtsModel = 's2.1-pro-free' | 's2.1-pro' | 's2-pro' | 's1';

/** Built-in voice presets we curate for the voice picker. */
export interface VoicePreset {
  id: string;
  name: string;
  description: string;
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'Fahco4VZzobUeiPqni1S', name: 'Tom', description: 'custom · en-US' },
  { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', description: 'warm · conversational · en-US' },
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'calm · narrator · en-US' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', description: 'strong · confident · en-US' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', description: 'soft · friendly · en-US' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'well-rounded · en-US' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', description: 'crisp · narration · en-US' },
];

// ── Chat History ───────────────────────────────────────────────────────

export interface ChatEntry {
  id: string;
  timestamp: number;
  userText: string;
  assistantText: string;
  /** What produced this turn — plain talk, a dictated paste, or an agent run. */
  kind?: 'talk' | 'dictation' | 'agent';
  /** Owning agent profile id; absent means the default 'main' agent. */
  agentId?: string;
  /** False until the user has opened that agent's chat — drives unread dots. */
  read?: boolean;
  /** Artifact ids produced during this turn, if any. */
  artifactIds?: string[];
}

// ── Usage metering ─────────────────────────────────────────────────────

export interface UsageStats {
  /** 'YYYY-MM' bucket — rolls over monthly. */
  month: string;
  talkTurns: number;
  agentMessages: number;
  dictationUtterances: number;
  /** Per-agent counters keyed by AgentProfile.id; totals above keep working. */
  perAgent?: Record<
    string,
    { talkTurns: number; agentMessages: number; dictationUtterances: number }
  >;
}

// ── Memory / Context ───────────────────────────────────────────────────

export interface MemoryStats {
  /** Approximate total tokens currently held in context. */
  tokens: number;
  /** Soft cap that triggers auto-compaction. */
  tokenBudget: number;
  /** Full messages held verbatim. */
  messageCount: number;
  /** Messages that have been summarized into the rolling summary. */
  summarizedCount: number;
  /** Whether a rolling summary is currently prepended to context. */
  hasSummary: boolean;
  /** Unix ms of last auto/manual compaction, or null. */
  lastCompactedAt: number | null;
}

// ── Settings ───────────────────────────────────────────────────────────

export type StreamVisibility = 'off' | 'responses' | 'always';

export interface StreamWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlickySettings {
  // Mind
  mindProvider: MindProvider;
  selectedModel: ClaudeModel;
  selectedOpenAIModel: OpenAIModel;
  reasoningDepth: ReasoningDepth;
  replyTone: ReplyTone;

  // Voice (TTS)
  ttsProvider: TtsProvider;
  voiceId: string;
  /** Fish Audio reference_id (voice model id). '' = provider default voice. */
  fishVoiceId: string;
  /** Fish Audio model header — 's2.1-pro-free' bills $0; without it the
   * request defaults to paid s2.1-pro and 402s on a $0-credit account. */
  fishTtsModel: FishTtsModel;
  voiceSpeed: number;    // 0.7 – 1.2 (ElevenLabs accepted range)
  voiceStability: number; // 0 – 1
  speakReplies: boolean;

  // Ear (transcription)
  groqTranscriptionModel: GroqTranscriptionModel;
  transcriptionProvider: TranscriptionProviderType;

  // General
  isClickyCursorEnabled: boolean;
  launchAtLogin: boolean;
  pushToTalkShortcut: string;
  /** Dedicated global hotkey for computer-control turns — its utterance
   * is forced to the agent loop with no wake word or verb detection.
   * Holding this key IS the takeover consent. */
  agentPttShortcut: string;
  /**
   * How the push-to-talk shortcut behaves:
   *   'hold'   — record while the key is held, send on release
   *               (Windows/Linux only; macOS falls back to 'toggle' because
   *               Electron's globalShortcut exposes no key-up event there)
   *   'toggle' — first tap starts recording, second tap stops and sends
   */
  pttMode: PttMode;
  /**
   * If true, Zapi may type text directly into the focused field when
   * the model emits a [TYPE:...] tag. Requires Accessibility permission
   * on macOS and the native auto-typer module to be available; falls
   * back to clipboard handoff in either case. Off by default.
   */
  autoTypeEnabled: boolean;
  /**
   * Controls the transparent stream window:
   * - 'off'       — never shown
   * - 'responses' — shown only while Zapi is actively answering
   * - 'always'    — shown continuously once the app starts
   */
  streamVisibility: StreamVisibility;
  /** Last known position + size of the stream window; null = auto-place. */
  streamWindowBounds: StreamWindowBounds | null;

  // Modes
  /**
   * Always-on listening: the mic stays open and a local VAD in the
   * overlay segments utterances; each utterance becomes a normal turn
   * without touching the push-to-talk shortcut.
   */
  alwaysOnEnabled: boolean;
  /**
   * Dictation mode: transcribed speech is typed into the focused field
   * instead of being sent to the model.
   */
  dictationEnabled: boolean;
  /** Push-to-dictate global hotkey — transcribes straight into the focused field. */
  dictationShortcut: string;
  /**
   * Master switch for agent mode. When on, turns whose transcript starts
   * with the agent trigger ("zapi agent", "hey agent", ...) run the
   * computer-control loop instead of the talk loop.
   */
  agentEnabled: boolean;
  /** Hard cap on screenshot→act iterations inside one agent run. */
  agentMaxSteps: number;
  /**
   * Free-form OpenAI model id. When non-empty it wins over
   * selectedOpenAIModel — lets users point at newly released or custom
   * endpoint model names the picker doesn't list.
   */
  customOpenAIModel: string;
  /**
   * OpenAI-compatible base URL override (ClinePass, proxies, etc.).
   * Empty = default api.openai.com. Normalized: trailing slash + /v1 stripped.
   */
  openAIBaseUrl: string;

  /** Named companion agents ("Clickys" model). 'main' is always present. */
  agents: AgentProfile[];
  /** Scheduled routines owned by agents (interval/daily). */
  routines: Routine[];
  /** When true, routine completions stay silent (no TTS/overlay announce). */
  routinesMuted: boolean;

  // Local model connections
  localConnections: LocalConnection[];

  // Lifecycle
  onboardingComplete: boolean;
  apiKeyStatus: ApiKeyStatus;
  /** false when OS safeStorage is unavailable (keys stored unencrypted). */
  encryptionAvailable: boolean;
}

export const DEFAULT_SETTINGS: FlickySettings = {
  // ClinePass-first: new installs land on the OpenAI-compatible provider
  // (kept in lockstep with settings-store's DEFAULTS).
  mindProvider: 'openai',
  selectedModel: 'claude-sonnet-4-6',
  selectedOpenAIModel: 'gpt-5',
  reasoningDepth: 'off',
  replyTone: 'friendly',

  voiceId: 'pMsXgVXv3BLzUgSXRplE',
  ttsProvider: 'fishaudio',
  fishVoiceId: '',
  fishTtsModel: 's2.1-pro-free',
  voiceSpeed: 1.0,
  voiceStability: 0.5,
  speakReplies: true,

  groqTranscriptionModel: 'whisper-large-v3-turbo',
  transcriptionProvider: 'groq',

  isClickyCursorEnabled: true,
  launchAtLogin: false,
  pushToTalkShortcut: 'Ctrl+Alt+X',
  agentPttShortcut: 'Ctrl+Shift+A',
  pttMode: 'hold',
  autoTypeEnabled: false,
  streamVisibility: 'off',
  streamWindowBounds: null,

  alwaysOnEnabled: false,
  dictationEnabled: false,
  dictationShortcut: 'Ctrl+Alt+D',
  agentEnabled: true,
  agentMaxSteps: 15,
  customOpenAIModel: '',
  openAIBaseUrl: '',
  agents: [
    {
      id: 'main',
      name: 'Zapi',
      kaomoji: '(•‿•)',
      color: '#7b4dff',
      createdAt: 0,
      archived: false,
    },
  ],
  routines: [],
  routinesMuted: false,

  localConnections: [],

  onboardingComplete: false,
  apiKeyStatus: { anthropic: false, openai: false, elevenlabs: false, fishaudio: false, groq: false },
  encryptionAvailable: true,
};

// ── IPC Channels ───────────────────────────────────────────────────────

export const IPC = {
  // Main → Renderer
  VOICE_STATE_CHANGED: 'voice-state-changed',
  TRANSCRIPT_UPDATE: 'transcript-update',
  AI_RESPONSE_CHUNK: 'ai-response-chunk',
  AI_RESPONSE_COMPLETE: 'ai-response-complete',
  /** Full scene payload ({ cues: SceneCue[] } | null). */
  SCENE: 'scene',
  /** Beat index inside the active scene, or null when it ends. */
  SCENE_CUE: 'scene-cue',
  /** Agent-mode status ({ phase, step, maxSteps, message? }) for panel/stream/overlay. */
  AGENT_STATUS: 'agent-status',
  /** One executed agent action, for the overlay's click-ripple echo. */
  AGENT_ACTION: 'agent-action',
  /** Overlay → Main: a VAD-segmented utterance (PCM16 mono 16 kHz) in always-on mode. */
  VAD_UTTERANCE: 'vad-utterance',
  TYPE_FULFILLED: 'type-fulfilled',
  CURSOR_POSITION: 'cursor-position',
  SETTINGS_CHANGED: 'settings-changed',
  PERMISSION_STATUS: 'permission-status',
  MEMORY_STATS: 'memory-stats',
  CHAT_ENTRY_ADDED: 'chat-entry-added',
  /** A turn failed (bad key, network, provider error). Payload: message. */
  AI_ERROR: 'ai-error',
  /** The push-to-talk accelerator fired (used by setup to verify it). */
  PTT_SHORTCUT_FIRED: 'ptt-shortcut-fired',
  /** Mic input level 0..1 while capture is active (throttled). */
  MIC_LEVEL: 'mic-level',
  /** getUserMedia / AudioContext failed in the capture renderer. */
  MIC_ERROR: 'mic-error',

  // Renderer → Main
  /** Round-trip a candidate key against its provider. */
  VALIDATE_API_KEY: 'validate-api-key',
  /** Same check against the key already in the encrypted store. */
  VALIDATE_STORED_API_KEY: 'validate-stored-api-key',
  GET_APP_VERSION: 'get-app-version',
  /** While active, the PTT shortcut only emits PTT_SHORTCUT_FIRED and
   *  does not start recording — lets setup verify the binding safely. */
  PTT_TEST_START: 'ptt-test-start',
  PTT_TEST_STOP: 'ptt-test-stop',
  /** Run mic capture without transcription so setup can show levels. */
  MIC_TEST_START: 'mic-test-start',
  MIC_TEST_STOP: 'mic-test-stop',
  SET_MODEL: 'set-model',
  SET_OPENAI_MODEL: 'set-openai-model',
  SET_MIND_PROVIDER: 'set-mind-provider',
  SET_REASONING_DEPTH: 'set-reasoning-depth',
  SET_REPLY_TONE: 'set-reply-tone',
  SET_VOICE_ID: 'set-voice-id',
  SET_VOICE_SPEED: 'set-voice-speed',
  SET_VOICE_STABILITY: 'set-voice-stability',
  SET_SPEAK_REPLIES: 'set-speak-replies',
  SET_GROQ_MODEL: 'set-groq-model',
  TOGGLE_CURSOR: 'toggle-cursor',
  SET_LAUNCH_AT_LOGIN: 'set-launch-at-login',
  SET_PUSH_TO_TALK_SHORTCUT: 'set-push-to-talk-shortcut',
  SET_AGENT_PTT_SHORTCUT: 'set-agent-ptt-shortcut',
  SET_PTT_MODE: 'set-ptt-mode',
  SET_AUTO_TYPE_ENABLED: 'set-auto-type-enabled',
  SET_STREAM_VISIBILITY: 'set-stream-visibility',
  SET_STREAM_WINDOW_BOUNDS: 'set-stream-window-bounds',
  /** Voice (TTS) provider + per-provider voice id. */
  SET_TTS_PROVIDER: 'set-tts-provider',
  SET_FISH_VOICE_ID: 'set-fish-voice-id',
  /** send FishTtsModel → persist + apply the Fish model header. */
  SET_FISH_TTS_MODEL: 'set-fish-tts-model',
  // Panel window chrome — the macOS traffic lights, on Windows.
  /** invoke → void. Minimize the panel window. */
  PANEL_MINIMIZE: 'panel-minimize',
  /** invoke → boolean. Toggle maximize; resolves the new state. */
  PANEL_MAXIMIZE: 'panel-maximize',
  // Mode switches
  SET_ALWAYS_ON: 'set-always-on',
  SET_DICTATION: 'set-dictation',
  SET_DICTATION_SHORTCUT: 'set-dictation-shortcut',
  SET_AGENT_ENABLED: 'set-agent-enabled',
  SET_AGENT_MAX_STEPS: 'set-agent-max-steps',
  /** Free-form OpenAI model id override. */
  SET_CUSTOM_OPENAI_MODEL: 'set-custom-openai-model',
  /** OpenAI-compatible base URL override (ClinePass etc.). */
  SET_OPENAI_BASE_URL: 'set-openai-base-url',
  /** Renderer → Main: stop a running agent loop immediately. Payload: agentId? */
  AGENT_STOP: 'agent-stop',
  /** invoke → AgentProfile[] (non-archived + archived). */
  AGENT_LIST: 'agent-list',
  /** send { name, kaomoji?, color? } → creates a profile. */
  AGENT_CREATE: 'agent-create',
  /** send { id, name } → rename. */
  AGENT_RENAME: 'agent-rename',
  /** send { id } → archive (history kept). 'main' cannot be archived. */
  AGENT_ARCHIVE: 'agent-archive',
  /** invoke → Routine[] */
  ROUTINE_LIST: 'routine-list',
  /** send Routine minus id → create; send full Routine → update. */
  ROUTINE_UPSERT: 'routine-upsert',
  /** send { id } → delete. */
  ROUTINE_DELETE: 'routine-delete',
  /** send { muted: boolean } → silence/enable routine announcements. */
  SET_ROUTINES_MUTED: 'set-routines-muted',
  /** invoke agentId? → Artifact[] newest-first. */
  ARTIFACT_LIST: 'artifact-list',
  /** send { id } → open the file with the OS default app. */
  ARTIFACT_OPEN: 'artifact-open',
  /** send { id } → reveal in Explorer. */
  ARTIFACT_REVEAL: 'artifact-reveal',
  /** invoke agentId? → Suggestion[] (undismissed). */
  SUGGESTION_LIST: 'suggestion-list',
  /** send { id } → run the suggestion's task on its agent. */
  SUGGESTION_ACCEPT: 'suggestion-accept',
  /** send { id } → dismiss permanently. */
  SUGGESTION_DISMISS: 'suggestion-dismiss',
  /** send → ask the suggestions engine to refresh cards now. */
  SUGGESTION_REFRESH: 'suggestion-refresh',
  /** send { agentId } → mark that agent's chat entries read. */
  CHAT_MARK_READ: 'chat-mark-read',
  /** send { agentId, text } → run a typed turn on that agent. */
  TEXT_TURN: 'text-turn',
  /** invoke → string[]: model ids from {openAIBaseUrl||api.openai.com}/v1/models. */
  LIST_REMOTE_MODELS: 'list-remote-models',
  /** send { agentId } → open that agent's workspace folder in Explorer. */
  OPEN_AGENT_WORKSPACE: 'open-agent-workspace',
  /** Main → overlays: play a named ui sound (agent-launch/done/needs-you/question). */
  PLAY_SFX: 'play-sfx',
  /** Main → overlays: speak text via OS speechSynthesis (TTS-provider fallback). */
  SPEAK_TEXT: 'speak-text',
  SUSPEND_PUSH_TO_TALK_SHORTCUT: 'suspend-push-to-talk-shortcut',
  RESUME_PUSH_TO_TALK_SHORTCUT: 'resume-push-to-talk-shortcut',
  GET_SETTINGS: 'get-settings',
  GET_PERMISSIONS: 'get-permissions',
  REQUEST_PERMISSION: 'request-permission',
  OPEN_EXTERNAL: 'open-external',
  QUIT_APP: 'quit-app',
  REPLAY_ONBOARDING: 'replay-onboarding',
  COMPLETE_ONBOARDING: 'complete-onboarding',
  CLEAR_CONTEXT: 'clear-context',
  COMPACT_CONTEXT: 'compact-context',
  GET_MEMORY_STATS: 'get-memory-stats',
  GET_CHAT_HISTORY: 'get-chat-history',
  GET_USAGE_STATS: 'get-usage-stats',
  CLEAR_CHAT_HISTORY: 'clear-chat-history',
  PLAY_VOICE_PREVIEW: 'play-voice-preview',

  // API Key Management
  SET_API_KEY: 'set-api-key',
  DELETE_API_KEY: 'delete-api-key',
  GET_API_KEY_STATUS: 'get-api-key-status',

  // Local Connection Management
  GET_LOCAL_CONNECTIONS: 'get-local-connections',
  ADD_LOCAL_CONNECTION: 'add-local-connection',
  UPDATE_LOCAL_CONNECTION: 'update-local-connection',
  DELETE_LOCAL_CONNECTION: 'delete-local-connection',
  TEST_LOCAL_CONNECTION: 'test-local-connection',
  GET_OLLAMA_MODELS: 'get-ollama-models',
  SET_LOCAL_CONNECTION_KEY: 'set-local-connection-key',
  DELETE_LOCAL_CONNECTION_KEY: 'delete-local-connection-key',

  // Ollama Model Management
  PULL_OLLAMA_MODEL: 'pull-ollama-model',
  OLLAMA_PULL_PROGRESS: 'ollama-pull-progress',
  OLLAMA_PULL_COMPLETE: 'ollama-pull-complete',
  OLLAMA_PULL_ERROR: 'ollama-pull-error',
  DELETE_OLLAMA_MODEL: 'delete-ollama-model',
  CREATE_OLLAMA_MODEL: 'create-ollama-model',
} as const;
