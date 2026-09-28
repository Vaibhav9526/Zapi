import { contextBridge, ipcRenderer } from 'electron';
import { IPC, DISPLAY_INFO_ARG_PREFIX } from '../shared/types';
import type {
  ApiKeyName,
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  FlickySettings,
  VoiceState,
  TranscriptionResult,
  TypeRequest,
  ReasoningDepth,
  ReplyTone,
  PttMode,
  MemoryStats,
  ChatEntry,
  StreamVisibility,
  StreamWindowBounds,
  LocalConnection,
  OllamaModelInfo,
  OllamaPullProgress,
  ApiKeyValidation,
  PermissionStatus,
  DisplayInfo,
  Scene,
  AgentStatus,
  AgentAction,
  AgentProfile,
  Routine,
  Artifact,
  Suggestion,
  TtsProvider,
  FishTtsModel,
  CaptureMode,
  UsageStats,
} from '../shared/types';
import type { OllamaTestResult } from '../main/services/ollama-api';

/**
 * Display info handed to overlay windows via `additionalArguments`.
 * Read once at preload time so the renderer never has to wait for IPC
 * to learn its coordinate space.
 */
const initialDisplayInfo: DisplayInfo | null = (() => {
  const arg = process.argv.find((a) => a.startsWith(DISPLAY_INFO_ARG_PREFIX));
  if (!arg) return null;
  try {
    return JSON.parse(arg.slice(DISPLAY_INFO_ARG_PREFIX.length)) as DisplayInfo;
  } catch (err) {
    // Falling back to null silently would reproduce the exact bug this
    // argument exists to fix, so make the failure visible.
    console.warn('[Zapi] Could not parse display info from launch args:', err);
    return null;
  }
})();

const api = {
  // The host platform, resolved at runtime in the main process so it's
  // correct even when the renderer was cross-compiled (a CI build of a
  // macOS dmg on Linux would otherwise leak the build host's platform
  // through Vite's compile-time `define`).
  platform: process.platform as NodeJS.Platform,

  // ── Settings ───────────────────────────────────────────────────────
  getSettings: (): Promise<FlickySettings> => ipcRenderer.invoke(IPC.GET_SETTINGS),

  setModel: (model: ClaudeModel): void => ipcRenderer.send(IPC.SET_MODEL, model),
  setOpenAIModel: (model: OpenAIModel): void => ipcRenderer.send(IPC.SET_OPENAI_MODEL, model),
  setMindProvider: (provider: MindProvider): void => ipcRenderer.send(IPC.SET_MIND_PROVIDER, provider),
  setReasoningDepth: (depth: ReasoningDepth): void => ipcRenderer.send(IPC.SET_REASONING_DEPTH, depth),
  setReplyTone: (tone: ReplyTone): void => ipcRenderer.send(IPC.SET_REPLY_TONE, tone),

  setVoiceId: (id: string): void => ipcRenderer.send(IPC.SET_VOICE_ID, id),
  setVoiceSpeed: (speed: number): void => ipcRenderer.send(IPC.SET_VOICE_SPEED, speed),
  setVoiceStability: (stability: number): void => ipcRenderer.send(IPC.SET_VOICE_STABILITY, stability),
  setSpeakReplies: (enabled: boolean): void => ipcRenderer.send(IPC.SET_SPEAK_REPLIES, enabled),

  setGroqModel: (model: GroqTranscriptionModel): void => ipcRenderer.send(IPC.SET_GROQ_MODEL, model),

  setTtsProvider: (p: TtsProvider): void => ipcRenderer.send(IPC.SET_TTS_PROVIDER, p),
  setFishVoiceId: (id: string): void => ipcRenderer.send(IPC.SET_FISH_VOICE_ID, id),

  // ── Panel window chrome (traffic lights) ─────────────────────────────
  // invoke (not send) so the maximize toggle can hand back the new
  // state; a renderer that painted its own glyph from a stale guess would
  // show the wrong one after the second click.
  minimizePanel: (): Promise<void> => ipcRenderer.invoke(IPC.PANEL_MINIMIZE),
  toggleMaximizePanel: (): Promise<boolean> => ipcRenderer.invoke(IPC.PANEL_MAXIMIZE),

  // ── Mode switches ──────────────────────────────────────────────────
  setAlwaysOn: (enabled: boolean): void => ipcRenderer.send(IPC.SET_ALWAYS_ON, enabled),
  setDictation: (enabled: boolean): void => ipcRenderer.send(IPC.SET_DICTATION, enabled),
  setDictationShortcut: (shortcut: string): void =>
    ipcRenderer.send(IPC.SET_DICTATION_SHORTCUT, shortcut),
  setAgentEnabled: (enabled: boolean): void => ipcRenderer.send(IPC.SET_AGENT_ENABLED, enabled),
  setAgentMaxSteps: (n: number): void => ipcRenderer.send(IPC.SET_AGENT_MAX_STEPS, n),
  setCustomOpenAIModel: (m: string): void => ipcRenderer.send(IPC.SET_CUSTOM_OPENAI_MODEL, m),
  setOpenAIBaseUrl: (v: string): void => ipcRenderer.send(IPC.SET_OPENAI_BASE_URL, v),
  /** Stop a running agent loop. */
  agentStop: (agentId?: string): void => ipcRenderer.send(IPC.AGENT_STOP, agentId),

  /** Agent profiles (multi-agent). */
  getAgents: (): Promise<AgentProfile[]> => ipcRenderer.invoke(IPC.AGENT_LIST),
  createAgent: (init: { name: string; kaomoji?: string; color?: string }): void =>
    ipcRenderer.send(IPC.AGENT_CREATE, init),
  renameAgent: (id: string, name: string): void =>
    ipcRenderer.send(IPC.AGENT_RENAME, { id, name }),
  archiveAgent: (id: string): void => ipcRenderer.send(IPC.AGENT_ARCHIVE, { id }),

  /** Agent routines (scheduled tasks). */
  getRoutines: (): Promise<Routine[]> => ipcRenderer.invoke(IPC.ROUTINE_LIST),
  upsertRoutine: (routine: Omit<Routine, 'id'> | Routine): void =>
    ipcRenderer.send(IPC.ROUTINE_UPSERT, routine),
  deleteRoutine: (id: string): void => ipcRenderer.send(IPC.ROUTINE_DELETE, { id }),
  setRoutinesMuted: (muted: boolean): void =>
    ipcRenderer.send(IPC.SET_ROUTINES_MUTED, muted),

  /** Agent file artifacts. */
  getArtifacts: (agentId?: string): Promise<Artifact[]> =>
    ipcRenderer.invoke(IPC.ARTIFACT_LIST, agentId),
  openArtifact: (id: string): void => ipcRenderer.send(IPC.ARTIFACT_OPEN, { id }),
  revealArtifact: (id: string): void => ipcRenderer.send(IPC.ARTIFACT_REVEAL, { id }),

  /** Suggestion cards. */
  getSuggestions: (agentId?: string): Promise<Suggestion[]> =>
    ipcRenderer.invoke(IPC.SUGGESTION_LIST, agentId),
  acceptSuggestion: (id: string): void => ipcRenderer.send(IPC.SUGGESTION_ACCEPT, { id }),
  dismissSuggestion: (id: string): void => ipcRenderer.send(IPC.SUGGESTION_DISMISS, { id }),
  refreshSuggestions: (): void => ipcRenderer.send(IPC.SUGGESTION_REFRESH),

  markChatRead: (agentId: string): void => ipcRenderer.send(IPC.CHAT_MARK_READ, agentId),

  /** Send a typed message to an agent (panel chat input, card follow-ups). */
  sendTextTurn: (agentId: string, text: string): void =>
    ipcRenderer.send(IPC.TEXT_TURN, { agentId, text }),

  /** Model ids exposed by the configured OpenAI-compatible endpoint. */
  listRemoteModels: (): Promise<string[]> => ipcRenderer.invoke(IPC.LIST_REMOTE_MODELS),

  /** Open an agent's workspace folder in Explorer. */
  openAgentWorkspace: (agentId: string): void =>
    ipcRenderer.send(IPC.OPEN_AGENT_WORKSPACE, { agentId }),

  /** Main → overlay: speak text via the OS voice (fallback when the TTS
   * provider fails or has no key). */
  onSpeakText: (cb: (text: string, rate: number) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, text: string, rate: number) => cb(text, rate);
    ipcRenderer.on(IPC.SPEAK_TEXT, handler);
    return () => ipcRenderer.removeListener(IPC.SPEAK_TEXT, handler);
  },

  /** Main → overlay: play a named UI sound. */
  onPlaySfx: (cb: (name: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, name: string) => cb(name);
    ipcRenderer.on(IPC.PLAY_SFX, handler);
    return () => ipcRenderer.removeListener(IPC.PLAY_SFX, handler);
  },

  setFishTtsModel: (model: FishTtsModel): void =>
    ipcRenderer.send(IPC.SET_FISH_TTS_MODEL, model),

  toggleCursor: (enabled: boolean): void => ipcRenderer.send(IPC.TOGGLE_CURSOR, enabled),
  setLaunchAtLogin: (enabled: boolean): void => ipcRenderer.send(IPC.SET_LAUNCH_AT_LOGIN, enabled),
  setStreamVisibility: (v: StreamVisibility): void =>
    ipcRenderer.send(IPC.SET_STREAM_VISIBILITY, v),
  setStreamWindowBounds: (b: StreamWindowBounds): void =>
    ipcRenderer.send(IPC.SET_STREAM_WINDOW_BOUNDS, b),
  setPushToTalkShortcut: (accel: string): void => ipcRenderer.send(IPC.SET_PUSH_TO_TALK_SHORTCUT, accel),
  setPttMode: (mode: PttMode): void => ipcRenderer.send(IPC.SET_PTT_MODE, mode),
  setAutoTypeEnabled: (enabled: boolean): void => ipcRenderer.send(IPC.SET_AUTO_TYPE_ENABLED, enabled),
  suspendPushToTalkShortcut: (): void => ipcRenderer.send(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT),
  resumePushToTalkShortcut: (): void => ipcRenderer.send(IPC.RESUME_PUSH_TO_TALK_SHORTCUT),

  playVoicePreview: (voiceId: string): void => ipcRenderer.send(IPC.PLAY_VOICE_PREVIEW, voiceId),

  // ── Permissions ────────────────────────────────────────────────────
  getPermissions: (): Promise<PermissionStatus> => ipcRenderer.invoke(IPC.GET_PERMISSIONS),
  requestPermission: (kind: string): void => ipcRenderer.send(IPC.REQUEST_PERMISSION, kind),

  // ── API Keys ───────────────────────────────────────────────────────
  setApiKey: (name: ApiKeyName, value: string): void => ipcRenderer.send(IPC.SET_API_KEY, name, value),
  deleteApiKey: (name: ApiKeyName): void => ipcRenderer.send(IPC.DELETE_API_KEY, name),
  getApiKeyStatus: (): Promise<Record<ApiKeyName, boolean>> =>
    ipcRenderer.invoke(IPC.GET_API_KEY_STATUS),
  validateApiKey: (name: ApiKeyName, value: string): Promise<ApiKeyValidation> =>
    ipcRenderer.invoke(IPC.VALIDATE_API_KEY, name, value),
  validateStoredApiKey: (name: ApiKeyName): Promise<ApiKeyValidation> =>
    ipcRenderer.invoke(IPC.VALIDATE_STORED_API_KEY, name),

  // ── Setup verification ─────────────────────────────────────────────
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.GET_APP_VERSION),
  startPttTest: (): void => ipcRenderer.send(IPC.PTT_TEST_START),
  stopPttTest: (): void => ipcRenderer.send(IPC.PTT_TEST_STOP),
  startMicTest: (): void => ipcRenderer.send(IPC.MIC_TEST_START),
  stopMicTest: (): void => ipcRenderer.send(IPC.MIC_TEST_STOP),
  /** Overlay → main: current input level (0..1). */
  reportMicLevel: (level: number): void => ipcRenderer.send(IPC.MIC_LEVEL, level),
  /** Overlay → main: getUserMedia / AudioContext failure. */
  reportMicError: (message: string): void => ipcRenderer.send(IPC.MIC_ERROR, message),
  onPttShortcutFired: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(IPC.PTT_SHORTCUT_FIRED, handler);
    return () => ipcRenderer.removeListener(IPC.PTT_SHORTCUT_FIRED, handler);
  },
  onMicLevel: (cb: (level: number) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, level: number) => cb(level);
    ipcRenderer.on(IPC.MIC_LEVEL, handler);
    return () => ipcRenderer.removeListener(IPC.MIC_LEVEL, handler);
  },
  onMicError: (cb: (message: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IPC.MIC_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.MIC_ERROR, handler);
  },
  onAiError: (cb: (message: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IPC.AI_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.AI_ERROR, handler);
  },

  // ── Memory / context ───────────────────────────────────────────────
  getMemoryStats: (): Promise<MemoryStats> => ipcRenderer.invoke(IPC.GET_MEMORY_STATS),
  compactContext: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.COMPACT_CONTEXT),
  clearContext: (): void => ipcRenderer.send(IPC.CLEAR_CONTEXT),

  // ── Chat history ────────────────────────────────────────────────────
  getChatHistory: (agentId?: string): Promise<ChatEntry[]> =>
    ipcRenderer.invoke(IPC.GET_CHAT_HISTORY, agentId),
  clearChatHistory: (agentId?: string): void =>
    ipcRenderer.send(IPC.CLEAR_CHAT_HISTORY, agentId),

  // ── Usage metering ─────────────────────────────────────────────────
  getUsageStats: (): Promise<UsageStats> => ipcRenderer.invoke(IPC.GET_USAGE_STATS),

  // ── Local Connections ─────────────────────────────────────────────────
  getLocalConnections: (): Promise<LocalConnection[]> =>
    ipcRenderer.invoke(IPC.GET_LOCAL_CONNECTIONS),
  addLocalConnection: (conn: Omit<LocalConnection, 'id'>): Promise<LocalConnection> =>
    ipcRenderer.invoke(IPC.ADD_LOCAL_CONNECTION, conn),
  updateLocalConnection: (id: string, patch: Partial<LocalConnection>): Promise<void> =>
    ipcRenderer.invoke(IPC.UPDATE_LOCAL_CONNECTION, id, patch),
  deleteLocalConnection: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DELETE_LOCAL_CONNECTION, id),
  testLocalConnection: (url: string, bearerToken?: string): Promise<OllamaTestResult> =>
    ipcRenderer.invoke(IPC.TEST_LOCAL_CONNECTION, url, bearerToken),
  getOllamaModels: (url: string, bearerToken?: string): Promise<OllamaModelInfo[]> =>
    ipcRenderer.invoke(IPC.GET_OLLAMA_MODELS, url, bearerToken),
  setLocalConnectionKey: (id: string, token: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SET_LOCAL_CONNECTION_KEY, id, token),
  deleteLocalConnectionKey: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DELETE_LOCAL_CONNECTION_KEY, id),

  // ── Ollama Model Management ───────────────────────────────────────────
  pullOllamaModel: (url: string, modelTag: string, bearerToken?: string): void =>
    ipcRenderer.send(IPC.PULL_OLLAMA_MODEL, url, modelTag, bearerToken),
  onOllamaPullProgress: (cb: (p: OllamaPullProgress) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: OllamaPullProgress) => cb(p);
    ipcRenderer.on(IPC.OLLAMA_PULL_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.OLLAMA_PULL_PROGRESS, handler);
  },
  onOllamaPullComplete: (cb: (info: { model: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { model: string }) => cb(info);
    ipcRenderer.on(IPC.OLLAMA_PULL_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.OLLAMA_PULL_COMPLETE, handler);
  },
  onOllamaPullError: (cb: (info: { error: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { error: string }) => cb(info);
    ipcRenderer.on(IPC.OLLAMA_PULL_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.OLLAMA_PULL_ERROR, handler);
  },
  deleteOllamaModel: (url: string, modelName: string, bearerToken?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DELETE_OLLAMA_MODEL, url, modelName, bearerToken),
  createOllamaModel: (url: string, modelTag: string, modelfileJson: string, bearerToken?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.CREATE_OLLAMA_MODEL, url, modelTag, modelfileJson, bearerToken),

  // ── Lifecycle ──────────────────────────────────────────────────────
  openExternal: (url: string): void => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
  quit: (): void => ipcRenderer.send(IPC.QUIT_APP),
  replayOnboarding: (): void => ipcRenderer.send(IPC.REPLAY_ONBOARDING),
  completeOnboarding: (): void => ipcRenderer.send(IPC.COMPLETE_ONBOARDING),

  // ── Event listeners (Main → Renderer) ──────────────────────────────
  onVoiceStateChanged: (cb: (state: VoiceState) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: VoiceState) => cb(state);
    ipcRenderer.on(IPC.VOICE_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.VOICE_STATE_CHANGED, handler);
  },

  onTranscriptUpdate: (cb: (result: TranscriptionResult) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, result: TranscriptionResult) => cb(result);
    ipcRenderer.on(IPC.TRANSCRIPT_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC.TRANSCRIPT_UPDATE, handler);
  },

  onAiResponseChunk: (cb: (chunk: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, chunk: string) => cb(chunk);
    ipcRenderer.on(IPC.AI_RESPONSE_CHUNK, handler);
    return () => ipcRenderer.removeListener(IPC.AI_RESPONSE_CHUNK, handler);
  },

  onAiResponseComplete: (cb: (fullText: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, text: string) => cb(text);
    ipcRenderer.on(IPC.AI_RESPONSE_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.AI_RESPONSE_COMPLETE, handler);
  },

  // ── Scenes (draw cues + point cues) ────────────────────────────────
  /** Full scene: { cues } on arrival, null when cleared. */
  onScene: (cb: (scene: Scene | null) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: Scene | null) => cb(s);
    ipcRenderer.on(IPC.SCENE, handler);
    return () => ipcRenderer.removeListener(IPC.SCENE, handler);
  },

  /** Beat index inside the active scene, or null when it ends. */
  onSceneCue: (cb: (index: number | null) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, i: number | null) => cb(i);
    ipcRenderer.on(IPC.SCENE_CUE, handler);
    return () => ipcRenderer.removeListener(IPC.SCENE_CUE, handler);
  },

  // ── Agent mode ─────────────────────────────────────────────────────
  onAgentStatus: (cb: (status: AgentStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: AgentStatus) => cb(s);
    ipcRenderer.on(IPC.AGENT_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.AGENT_STATUS, handler);
  },

  /**
   * One executed agent action for visual echo.
   * Payload: { x, y, label, kind } — display-space point + caption.
   */
  onAgentAction: (
    cb: (a: {
      x: number;
      y: number;
      label: string;
      kind: AgentAction['kind'];
      agentId?: string;
    }) => void,
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      a: { x: number; y: number; label: string; kind: AgentAction['kind']; agentId?: string },
    ) => cb(a);
    ipcRenderer.on(IPC.AGENT_ACTION, handler);
    return () => ipcRenderer.removeListener(IPC.AGENT_ACTION, handler);
  },

  onTypeFulfilled: (cb: (req: TypeRequest) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, req: TypeRequest) => cb(req);
    ipcRenderer.on(IPC.TYPE_FULFILLED, handler);
    return () => ipcRenderer.removeListener(IPC.TYPE_FULFILLED, handler);
  },

  /**
   * Cursor position from main. Main additionally sends `{ off: true }`
   * pulses (with sentinel coords) to the overlay that just lost the cursor
   * on multi-display setups — the optional flag is part of the contract so
   * consumers don't need a cast to read it.
   */
  onCursorPosition: (cb: (pos: { x: number; y: number; off?: boolean }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, pos: { x: number; y: number; off?: boolean }) => cb(pos);
    ipcRenderer.on(IPC.CURSOR_POSITION, handler);
    return () => ipcRenderer.removeListener(IPC.CURSOR_POSITION, handler);
  },

  onSettingsChanged: (cb: (settings: FlickySettings) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, settings: FlickySettings) => cb(settings);
    ipcRenderer.on(IPC.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler);
  },

  onPermissionStatus: (cb: (perms: PermissionStatus) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, perms: PermissionStatus) => cb(perms);
    ipcRenderer.on(IPC.PERMISSION_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.PERMISSION_STATUS, handler);
  },

  onMemoryStats: (cb: (stats: MemoryStats) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, stats: MemoryStats) => cb(stats);
    ipcRenderer.on(IPC.MEMORY_STATS, handler);
    return () => ipcRenderer.removeListener(IPC.MEMORY_STATS, handler);
  },

  onChatEntryAdded: (cb: (entry: ChatEntry) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, entry: ChatEntry) => cb(entry);
    ipcRenderer.on(IPC.CHAT_ENTRY_ADDED, handler);
    return () => ipcRenderer.removeListener(IPC.CHAT_ENTRY_ADDED, handler);
  },

  // ── Audio Capture (overlay ↔ main) ──────────────────────────────────
  // ── Overlay / display info ────────────────────────────────────────
  /**
   * The overlay's display, available synchronously on first paint.
   * Null in windows that aren't overlays.
   */
  getDisplayInfo: (): DisplayInfo | null => initialDisplayInfo,

  onDisplayInfo: (cb: (info: DisplayInfo) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: DisplayInfo) => cb(info);
    ipcRenderer.on('display-info', handler);
    return () => ipcRenderer.removeListener('display-info', handler);
  },

  /**
   * Main → overlay: open the mic gate. Payload carries the capture mode:
   * 'ptt' streams chunks to main live; 'vad' runs the overlay-side VAD
   * and ships each finished utterance via sendVadUtterance.
   */
  onStartCapture: (cb: (payload: { mode: CaptureMode }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { mode: CaptureMode }) =>
      cb(payload ?? { mode: 'ptt' });
    ipcRenderer.on('start-audio-capture', handler);
    return () => ipcRenderer.removeListener('start-audio-capture', handler);
  },

  onStopCapture: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('stop-audio-capture', handler);
    return () => ipcRenderer.removeListener('stop-audio-capture', handler);
  },

  sendAudioChunk: (buffer: ArrayBuffer): void => {
    ipcRenderer.send('audio-chunk', Buffer.from(buffer));
  },

  /** Overlay → main: one finished VAD utterance (PCM16 mono 16 kHz). */
  sendVadUtterance: (buffer: ArrayBuffer): void => {
    ipcRenderer.send(IPC.VAD_UTTERANCE, Buffer.from(buffer));
  },

  onPlayAudio: (cb: (audioData: ArrayBuffer) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: Buffer) => {
      const copy = new ArrayBuffer(data.byteLength);
      new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      cb(copy);
    };
    ipcRenderer.on('play-audio', handler);
    return () => ipcRenderer.removeListener('play-audio', handler);
  },
  /** Main → overlay: stop any in-flight TTS playback immediately. */
  onStopAudio: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('stop-audio', handler);
    return () => ipcRenderer.removeListener('stop-audio', handler);
  },
};

export type FlickyAPI = typeof api;

contextBridge.exposeInMainWorld('flicky', api);
