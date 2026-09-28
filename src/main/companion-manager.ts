import { app, systemPreferences, shell, desktopCapturer, clipboard, screen } from 'electron';
import { ClaudeAPI } from './services/claude-api';
import { OpenAIAPI } from './services/openai-api';
import { OllamaAPI } from './services/ollama-api';
import { ElevenLabsTTS } from './services/elevenlabs-tts';
import { FishAudioTTS } from './services/fish-audio-tts';
import {
  createTranscriptionProvider,
  transcribeWith,
  type TranscriptionProvider,
} from './services/transcription';
import { captureAllDisplays } from './services/screen-capture';
import {
  parseTypeTags,
  parseScene,
  parseFileTags,
  parseMemos,
  stripFileBlocks,
  extractAgentTask,
  TAG_STRIP_REGEX,
} from './services/element-detector';
import {
  AgentOrchestrator,
  LocalTurnControl,
  type AgentRuntimeDeps,
} from './services/agent-orchestrator';
import { RoutineScheduler } from './services/routines';
import { typeText, isAccessibilityGranted, promptAccessibility } from './services/auto-typer';
import { ContextManager } from './services/context-manager';
import * as settingsStore from './services/settings-store';
import * as keyStore from './services/key-store';
import * as chatHistory from './services/chat-history-store';
import * as artifactStore from './services/artifact-store';
import * as agentWorkspace from './services/agent-workspace';
import * as suggestionStore from './services/suggestion-store';
import { generateSuggestions } from './services/suggestion-engine';
import * as usageStore from './services/usage-store';
import * as analytics from './services/analytics';
import type {
  VoiceState,
  FlickySettings,
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  TranscriptionResult,
  Scene,
  SceneCue,
  AgentAction,
  AgentStatus,
  Routine,
  CaptureMode,
  TtsProvider,
  ConversationTurn,
  PttMode,
  TypeRequest,
  ScreenCapture,
  ApiKeyName,
  ReasoningDepth,
  ReplyTone,
  MemoryStats,
  ChatEntry,
  StreamVisibility,
  StreamWindowBounds,
  PermissionStatus,
} from '../shared/types';

export interface CompanionCallbacks {
  onVoiceStateChanged: (state: VoiceState) => void;
  onTranscriptUpdate: (result: TranscriptionResult) => void;
  onAiResponseChunk: (chunk: string) => void;
  onAiResponseComplete: (fullText: string) => void;
  /**
   * A turn failed somewhere in mic → transcription → model → TTS.
   * Previously these only went to the console, which on a packaged
   * Windows build means nobody ever saw them — the app just went
   * quiet. Surfaced to the panel / stream so the user learns *why*.
   */
  onError: (message: string) => void;
  /**
   * The full cue list for a scene that just started, or null when it
   * ends. Emitted once per scene; per-beat timing rides onSceneCue.
   * Replaces the old walkthrough pair.
   */
  onScene: (scene: Scene | null) => void;
  /** Active beat index inside the current scene, or null when idle. */
  onSceneCue: (index: number | null) => void;
  /** Agent-mode lifecycle for status UI ({ phase, step, maxSteps, message? }). */
  onAgentStatus: (status: AgentStatus) => void;
  /** One executed agent action — the overlay echoes it as a click ripple. */
  onAgentAction: (action: { x: number; y: number; label: string; kind: AgentAction['kind'] }) => void;
  onTypeFulfilled: (request: TypeRequest) => void;
  onSettingsChanged: (settings: FlickySettings) => void;
  onMemoryStatsChanged: (stats: MemoryStats) => void;
  onChatEntryAdded: (entry: ChatEntry) => void;
  /**
   * Open the overlay's mic gate. 'ptt' streams every PCM chunk to main
   * for a push-to-talk turn; 'vad' runs the overlay-side VAD that ships
   * each finished utterance back as a VAD_UTTERANCE (always-on mode).
   */
  onStartAudioCapture: (mode: CaptureMode) => void;
  onStopAudioCapture: () => void;
  onPlayAudio: (audioBuffer: Buffer) => void;
  /**
   * Cut whatever the overlay is currently speaking. Optional so partial
   * callback sets (tests, headless) keep working; main broadcasts it to
   * every overlay because any single one may hold the playing buffer.
   */
  onStopAudio?: () => void;
  onCursorVisibilityChanged: (enabled: boolean) => void;
  onStreamVisibilityChanged: (v: StreamVisibility) => void;
  /**
   * A VAD utterance cleared the wake gate and is becoming a turn —
   * main hooks it to the 'heard' UI sound so hands-free users get an
   * audible acknowledgment that Zapi picked up what they said.
   */
  onVadAccepted?: () => void;
}

/**
 * Every status/chat/usage record the voice pipeline produces belongs to
 * the default agent. Phase B's AgentOrchestrator replaces this literal
 * with the runtime's own id — until then there is exactly one runtime, so
 * routing it through a named constant keeps the change to one place.
 */
const AGENT_ID_MAIN = 'main';

/** Escape a user-supplied agent name for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Structural union of the three Mind providers' callback shapes. */
interface MindCallbacks {
  onChunk: (text: string) => void;
  onComplete: (fullText: string, usage?: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: Error) => void;
}

export class CompanionManager {
  private callbacks: CompanionCallbacks;
  /**
   * Per-agent run registry (Phase B). The 'main' runtime's turn/abort/voice
   * primitives are bound to this instance's own fields, so an agent run for
   * 'main' interrupts and aborts exactly as it did before the extraction.
   */
  private orchestrator: AgentOrchestrator;
  /**
   * Scheduled agent routines (Phase D). Owned here rather than in main
   * because a firing routine is a turn: it needs the transcript→model
   * pipeline, the agent runtimes, and the announcement surfaces, all of
   * which live on this instance.
   */
  private routines: RoutineScheduler;

  private claude: ClaudeAPI;
  private openai: OpenAIAPI;
  private ollama: OllamaAPI;
  private tts: ElevenLabsTTS;
  private fishTts: FishAudioTTS;
  private context: ContextManager;
  private transcriptionProvider: TranscriptionProvider | null = null;

  private voiceState: VoiceState = 'idle';
  private lastScreenshots: ScreenCapture[] = [];
  private isRecording = false;

  /** Public read-only view used by main's PTT handler to keep its
   *  toggle state in sync after a failed start. */
  get recording(): boolean {
    return this.isRecording;
  }
  private reRegisterShortcut: ((accel: string) => boolean) | null = null;
  /**
   * One-shot override set by the push-to-dictate hotkey: the turn recorded
   * under that hotkey is forced through the dictation path in
   * processUserText regardless of the sticky `dictationEnabled` setting.
   * Consumed (cleared) the moment a turn reads it, so it can never leak
   * into a later turn.
   */
  private forcedDictation = false;
  /**
   * Push-to-dictate accelerator. Mirrors `pushToTalkShortcut`: hydrated
   * from settings-store at construction, persisted on change, re-registered
   * with the OS via `reRegisterDictationShortcut`.
   */
  private dictationShortcut: string;
  private reRegisterDictationShortcut: ((accel: string) => boolean) | null = null;
  /**
   * Monotonic turn counter. A new PTT press (or VAD utterance) bumps
   * this; any still-running LLM callbacks from the previous turn check
   * if their captured id still matches before they're allowed to mutate
   * shared state.
   */
  private turnId = 0;
  private currentAbort: AbortController | null = null;
  /** Pending scene beat timers, cleared on new turn or end-of-scene. */
  private sceneTimers: ReturnType<typeof setTimeout>[] = [];
  /**
   * speakReplies with no key for the chosen provider fails silently by
   * design — warn once per provider per session so the log explains it.
   */
  private ttsMissingKeyWarned = new Set<TtsProvider>();
  /**
   * If startRecording is in flight, other callers (typically a quick-release
   * stopPushToTalk) await this before deciding whether to stop. Without it,
   * stop can fire before `isRecording` has been flipped true, bail, and
   * leave the mic running forever.
   */
  private pendingStart: Promise<void> | null = null;
  /**
   * Setup's mic check runs capture without a transcription provider.
   * While true, audio chunks are dropped here; the overlay still emits
   * level events that the panel visualises.
   */
  private micTestActive = false;

  constructor(callbacks: CompanionCallbacks) {
    this.callbacks = callbacks;
    this.claude = new ClaudeAPI();
    this.openai = new OpenAIAPI();
    this.ollama = new OllamaAPI();
    this.tts = new ElevenLabsTTS();
    this.fishTts = new FishAudioTTS();
    this.context = new ContextManager();

    this.dictationShortcut = settingsStore.get('dictationShortcut');
    this.orchestrator = new AgentOrchestrator((agentId) => this.buildAgentDeps(agentId));
    this.routines = new RoutineScheduler({
      listRoutines: () => settingsStore.listRoutines(),
      onFire: (routine) => { void this.runRoutineTask(routine); },
      markRun: (id, ts) => settingsStore.markRoutineRun(id, ts),
    });
    // Ticking is cheap and idempotent, and an interval routine that has
    // never run is due immediately — so a user who just added "check
    // downloads every 30m" gets it on the next tick, not in 30 minutes.
    this.routines.start();

    analytics.initAnalytics('', 'https://us.i.posthog.com');
    analytics.trackAppOpened();
  }

  /**
   * Collaborators handed to each agent runtime.
   *
   * 'main' shares this instance's turn id, abort controller, and mic-side
   * voice state, which is what keeps its run interruptible by PTT, a new
   * VAD turn, and the mic-error reset. Any other agent gets private turn
   * state and no voice control at all — a background agent must never
   * flip the microphone's state or speak over the user.
   */
  private buildAgentDeps(agentId: string): AgentRuntimeDeps {
    const isMain = agentId === AGENT_ID_MAIN;
    const turn = isMain
      ? {
          beginTurn: (): number => {
            this.turnId += 1;
            return this.turnId;
          },
          currentTurnId: (): number => this.turnId,
          setAbort: (ctl: AbortController | null): void => {
            this.currentAbort = ctl;
          },
          currentAbort: (): AbortController | null => this.currentAbort,
          setVoiceState: (state: VoiceState): void => this.setVoiceState(state),
          voiceState: (): VoiceState => this.voiceState,
        }
      : new LocalTurnControl();

    return {
      turn,
      ownsVoice: isMain,
      streamMind: (prompt, screenshots, history, mode, signal, callbacks) => {
        if (mode !== 'agent') {
          return this.streamMind(prompt, screenshots, history, mode, signal, callbacks);
        }
        // Agent memory: the agent's AGENTS.md rides in front of every
        // step's prompt, so a fact the model memo'd on step N is already
        // visible on step N+1. An empty read skips the section entirely —
        // never send a bare heading.
        const memory = agentWorkspace.readMemory(agentId).trim();
        const agentPrompt = memory ? `Agent memory:\n${memory}\n\n${prompt}` : prompt;
        return this.streamMind(agentPrompt, screenshots, history, mode, signal, {
          ...callbacks,
          // [MEMO:...] tags in the reply become dated notes in AGENTS.md.
          // parseMemos strips FILE blocks first — a memo inside a file the
          // model just produced is data, not an instruction, and must not
          // be planted. appendMemo returns false on failure; a rejected
          // write must never break the run.
          onComplete: (text, usage) => {
            const memos = parseMemos(text);
            if (memos.length > 0) {
              const profile = settingsStore.listAgents().find((a) => a.id === agentId);
              for (const fact of memos) {
                agentWorkspace.appendMemo(agentId, fact, profile);
              }
            }
            callbacks.onComplete(text, usage);
          },
        });
      },
      recordExchange: (userText, assistantText) => this.context.recordExchange(userText, assistantText),
      emitMemoryStats: () => this.emitMemoryStats(),
      synthesizeSpeech: (text) => this.synthesizeSpeech(text),
      playSpeech: (buffer) => this.playSpeech(buffer),
      onStatus: (status) => {
        this.callbacks.onAgentStatus(status);
        // Background agents get no spoken reply of their own, so their
        // completion is announced from here.
        this.maybeAnnounceAgentDone(status);
      },
      onAction: (action) => this.callbacks.onAgentAction(action),
      onChatEntryAdded: (entry) => this.callbacks.onChatEntryAdded(entry),
      onAiResponseChunk: (chunk) => this.callbacks.onAiResponseChunk(chunk),
      onAiResponseComplete: (fullText) => this.callbacks.onAiResponseComplete(fullText),
      clearSceneTimers: () => this.clearSceneTimers(),
      onSceneClear: () => {
        this.callbacks.onScene(null);
        this.callbacks.onSceneCue(null);
      },
    };
  }

  // ── Settings ─────────────────────────────────────────────────────────

  getSettings(): FlickySettings {
    const stored = settingsStore.getAll();
    return {
      ...stored,
      apiKeyStatus: keyStore.getKeyStatus(),
      encryptionAvailable: keyStore.isEncryptionAvailable(),
    };
  }

  setModel(model: ClaudeModel): void {
    settingsStore.set('selectedModel', model);
    this.emitSettings();
  }

  setOpenAIModel(model: OpenAIModel): void {
    settingsStore.set('selectedOpenAIModel', model);
    this.emitSettings();
  }

  setMindProvider(provider: MindProvider): void {
    settingsStore.set('mindProvider', provider);
    this.emitSettings();
  }

  setReasoningDepth(depth: ReasoningDepth): void {
    settingsStore.set('reasoningDepth', depth);
    this.emitSettings();
  }

  setReplyTone(tone: ReplyTone): void {
    settingsStore.set('replyTone', tone);
    this.emitSettings();
  }

  setVoiceId(id: string): void {
    settingsStore.set('voiceId', id);
    this.emitSettings();
  }

  setTtsProvider(provider: TtsProvider): void {
    settingsStore.set('ttsProvider', provider);
    this.emitSettings();
  }

  setFishVoiceId(id: string): void {
    settingsStore.set('fishVoiceId', id);
    this.emitSettings();
  }

  setVoiceSpeed(speed: number): void {
    settingsStore.set('voiceSpeed', speed);
    this.emitSettings();
  }

  setVoiceStability(stability: number): void {
    settingsStore.set('voiceStability', stability);
    this.emitSettings();
  }

  setSpeakReplies(enabled: boolean): void {
    settingsStore.set('speakReplies', enabled);
    this.emitSettings();
  }

  setGroqModel(model: GroqTranscriptionModel): void {
    settingsStore.set('groqTranscriptionModel', model);
    this.emitSettings();
  }

  toggleCursor(enabled: boolean): void {
    settingsStore.set('isClickyCursorEnabled', enabled);
    this.callbacks.onCursorVisibilityChanged(enabled);
    this.emitSettings();
  }

  setStreamVisibility(v: StreamVisibility): void {
    settingsStore.set('streamVisibility', v);
    this.callbacks.onStreamVisibilityChanged(v);
    this.emitSettings();
  }

  setStreamWindowBounds(b: StreamWindowBounds): void {
    settingsStore.set('streamWindowBounds', b);
    this.emitSettings();
  }

  // ── Modes ────────────────────────────────────────────────────────────

  setAlwaysOn(enabled: boolean): void {
    settingsStore.set('alwaysOnEnabled', enabled);
    // Apply the mic side immediately, but never yank capture out from
    // under an active PTT recording — the post-turn resume in
    // stopRecordingAndProcess restarts VAD once the turn finishes.
    if (!this.isRecording) {
      if (enabled) this.callbacks.onStartAudioCapture('vad');
      else this.callbacks.onStopAudioCapture();
    }
    this.emitSettings();
  }

  setDictation(enabled: boolean): void {
    settingsStore.set('dictationEnabled', enabled);
    this.emitSettings();
  }

  setAgentEnabled(enabled: boolean): void {
    settingsStore.set('agentEnabled', enabled);
    // Flipping the switch off mid-run should actually stop the driver —
    // not leave it moving the mouse in a mode the UI says is off.
    if (!enabled) this.stopAgent();
    this.emitSettings();
  }

  setAgentMaxSteps(n: number): void {
    // Floor at 1: zero would make the agent loop exit without a single
    // iteration, which reads as "agent mode is broken".
    settingsStore.set('agentMaxSteps', Math.max(1, Math.round(n)));
    this.emitSettings();
  }

  setRoutinesMuted(muted: boolean): void {
    // Mute silences routine announcements only — never a run, so the
    // scheduler's next evaluation doesn't depend on this value.
    settingsStore.setRoutinesMuted(muted);
    this.emitSettings();
  }

  setCustomOpenAIModel(model: string): void {
    settingsStore.set('customOpenAIModel', model);
    this.emitSettings();
  }

  setOpenAIBaseUrl(v: string): void {
    settingsStore.set('openAIBaseUrl', v.trim());
    this.emitSettings();
  }

  /**
   * Stop a running agent loop. Aborts the in-flight stream/act batch;
   * the loop notices between iterations and releases 'acting' itself.
   * The idle broadcast clears the status line immediately rather than
   * waiting for the loop to unwind.
   */
  stopAgent(agentId?: string): void {
    // A named agentId stops just that agent's run; a bare stop (tray menu,
    // stream button, "zapi stop") has no id and stops everything running.
    this.orchestrator.stop(agentId);
    // "zapi stop" must actually stop the talking too, not just the loop.
    this.stopSpeech();
    // The idle broadcast clears the foreground status line immediately
    // rather than waiting for the loop to unwind. Scoped to 'main' when a
    // specific agent was named, so stopping a background agent doesn't
    // also blank the mic-owning agent's card.
    this.callbacks.onAgentStatus({
      agentId: agentId ?? AGENT_ID_MAIN,
      phase: 'idle',
      step: 0,
      maxSteps: 0,
    });
  }

  /**
   * Hard reset after the overlay reports the mic is gone (getUserMedia /
   * AudioContext failure in the capture renderer). Without this, a turn
   * that started on a now-dead mic stays stuck: 'listening' with no audio
   * ever arriving, an agent run that keeps screenshotting forever, or a
   * live mic gate the OS will never release.
   *
   * Unwinds state the same way a new turn does — bump turnId, abort the
   * in-flight controller, drop the transcription provider, clear scene
   * timers, release capture, back to 'idle' — so every in-flight
   * isCurrent() gate stops mutating UI from the dead turn.
   *
   * No error is emitted here on purpose: main's IPC.MIC_ERROR handler
   * already forwards `microphone unavailable — …` to the panel, and
   * emitting again would double it. Safe no-op when already idle.
   */
  resetFromMicError(): void {
    const wasBusy = this.isRecording || this.voiceState !== 'idle' || this.pendingStart !== null;
    if (!wasBusy) return;

    console.warn('[Zapi] mic error while busy — resetting in-flight turn');
    // Abort first so a pending provider call stops before we clear state.
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.turnId += 1;

    // Drop the provider without a stop() round-trip: it would try to
    // transcribe an empty buffer over a broken mic.
    this.transcriptionProvider = null;
    this.pendingStart = null;
    this.isRecording = false;
    this.forcedDictation = false;
    this.micTestActive = false;

    this.clearSceneTimers();
    this.callbacks.onScene(null);
    this.callbacks.onSceneCue(null);
    this.callbacks.onAgentStatus({ agentId: AGENT_ID_MAIN, phase: 'idle', step: 0, maxSteps: 0 });
    // Tells the overlay to close its (already broken) mic gate.
    this.callbacks.onStopAudioCapture();
    this.stopSpeech();
    this.setVoiceState('idle');
  }

  setShortcutReRegister(fn: (accel: string) => boolean): void {
    this.reRegisterShortcut = fn;
  }

  setPushToTalkShortcut(accelerator: string): void {
    const previous = settingsStore.get('pushToTalkShortcut');
    if (!this.reRegisterShortcut) {
      settingsStore.set('pushToTalkShortcut', accelerator);
      this.emitSettings();
      return;
    }
    const ok = this.reRegisterShortcut(accelerator);
    if (ok) {
      settingsStore.set('pushToTalkShortcut', accelerator);
    } else {
      console.warn('[Zapi] Failed to register shortcut', accelerator, '— reverting to', previous);
      this.reRegisterShortcut(previous);
    }
    this.emitSettings();
  }

  setDictationShortcutReRegister(fn: (accel: string) => boolean): void {
    this.reRegisterDictationShortcut = fn;
  }

  getDictationShortcut(): string {
    return this.dictationShortcut;
  }

  setDictationShortcut(accelerator: string): void {
    const previous = this.dictationShortcut;
    if (!this.reRegisterDictationShortcut) {
      this.dictationShortcut = accelerator;
      this.persistDictationShortcut(accelerator);
      this.emitSettings();
      return;
    }
    const ok = this.reRegisterDictationShortcut(accelerator);
    if (ok) {
      this.dictationShortcut = accelerator;
      this.persistDictationShortcut(accelerator);
    } else {
      console.warn('[Zapi] Failed to register dictation shortcut', accelerator, '— reverting to', previous);
      this.reRegisterDictationShortcut(previous);
    }
    this.emitSettings();
  }

  /**
   * Persist the shortcut like any other typed settings key. The companion
   * field mirrors it for synchronous reads between emissions.
   */
  private persistDictationShortcut(shortcut: string): void {
    settingsStore.set('dictationShortcut', shortcut);
  }

  setPttMode(mode: PttMode): void {
    settingsStore.set('pttMode', mode);
    this.emitSettings();
  }

  setAutoTypeEnabled(enabled: boolean): void {
    settingsStore.set('autoTypeEnabled', enabled);
    // Flipping the toggle on is the right moment to nudge the user
    // through the macOS Accessibility prompt — they just expressed
    // intent to grant. No-op on other platforms / when already trusted.
    if (enabled && !isAccessibilityGranted()) {
      promptAccessibility();
    }
    this.emitSettings();
  }

  setLaunchAtLogin(enabled: boolean): void {
    settingsStore.set('launchAtLogin', enabled);
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (err) {
      console.error('[Zapi] setLoginItemSettings failed:', err);
    }
    this.emitSettings();
  }

  completeOnboarding(): void {
    settingsStore.set('onboardingComplete', true);
    this.emitSettings();
  }

  replayOnboarding(): void {
    settingsStore.set('onboardingComplete', false);
    analytics.trackOnboardingReplayed();
    this.emitSettings();
  }

  // ── Context / Memory ─────────────────────────────────────────────────

  clearContext(): void {
    this.context.clear();
    this.emitMemoryStats();
  }

  async compactContext(): Promise<{ ok: boolean; error?: string }> {
    if (!this.context.canCompact()) {
      return { ok: false, error: 'Need at least two exchanges before compacting.' };
    }
    try {
      await this.context.compact(true);
      this.emitMemoryStats();
      return { ok: true };
    } catch (err) {
      this.emitMemoryStats();
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getMemoryStats(): MemoryStats {
    return this.context.getStats();
  }

  // ── Chat history ─────────────────────────────────────────────────────

  /** One agent's history. Omitting the id clears every agent's. */
  getChatHistory(agentId?: string): ChatEntry[] {
    return agentId === undefined ? chatHistory.getAll() : chatHistory.list(agentId);
  }

  clearChatHistory(agentId?: string): void {
    chatHistory.clear(agentId);
  }

  // ── Agent profiles ───────────────────────────────────────────────────

  /**
   * Broadcast the settings payload after an agent-profile change so the
   * panel's list, tray, and any agent-filtered views re-render. The
   * settings channel already carries `agents`, so there is no separate
   * agent-list event to fan out.
   */
  emitAgentsChanged(): void {
    this.emitSettings();
  }

  /** Surface a rejected agent mutation to the user instead of failing silently. */
  reportAgentError(message: string): void {
    console.error('[Zapi]', message);
    this.callbacks.onError(message);
  }

  // ── API Keys ─────────────────────────────────────────────────────────

  setApiKey(name: ApiKeyName, value: string): void {
    keyStore.setApiKey(name, value);
    this.emitSettings();
  }

  deleteApiKey(name: ApiKeyName): void {
    keyStore.deleteApiKey(name);
    this.emitSettings();
  }

  getApiKeyStatus(): Record<ApiKeyName, boolean> {
    return keyStore.getKeyStatus();
  }

  // ── TTS preview ──────────────────────────────────────────────────────

  async playVoicePreview(voiceId: string): Promise<void> {
    try {
      const line = "hi, i'm zapi. i'll be using this voice to talk with you.";
      const settings = settingsStore.getAll();
      // Provider switch is honored here too, so the "Preview" button in
      // the Voice tab tests the voice the user actually selected rather
      // than always auditioning an ElevenLabs voice. `speakReplies` is
      // deliberately NOT consulted — an explicit click should speak even
      // when replies are muted.
      const buf = settings.ttsProvider === 'fishaudio'
        ? await this.fishTts.synthesize(line, { voiceId })
        : await this.tts.synthesize(line, {
            voiceId,
            speed: settings.voiceSpeed,
            stability: settings.voiceStability,
          });
      this.playSpeech(buf);
    } catch (err) {
      // A missing/invalid key throws from the provider. Logging it alone
      // left the user clicking a dead Preview button with no explanation,
      // so surface it — the provider messages already name the panel.
      console.error('[Zapi] voice preview failed:', err);
      this.callbacks.onError(
        `voice preview failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Permissions ──────────────────────────────────────────────────────

  async getPermissions(): Promise<PermissionStatus> {
    const perms: PermissionStatus = {
      microphone: true,
      screen: true,
      accessibility: true,
      microphoneStatus: 'unknown',
    };
    if (process.platform === 'darwin') {
      const mic = systemPreferences.getMediaAccessStatus('microphone');
      perms.microphoneStatus = mic;
      perms.microphone = mic === 'granted';
      perms.screen = systemPreferences.getMediaAccessStatus('screen') === 'granted';
      perms.accessibility = isAccessibilityGranted();
    } else if (process.platform === 'win32') {
      // Windows 10/11 gate desktop-app microphone access under
      // Settings → Privacy → Microphone. When it's off, getUserMedia in
      // the overlay fails and Zapi silently hears nothing — the #1
      // "it doesn't work" report. Electron exposes the same status
      // query on Windows, so surface it.
      try {
        const mic = systemPreferences.getMediaAccessStatus('microphone');
        perms.microphoneStatus = mic;
        perms.microphone = mic === 'granted' || mic === 'not-determined';
      } catch (err) {
        console.error('[Zapi] mic status probe failed:', err);
      }
    }
    return perms;
  }

  /**
   * Open an OS settings deeplink without letting a rejection escape.
   * `shell.openExternal` returns a promise that rejects when nothing
   * handles the scheme (a stripped Windows image, a headless CI run, a
   * custom URL protocol not registered). Node's default unhandled-rejection
   * mode throws, so a dropped deeplink would take the whole app down from
   * a routine "Fix it" click in the permissions banner.
   */
  private openDeepLink(url: string): void {
    void shell.openExternal(url).catch((err: unknown) => {
      console.error('[Zapi] could not open deeplink', url, err);
    });
  }

  async requestPermission(kind: string): Promise<void> {
    if (process.platform === 'win32') {
      if (kind === 'microphone') {
        // Deeplink straight to the privacy pane; the toggles there are
        // "Microphone access" and "Let desktop apps access your microphone".
        this.openDeepLink('ms-settings:privacy-microphone');
      }
      return;
    }
    if (process.platform !== 'darwin') return;

    if (kind === 'microphone') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status === 'not-determined') {
        await systemPreferences.askForMediaAccess('microphone');
      } else if (status === 'denied' || status === 'restricted') {
        // The OS only shows the prompt once; after denial the user must
        // re-enable us in System Settings. Deeplink straight to the pane.
        this.openDeepLink(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        );
      }
      return;
    }

    if (kind === 'accessibility') {
      // Calling with `true` adds Zapi to the Accessibility list and
      // surfaces the OS dialog. The user still has to flip the checkbox
      // themselves; we deeplink to the right pane in case the dialog
      // got dismissed.
      promptAccessibility();
      this.openDeepLink(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      );
      return;
    }

    if (kind === 'screen') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'not-determined') {
        // No askForMediaAccess equivalent for screen — but actually
        // *attempting* a capture provokes the system prompt the first time.
        try {
          await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 },
          });
        } catch (err) {
          console.error('[Zapi] screen permission probe failed:', err);
        }
      } else if (status === 'denied' || status === 'restricted') {
        this.openDeepLink(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        );
      }
    }
  }

  // ── Push-to-Talk Pipeline ────────────────────────────────────────────

  async startPushToTalk(): Promise<void> {
    await this.startRecordingWithMode(false);
  }

  /**
   * Push-to-dictate entry: identical recording path to startPushToTalk,
   * but arms the one-shot `forcedDictation` flag so the resulting turn
   * takes the dictation branch even when the sticky mode is off.
   */
  async startDictationPushToTalk(): Promise<void> {
    await this.startRecordingWithMode(true);
  }

  private async startRecordingWithMode(forcedDictation: boolean): Promise<void> {
    if (this.isRecording || this.pendingStart) return;
    if (forcedDictation) this.forcedDictation = true;
    const p = this.startRecording();
    this.pendingStart = p;
    try {
      await p;
    } finally {
      if (this.pendingStart === p) this.pendingStart = null;
    }
  }

  async stopPushToTalk(): Promise<void> {
    // If a start is still in flight, let it finish so isRecording flips
    // true before we decide whether to stop. Otherwise a quick press/release
    // can race past the start and leak a live mic.
    if (this.pendingStart) {
      try { await this.pendingStart; } catch { /* surfaced inside startRecording */ }
    }
    if (!this.isRecording) return;
    await this.stopRecordingAndProcess();
  }

  /**
   * Push-to-dictate exit: shares the stop path (and its pending-start
   * race guard) with stopPushToTalk — the forced-dictation flag is
   * consumed downstream in processUserText.
   */
  async stopDictationPushToTalk(): Promise<void> {
    await this.stopPushToTalk();
  }

  // ── Always-on listening (VAD utterances) ─────────────────────────────

  /**
   * One finished utterance from the overlay's VAD (always-on mode).
   * Drops anything that arrives while we're busy — queueing would
   * create overlapping turns fighting over the mic and screen.
   */
  handleVadUtterance(pcm: Buffer): void {
    // Each guard logs its reason: a hands-on bug report of "always-on
    // listening does nothing" is otherwise unanswerable, because the
    // utterance vanishes silently here.
    if (!settingsStore.get('alwaysOnEnabled')) {
      console.log('[Zapi] vad drop: always-on disabled');
      return;
    }
    // The setup mic check owns the mic and drops chunks itself; admitting
    // an utterance now would transcribe a half-captured buffer.
    if (this.micTestActive) {
      console.log('[Zapi] vad drop: mic test in progress');
      return;
    }
    if (this.isRecording || this.pendingStart) {
      console.log('[Zapi] vad drop: recording in progress');
      return;
    }
    // 'acting' is admitted too so a hands-free "zapi stop" reaches the
    // voice-stop check while the agent drives. 'listening'/'processing'/
    // 'responding' still drop — otherwise the mic hears our own TTS.
    if (this.voiceState !== 'idle' && this.voiceState !== 'acting') {
      console.log(`[Zapi] vad drop: voice state ${this.voiceState}`);
      return;
    }
    void this.processVadUtterance(pcm);
  }

  /**
   * Wake gate for hands-free utterances: in always-on mode the mic hears
   * everything, so an utterance only becomes a turn when it carries a wake
   * token — 'zapi'/'zappi'/'zappy' with an optional 'hey'/'ok'/'okay'
   * prefix, anywhere in the phrase ('hey zapi what's this', 'what is this
   * zapi'). Returns the address flag plus the utterance with the wake span
   * stripped. PTT turns never pass through here — a keypress is already an
   * explicit summon, so the full transcript is kept.
   */
  private normalizeVadUtterance(text: string): { addressed: boolean; text: string } {
    const match = /(?:\b(?:hey|ok|okay)\b[,.! ]*)?\b(zapi|zappi|zappy)\b[,.! ]*/i.exec(text);
    if (!match) return { addressed: false, text };
    const stripped = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length))
      .replace(/\s+/g, ' ')
      .trim();
    return { addressed: true, text: stripped };
  }

  /**
   * Bare "stop the agent" utterance, with the same optional wake spellings
   * the wake gate and voice-stop branch share. Declared once so the gate
   * and processUserText can never drift on what counts as a stop.
   */
  private static readonly STOP_COMMAND =
    /^(hey |ok |okay )?(zapi |zappi )?(stop|cancel|abort|enough|never ?mind)[.! ]*$/i;

  private async processVadUtterance(pcm: Buffer): Promise<void> {
    // Abort any in-flight turn BEFORE bumping the id, mirroring
    // startRecording. Bumping alone only fences off stale *callbacks* —
    // the LLM stream it was meant to supersede would keep running (and
    // keep holding the provider socket) until it finished on its own.
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    // Own a fresh turn id so stragglers from the previous turn (a
    // still-playing scene, a finishing TTS) stop before this one starts.
    const myTurnId = ++this.turnId;
    // ...but NOT when the agent loop is driving: clearing scenes/status
    // and flipping to 'processing' would stomp the live run's UI, and
    // processUserText needs voiceState==='acting' to recognise the stop
    // command. The loop keeps owning voice state until it ends or stops.
    const acting = this.voiceState === 'acting';
    if (!acting) {
      this.stopSpeech();
      this.clearSceneTimers();
      this.callbacks.onScene(null);
      this.callbacks.onSceneCue(null);
      this.callbacks.onAgentStatus({ agentId: AGENT_ID_MAIN, phase: 'idle', step: 0, maxSteps: 0 });
      this.setVoiceState('processing');
    }

    try {
      const result = await transcribeWith(settingsStore.get('transcriptionProvider'), pcm);
      // A PTT press during upload bumps the turn and owns the mic —
      // drop this utterance rather than race it.
      if (this.turnId !== myTurnId || this.isRecording) return;
      if (!result.text.trim()) {
        // Only release voice state we claimed; a live loop owns 'acting'.
        if (!acting) this.setVoiceState('idle');
        return;
      }
      // Wake gate: hands-free speech without a wake token isn't for us —
      // drop it silently so background chatter never becomes a turn.
      // Dictation bypasses the gate (it transcribes whatever the mic
      // hears), and the stripped text feeds the turn so the model never
      // sees the wake span. Note "zapi stop" still reaches the voice-stop
      // check — stripping leaves the bare "stop", which matches.
      const gated = this.normalizeVadUtterance(result.text);
      // A bare stop command is exempt while the agent drives: the user is
      // reacting to the mouse moving under them, and demanding "zapi"
      // first is exactly the friction the stop affordance exists to
      // remove. It only routes to the stop branch in processUserText —
      // every other early return there is a no-op, so widening the gate
      // here can't turn stray speech into a turn.
      const stopBypassesGate = acting && CompanionManager.STOP_COMMAND.test(result.text.trim());
      if (!settingsStore.get('dictationEnabled') && !gated.addressed && !stopBypassesGate) {
        const preview = result.text.length > 60 ? `${result.text.slice(0, 60)}…` : result.text;
        console.log(`[Zapi] VAD utterance ignored (no wake token): "${preview}"`);
        if (!acting) this.setVoiceState('idle');
        return;
      }
      const addressText = gated.addressed ? gated.text : result.text;
      if (!addressText.trim()) {
        // Utterance was nothing but the wake token — same as empty.
        if (!acting) this.setVoiceState('idle');
        return;
      }
      const turnResult = { ...result, text: addressText };
      this.callbacks.onTranscriptUpdate(turnResult);
      // The wake gate passed — this utterance is a real turn, so the
      // overlay plays its 'heard' chirp. PTT turns don't get one: the
      // keypress itself is already the acknowledgment.
      this.callbacks.onVadAccepted?.();
      analytics.trackUserMessageSent(addressText);
      // Always-on path marker — separates hands-free utterances from
      // PTT turns in the funnel.
      analytics.trackAlwaysOnUtterance();
      await this.processUserText(addressText);
    } catch (err) {
      if (this.turnId !== myTurnId) return;
      console.error('[Zapi] VAD utterance transcription failed:', err);
      // Same ownership rule as above: never release the loop's 'acting'.
      if (!acting) this.setVoiceState('idle');
      this.callbacks.onError(
        `couldn't transcribe that — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Mic check (setup) ────────────────────────────────────────────────

  startMicTest(): void {
    if (this.isRecording || this.micTestActive) return;
    this.micTestActive = true;
    this.callbacks.onStartAudioCapture('ptt');
  }

  stopMicTest(): void {
    if (!this.micTestActive) return;
    this.micTestActive = false;
    // Don't yank the mic out from under a real PTT turn that started
    // while the test was running.
    if (this.isRecording) return;
    this.callbacks.onStopAudioCapture();
    // The mic check hijacks the single capture gate into 'ptt' mode, and
    // only stopRecordingAndProcess / setAlwaysOn ever handed it back to
    // 'vad'. Without this a user who ran the setup check with always-on
    // listening enabled silently lost always-on until they toggled the
    // setting or restarted — the mic looked live and nothing arrived.
    if (settingsStore.get('alwaysOnEnabled') && !this.isRecording && this.voiceState !== 'acting') {
      this.callbacks.onStartAudioCapture('vad');
    }
  }

  private clearSceneTimers(): void {
    for (const t of this.sceneTimers) clearTimeout(t);
    this.sceneTimers = [];
  }

  /**
   * Schedule a scene's beats so overlay + stream stay in lockstep. The
   * full cue list is emitted once, then one beat index per cue at
   * computed times; after the last beat the finished drawing holds for
   * a few seconds before clearing.
   *
   * Dwell per cue kind: 'point' keeps the old walkthrough timing
   * (2.6–5.5s scaled by caption length so longer instructions stay
   * readable); draw cues are quick strokes (~1.1s plus 40ms per written
   * char, capped at 2s); 'clear' just needs a beat for the wipe.
   */
  private startScene(scene: Scene, isCurrent: () => boolean, onDone?: () => void): void {
    this.clearSceneTimers();
    this.callbacks.onScene(scene);

    const dwellFor = (cue: SceneCue): number => {
      if (cue.kind === 'point') {
        const label = cue.text ?? '';
        return Math.max(2600, Math.min(5500, 1800 + label.length * 80));
      }
      if (cue.kind === 'clear') return 300;
      return Math.min(2000, 1100 + (cue.text?.length ?? 0) * 40);
    };

    let cursor = 0;
    scene.cues.forEach((cue, i) => {
      const t = setTimeout(() => {
        if (!isCurrent()) return;
        this.callbacks.onSceneCue(i);
      }, cursor);
      this.sceneTimers.push(t);
      cursor += dwellFor(cue);
    });

    // Hold the finished scene on screen for a beat after the last cue
    // lands, then clear both the beat index and the scene itself.
    const endTimer = setTimeout(() => {
      if (!isCurrent()) return;
      this.callbacks.onSceneCue(null);
      this.callbacks.onScene(null);
      onDone?.();
    }, cursor + 4000);
    this.sceneTimers.push(endTimer);
  }

  /**
   * First-run ink demo: a canned scene played through the real scene
   * scheduler so new users see the drawing system without needing API
   * keys. Coordinates are display-space logical px against the primary
   * display (main routes to the overlay holding the first cue's anchor).
   * Owns a fresh turn id so a PTT press mid-demo cancels playback via the
   * usual isCurrent gates; voice rides 'responding' for the playback span.
   */
  playDemoScene(): void {
    // Visual-only, but never steal a live turn: a recording, an in-flight
    // answer, or a running agent ('acting' is a non-idle voice state) all
    // veto the demo.
    if (this.isRecording || this.pendingStart) return;
    if (this.voiceState !== 'idle') return;

    let bounds;
    try {
      bounds = screen.getPrimaryDisplay().bounds;
    } catch {
      return;
    }

    // Own a fresh turn so stragglers from the previous turn stop, and any
    // PTT press during playback supersedes the demo outright.
    const myTurnId = ++this.turnId;
    const isCurrent = () => this.turnId === myTurnId;
    this.clearSceneTimers();
    this.callbacks.onScene(null);
    this.callbacks.onSceneCue(null);
    this.callbacks.onAgentStatus({ agentId: AGENT_ID_MAIN, phase: 'idle', step: 0, maxSteps: 0 });

    this.setVoiceState('responding');
    this.startScene(this.buildDemoScene(bounds), isCurrent, () => {
      if (isCurrent()) this.setVoiceState('idle');
    });
  }

  /**
   * Canned ~6-cue scene for the first-run demo. Every anchor sits inside
   * the given display bounds; the closing point cue hovers above the
   * bottom edge where the taskbar lives.
   */
  private buildDemoScene(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Scene {
    const { x: bx, y: by, width: W, height: H } = bounds;
    const px = (fx: number): number => Math.round(bx + fx * W);
    const py = (fy: number): number => Math.round(by + fy * H);
    return {
      cues: [
        { kind: 'arrow', x: px(0.2), y: py(0.25), x2: px(0.45), y2: py(0.4), screenIndex: 0 },
        { kind: 'box', x: px(0.4), y: py(0.35), w: Math.round(W * 0.25), h: Math.round(H * 0.2), screenIndex: 0 },
        { kind: 'write', x: px(0.42), y: py(0.3), text: 'zapi can draw on your screen', screenIndex: 0 },
        { kind: 'circle', x: px(0.6), y: py(0.55), w: 60, h: 40, screenIndex: 0 },
        {
          kind: 'path',
          x: px(0.3),
          y: py(0.7),
          points: [
            { x: px(0.3), y: py(0.7) },
            { x: px(0.36), y: py(0.64) },
            { x: px(0.42), y: py(0.7) },
            { x: px(0.48), y: py(0.64) },
            { x: px(0.54), y: py(0.7) },
          ],
          screenIndex: 0,
        },
        { kind: 'point', x: px(0.5), y: py(1) - 80, text: 'and point at things', screenIndex: 0, step: 1, total: 1 },
      ],
    };
  }

  private async startRecording(): Promise<void> {
    // Bump the turn and abort any in-flight work from the previous one
    // so the user's new message supersedes whatever Zapi was doing —
    // including a running agent loop, whose AbortController dies here.
    this.turnId += 1;
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    // New turn supersedes speech in flight — a user pressing the key to
    // interrupt shouldn't still hear the previous answer to the end.
    this.stopSpeech();
    // Clear any stale agent status / scene the superseded turn left up.
    this.callbacks.onAgentStatus({ agentId: AGENT_ID_MAIN, phase: 'idle', step: 0, maxSteps: 0 });
    this.clearSceneTimers();
    this.callbacks.onScene(null);
    this.callbacks.onSceneCue(null);

    this.isRecording = true;
    this.setVoiceState('listening');
    analytics.trackPushToTalkStarted();

    const provider = settingsStore.get('transcriptionProvider');
    this.transcriptionProvider = createTranscriptionProvider(provider);
    // No partial-transcript wiring: every provider is a file upload, so
    // the only transcript is the final one delivered from stop(). The
    // hook used to be assigned here and forwarded `{ isFinal: false }` to
    // the panel, but nothing ever invoked it — dead code that read as a
    // working live-caption feature. A real partial would need a streaming
    // provider; until then, transcripts arrive once, on completion.

    try {
      await this.transcriptionProvider.start();
      // A setup mic check may already hold the capture open; starting
      // again is harmless (the overlay just re-opens the gate). An
      // always-on VAD capture switches to 'ptt' so chunks stream live.
      this.micTestActive = false;
      this.callbacks.onStartAudioCapture('ptt');
    } catch (err) {
      console.error('Failed to start transcription:', err);
      this.setVoiceState('idle');
      this.isRecording = false;
      this.transcriptionProvider = null;
      // No turn will follow, so a push-to-dictate arming this recording
      // has nothing left to apply to — drop it here or it would force the
      // next unrelated PTT turn to dictate.
      this.forcedDictation = false;
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }

  private async stopRecordingAndProcess(): Promise<void> {
    this.isRecording = false;
    this.callbacks.onStopAudioCapture();
    analytics.trackPushToTalkReleased();

    try {
      if (!this.transcriptionProvider) {
        this.forcedDictation = false;
        this.setVoiceState('idle');
        return;
      }

      // A failed upload (bad Groq key, offline, 4xx) used to throw straight
      // out of here — nothing caught it, so the voice state stayed stuck on
      // 'listening' and the next PTT press did nothing. Contain it.
      let result: TranscriptionResult;
      try {
        result = await this.transcriptionProvider.stop();
      } catch (err) {
        console.error('Transcription failed:', err);
        this.transcriptionProvider = null;
        this.forcedDictation = false;
        this.setVoiceState('idle');
        this.callbacks.onError(
          `couldn't transcribe that — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      this.transcriptionProvider = null;

      if (!result.text.trim()) {
        this.forcedDictation = false;
        this.setVoiceState('idle');
        return;
      }

      this.callbacks.onTranscriptUpdate(result);
      analytics.trackUserMessageSent(result.text);

      // processUserText is a floating call from index.ts's `void
      // stopPushToTalk()`. A synchronous throw inside it (native typer
      // failure, clipboard write) would therefore escape as an unhandled
      // rejection AND skip the state reset, leaving voiceState at
      // 'processing' — which the VAD gate treats as busy, so always-on
      // listening is dead until restart. Contain it exactly like the
      // transcription-failure path above.
      try {
        await this.processUserText(result.text);
      } catch (err) {
        console.error('[Zapi] turn processing failed:', err);
        this.forcedDictation = false;
        this.setVoiceState('idle');
        this.callbacks.onError(
          `something went wrong with that turn — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      // Always-on mode re-opens the mic in VAD mode once the turn is
      // fully done. Skipped when a fresh PTT already grabbed the mic,
      // and when the turn ended up driving the agent — the loop owns the
      // capture then, and re-arming VAD underneath it would hand the mic
      // to a second VAD while 'acting'.
      const agentDriving = this.voiceState === 'acting';
      if (agentDriving) {
        console.log('[Zapi] vad capture not reopened: agent run is driving');
      } else if (settingsStore.get('alwaysOnEnabled') && !this.isRecording) {
        this.callbacks.onStartAudioCapture('vad');
      }
    }
  }

  /**
   * Everything after a final transcript — shared by PTT turns and
   * always-on VAD utterances.
   *
   * Order matters: an agent voice-stop runs first so "zapi stop" kills a
   * live loop without a model round-trip; then mode-toggling voice
   * commands so the trigger phrase itself ("stop dictating") is never
   * typed into the user's document; dictation short-circuits before any
   * model call; the agent trigger diverts to the computer-control loop;
   * anything else is a normal talk turn.
   *
   * `source` distinguishes a spoken turn from a text-authored one. A
   * routine/suggestion/typed text is already an instruction the user
   * wrote, so it must not be re-interpreted: skipping the voice-only
   * branches (self-settings commands, dictation, the agent trigger)
   * keeps a routine like "email me the agent roster" from dictating the
   * word "agent" into their document or spawning a nested agent run.
   */
  private async processUserText(
    text: string,
    opts?: { source?: 'voice' | 'routine' | 'suggestion' | 'typed'; agentId?: string },
  ): Promise<void> {
    const fromVoice = (opts?.source ?? 'voice') === 'voice';
    const turnAgentId = opts?.agentId ?? AGENT_ID_MAIN;
    const myTurnId = this.turnId;
    const isCurrent = () => this.turnId === myTurnId;
    // Mode flags are read from the store at each point of use, NOT from a
    // turn-start snapshot: a turn lives for minutes (agent runs especially)
    // and the user can toggle dictation/agent/auto-type from the panel or
    // tray meanwhile. A snapshot meant a toggle during a long turn only took
    // effect on the *next* one.
    const trimmed = text.trim();
    // Consume the one-shot push-to-dictate flag HERE, at turn entry, so
    // every early return below (agent stop, non-addressed speech, mode
    // toggles) inherits the clear. Reading it further down let a start
    // failure or a mode-command transcript leave the flag armed, and the
    // NEXT unrelated PTT turn would be silently forced to dictate.
    const forcedDictation = this.forcedDictation;
    this.forcedDictation = false;

    // Agent voice stop: while the loop is genuinely driving, a bare stop
    // command kills it immediately — no screenshot, no model call. The
    // liveness probe (voice 'acting' + an un-aborted turn controller)
    // matters: a PTT interrupt already aborted the loop via its turn bump,
    // so PTT transcripts always fall through to normal handling below,
    // while a VAD utterance racing a live loop lands here.
    const agentLive =
      fromVoice &&
      this.voiceState === 'acting' &&
      this.currentAbort !== null &&
      !this.currentAbort.signal.aborted;
    if (
      settingsStore.get('agentEnabled') &&
      agentLive &&
      CompanionManager.STOP_COMMAND.test(trimmed)
    ) {
      this.stopAgent();
      await this.speakLine('stopped.', isCurrent);
      return;
    }
    if (agentLive) {
      // Speech that isn't a stop command while the loop drives (always a
      // VAD utterance — PTT can't arrive with a live controller): drop it
      // rather than opening a competing talk turn against the driver.
      return;
    }

    // Mode-toggling voice commands.
    if (fromVoice && /^(hey zapi,? )?(start|begin) dictat/i.test(trimmed)) {
      this.setDictation(true);
      await this.speakLine('dictation on.', isCurrent);
      return;
    }
    if (fromVoice && /stop dictat|^stop dictating/i.test(trimmed)) {
      this.setDictation(false);
      await this.speakLine('dictation off.', isCurrent);
      return;
    }

    // Voice self-settings: a short command that tunes Zapi itself is
    // applied right here instead of spending a model call on it — a
    // "talk slower" that reached the model would get a chatty reply and
    // change nothing. Capped at <8 words so a real question that merely
    // mentions these phrases still becomes a turn.
    if (fromVoice && trimmed.split(/\s+/).filter(Boolean).length < 8) {
      if (await this.applyVoiceSelfSetting(trimmed, isCurrent)) return;
    }

    // Dictation: the transcript IS the output — no screenshot, no model
    // call. Typed into the focused field when the user opted in,
    // otherwise left on the clipboard for a manual paste. A push-to-dictate
    // turn forces this branch even when the sticky mode is off; the flag
    // was already consumed at the top of this function.
    if (fromVoice && (forcedDictation || settingsStore.get('dictationEnabled'))) {
      const preview = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
      let autoTyped = false;
      if (settingsStore.get('autoTypeEnabled')) autoTyped = await typeText(trimmed);
      if (!autoTyped) clipboard.writeText(trimmed);
      console.log(`[Zapi] Dictation → ${autoTyped ? 'auto-typed' : 'clipboard'}: "${preview}"`);
      if (!isCurrent()) return;
      this.callbacks.onTypeFulfilled({ text: trimmed, preview, autoTyped });
      // Close out the stream turn the final transcript opened, and log
      // the turn so history/usage can tell dictation from real replies.
      this.callbacks.onAiResponseComplete('(dictated)');
      usageStore.recordDictationUtterance(AGENT_ID_MAIN);
      analytics.trackDictationUtterance(trimmed.length);
      const dictationEntry = chatHistory.append(AGENT_ID_MAIN, {
        userText: trimmed,
        assistantText: '(dictated)',
        kind: 'dictation',
      });
      this.callbacks.onChatEntryAdded(dictationEntry);
      this.setVoiceState('idle');
      return;
    }

    // Agent trigger: a transcript like "zapi agent, open notepad…"
    // diverts to the computer-control loop instead of a talk turn.
    if (fromVoice && settingsStore.get('agentEnabled')) {
      const parsed = extractAgentTask(trimmed);
      if (parsed !== null) {
        if (!parsed.trim()) {
          // Trigger word with nothing after it — ask, don't guess.
          await this.speakLine('what should i do?', isCurrent);
          return;
        }
        // "zapi agent scout: open notepad" / "scout agent open notepad"
        // route to the named profile; an unrecognized name falls back to
        // 'main' so the utterance still does something.
        const target = this.resolveAgentTarget(trimmed, parsed);
        await this.orchestrator.runTask(target.agentId, target.task);
        return;
      }
    }

    // ── Normal talk turn ───────────────────────────────────────────────

    // Stay in 'processing' until TTS audio is ready to play (or the
    // reply completes without TTS). The UI shows its spinner during
    // this state, so this keeps the spinner visible for the full
    // think + stream + synthesize span instead of flashing for a
    // few ms during screenshot capture only.
    this.setVoiceState('processing');
    try {
      this.lastScreenshots = await captureAllDisplays();
    } catch (err) {
      console.error('Screen capture failed:', err);
      this.lastScreenshots = [];
    }
    if (!isCurrent()) return;
    if (this.lastScreenshots.length === 0) {
      // Almost always means Screen Recording permission is missing on
      // macOS — desktopCapturer returns empty thumbnails in that case.
      // Surface a friendly response instead of letting an empty image
      // 400 the upstream LLM call. Synthesize TTS too so the user
      // hears the error even if their attention is on a different
      // window than the panel.
      const msg = process.platform === 'darwin'
        ? "i can't see your screen right now — give zapi screen recording permission in system settings, then quit and reopen the app."
        : "i can't see your screen right now — screen capture failed.";
      this.callbacks.onAiResponseChunk(msg);
      this.callbacks.onAiResponseComplete(msg);
      const audio = await this.synthesizeSpeech(msg);
      // A new turn may have started while TTS was synthesizing; don't
      // play audio for a turn the user already moved past.
      if (!isCurrent()) return;
      if (audio) {
        this.setVoiceState('responding');
        this.playSpeech(audio);
      }
      this.setVoiceState('idle');
      return;
    }

    const abort = new AbortController();
    this.currentAbort = abort;

    // Every side effect below is gated on the turn id. If the user has
    // already started a new PTT by the time an async callback resolves,
    // we drop the callback on the floor — no stale UI mutations, no
    // stale chat entries, no TTS we'd have to kill on arrival.
    const mindCallbacks: MindCallbacks = {
      onChunk: (chunk: string) => {
        if (!isCurrent()) return;
        this.callbacks.onAiResponseChunk(chunk);
      },
      onComplete: async (
        fullText: string,
        usage?: { inputTokens: number; outputTokens: number },
      ) => {
        if (!isCurrent()) return;
        // Providers call onComplete WITHOUT awaiting the returned promise,
        // so this body's rejection would be unhandled — and since the
        // trailing setVoiceState('idle') lives at the end, a throw from
        // recordExchange / typeText / TTS would pin the UI on
        // 'processing' forever and deafen always-on VAD. Own the failure
        // here and always release voice state.
        try {
          await this.completeTalkTurn(text, fullText, usage, isCurrent, turnAgentId, !fromVoice);
        } catch (err) {
          if (!isCurrent()) return;
          console.error('[Zapi] talk turn completion failed:', err);
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
          this.setVoiceState('idle');
        }
      },
      onError: (err: Error) => {
        if (!isCurrent()) return;
        console.error('Mind provider error:', err);
        analytics.trackResponseError(err.message);
        this.setVoiceState('idle');
        this.callbacks.onError(err.message);
      },
    };

    await this.streamMind(
      text,
      this.lastScreenshots,
      this.context.getMessagesForSend(),
      'talk',
      abort.signal,
      mindCallbacks,
    );

    if (this.currentAbort === abort) this.currentAbort = null;
  }

  /**
   * Everything a finished talk turn does once the provider has handed back
   * the full text: history, usage, scene cues, [TYPE:] fulfillment, and
   * spoken playback. Split out of the talk turn's onComplete so the
   * provider's fire-and-forget call site stays small enough that its
   * try/catch (the thing keeping a rejection from wedging voice state) is
   * impossible to drop.
   */
  private async completeTalkTurn(
    userText: string,
    fullText: string,
    usage: { inputTokens: number; outputTokens: number } | undefined,
    isCurrent: () => boolean,
    agentId: string = AGENT_ID_MAIN,
    announce = false,
  ): Promise<void> {
    const settings = settingsStore.getAll();
    analytics.trackAiResponseReceived(fullText);

    const cleanText = fullText.replace(TAG_STRIP_REGEX, '').trim();
    this.callbacks.onAiResponseComplete(cleanText);

    await this.context.recordExchange(userText, cleanText, {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
    if (!isCurrent()) return;
    this.emitMemoryStats();

    // File blocks are deliverables, not reply text — TAG_STRIP_REGEX
    // already dropped them from cleanText; here they become real files
    // under the agent's artifacts dir. A rejected filename or a full
    // disk must not kill the turn, so each write is isolated.
    const artifactIds: string[] = [];
    const artifactTitles: string[] = [];
    for (const file of parseFileTags(fullText)) {
      try {
        const artifact = artifactStore.writeArtifact(agentId, file.filename, file.content);
        artifactIds.push(artifact.id);
        artifactTitles.push(artifact.title);
        console.log(`[Zapi] [${agentId}] artifact → ${artifact.title} (${artifact.kind})`);
      } catch (err) {
        console.error(`[Zapi] [${agentId}] artifact write failed:`, err);
      }
    }

    const entry = chatHistory.append(agentId, {
      userText,
      assistantText: cleanText,
      kind: 'talk',
      ...(artifactIds.length > 0 ? { artifactIds } : {}),
    });
    this.callbacks.onChatEntryAdded(entry);
    usageStore.recordTalkTurn(agentId);

    // Name the files on the agent's status line so the card/stream
    // says what actually landed, not just that the turn ended.
    if (artifactTitles.length > 0) {
      this.callbacks.onAgentStatus({
        agentId,
        phase: 'done',
        step: 0,
        maxSteps: 0,
        message: `wrote ${artifactTitles.join(', ')}`,
      });
    }

    // Scene cues and [TYPE:] tags parse the file-stripped text: file
    // content is user data, so a [POINT:] sitting inside a markdown
    // deliverable must not draw on screen or type into a field.
    const instructionText = stripFileBlocks(fullText);
    // Scene cues (POINT tags + draw strokes) ride on the raw text —
    // tags are already mapped to display coords by the parser.
    const scene = parseScene(instructionText, this.lastScreenshots);
    if (scene && scene.cues.length > 0) {
      console.log(
        `[Zapi] Scene: ${scene.cues.length} cue(s) →`,
        scene.cues.map((c) => c.kind).join(', '),
      );
      this.startScene(scene, isCurrent);
      analytics.trackSceneDrawn(scene.cues.map((c) => c.kind));
      const firstPoint = scene.cues.find((c) => c.kind === 'point');
      if (firstPoint) {
        analytics.trackElementPointed(firstPoint.text ?? 'element');
      }
    }

    // [TYPE:...] tags. If the user has opted into auto-typing AND
    // the OS permission is in place, we send the keys directly via
    // the native typer; otherwise we fall back to clipboard handoff.
    // typeText() returns false on any failure so the user is never
    // left with no way to act on the request.
    const typeTexts = parseTypeTags(instructionText);
    for (const t of typeTexts) {
      if (!t) continue;
      const preview = t.length > 50 ? `${t.slice(0, 50)}…` : t;
      let autoTyped = false;
      if (settings.autoTypeEnabled) {
        autoTyped = await typeText(t);
      }
      if (!autoTyped) {
        clipboard.writeText(t);
      }
      console.log(
        `[Zapi] Type request → ${autoTyped ? 'auto-typed' : 'clipboard'}: "${preview}"`,
      );
      this.callbacks.onTypeFulfilled({ text: t, preview, autoTyped });
    }

    // A muted routine stays quiet all the way through: the run happens and
    // the result lands in the agent's chat, but it neither speaks its reply
    // nor posts a banner. Voice turns are never muted this way.
    const mutedRoutine = announce && settingsStore.get('routinesMuted');
    if (!mutedRoutine) {
      const audio = await this.synthesizeSpeech(cleanText);
      // User may have started a new turn while TTS was synthesizing;
      // don't play audio for a turn the user already moved past.
      if (!isCurrent()) return;
      if (audio) {
        this.setVoiceState('responding');
        this.playSpeech(audio);
      }
    }
    this.setVoiceState('idle');

    // A routine has no user watching the stream, so the reply itself is
    // the only record — announce it once the turn is fully closed. 'main'
    // is exempt: its own reply already spoke above, so a second line would
    // only talk over it. Produced files are named too — the banner is the
    // background agent's only visible status line.
    if (announce && agentId !== AGENT_ID_MAIN) {
      const fileNote = artifactTitles.length > 0 ? ` — wrote ${artifactTitles.join(', ')}` : '';
      this.announceCompletion(agentId, `${cleanText}${fileNote}`, { silent: mutedRoutine });
    }
  }

  /**
   * Agent mode: screenshot → plan → act, up to agentMaxSteps iterations.
   * The model emits action tags; the driver executes them against the
   * OS. The whole loop runs under the turn's AbortController so a new
   * PTT press or AGENT_STOP kills it between steps.
   *
   * Resilience budgets: each step gets 90 s (one retry with a nudge);
   * the whole run dies at 10 min wall-clock; two consecutive steps with
   * zero action tags fail fast instead of burning the step budget.
   */
  /**
   * Pick the agent a trigger utterance names, and strip the name out of
   * the task so the model never sees it.
   *
   * Matches profile names anywhere in the transcript (longest name first,
   * so "Path" can't shadow "Pathfinder"), and accepts the "name:" lead the
   * routing rule uses — "zapi agent scout: open notepad" arrives from the
   * parser as the task "scout: open notepad", which must become
   * "open notepad" on Scout's card. A name that matches no profile leaves
   * the default agent in charge rather than dropping the request.
   */
  private resolveAgentTarget(
    transcript: string,
    task: string,
  ): { agentId: string; task: string } {
    const profiles = [...settingsStore.listAgents()].sort(
      (a, b) => b.name.length - a.name.length,
    );
    for (const profile of profiles) {
      const name = profile.name;
      if (!name) continue;
      if (!new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(transcript)) continue;
      // Strip a leading "<name>:" / "<name> -" when the parser left it in.
      const lead = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[:,—\\-]\\s*`, 'i');
      const cleaned = lead.test(task) ? task.replace(lead, '').trim() : task;
      return { agentId: profile.id, task: cleaned };
    }
    return { agentId: AGENT_ID_MAIN, task };
  }

  /**
   * The agent loop itself now lives in AgentRuntime (Phase B extraction);
   * this wrapper only exists so the 'main' runtime is created and reused.
   */
  // ── Routines (Phase D) ────────────────────────────────────────────────

  /** Re-evaluate schedules after a settings/routine change. */
  reloadRoutines(): void {
    this.routines.reload();
  }

  /** Clear the tick timer — called from `will-quit`. */
  stopRoutines(): void {
    this.routines.stop();
  }

  /**
   * Run a text-authored task as a talk-mode turn on the given agent —
   * the shared shape behind scheduled routines, accepted suggestion
   * cards, and typed chat messages.
   *
   * Two guards keep a queued task from hijacking a live conversation:
   * it is skipped entirely while the user is mid-turn, and empty text
   * is a no-op. `routinesMuted` deliberately does NOT gate the run —
   * muting silences the announcement, not the work.
   */
  private async runQueuedTask(
    agentId: string,
    task: string,
    source: 'routine' | 'suggestion' | 'typed',
    label: string,
  ): Promise<void> {
    const trimmedTask = task.trim();
    if (!trimmedTask) return;
    if (this.isRecording || this.pendingStart || this.voiceState !== 'idle') {
      console.log(`[Zapi] ${label} skipped: pipeline busy`);
      return;
    }
    console.log(`[Zapi] ${label} firing on ${agentId}`);
    // A queued task is a real turn: bump the counter so any straggler
    // from a previous turn stops mutating UI while this one runs.
    this.turnId += 1;
    try {
      await this.processUserText(trimmedTask, { source, agentId });
    } catch (err) {
      console.error(`[Zapi] ${label} turn failed:`, err);
      this.setVoiceState('idle');
    }
  }

  private async runRoutineTask(routine: Routine): Promise<void> {
    await this.runQueuedTask(
      routine.agentId,
      routine.task,
      'routine',
      `routine "${routine.name || routine.id}"`,
    );
  }

  /**
   * A message typed into the panel's chat box — a text turn on that
   * agent, same pipeline shape as a routine (none of the voice-only
   * branches run: no self-settings commands, no dictation, no agent
   * trigger).
   */
  async runTextTurn(agentId: string, text: string): Promise<void> {
    await this.runQueuedTask(agentId ?? AGENT_ID_MAIN, text ?? '', 'typed', 'typed turn');
  }

  // ── Suggestions ────────────────────────────────────────────────────

  /**
   * Accept a suggestion card: dismiss it (an accepted card never comes
   * back, even if the run ends up skipped for a busy pipeline) and run
   * its task on the card's own agent — same turn shape as a routine.
   */
  acceptSuggestion(id: string): void {
    const card = suggestionStore.listAll().find((s) => s.id === id);
    if (!card) {
      this.reportAgentError("couldn't find that suggestion — it may already be gone");
      return;
    }
    suggestionStore.dismiss(id);
    this.emitSettings();
    void this.runQueuedTask(
      card.agentId,
      card.task,
      'suggestion',
      `suggestion "${card.title || card.id}"`,
    );
  }

  dismissSuggestion(id: string): void {
    if (!suggestionStore.dismiss(id)) {
      this.reportAgentError("couldn't dismiss that suggestion — not found");
      return;
    }
    this.emitSettings();
  }

  /** Reentrancy guard: two refreshes racing would double-add cards. */
  private suggestionsRefreshing = false;

  /**
   * Ask the suggestions engine for fresh cards across every active
   * agent, persist what comes back, and re-broadcast settings so the
   * panel's card pile updates. A refresh that finds nothing new still
   * emits — the panel should learn the pile is up to date either way.
   */
  async refreshSuggestions(): Promise<void> {
    if (this.suggestionsRefreshing) return;
    this.suggestionsRefreshing = true;
    try {
      const agents = settingsStore
        .listAgents()
        .filter((a) => !a.archived)
        .map((a) => ({ id: a.id, name: a.name }));
      const recentChats: Record<string, { userText: string; assistantText?: string }[]> = {};
      for (const agent of agents) {
        recentChats[agent.id] = chatHistory
          .list(agent.id)
          .map((e) => ({ userText: e.userText, assistantText: e.assistantText }));
      }
      const suggestions = await generateSuggestions({
        agents,
        recentChats,
        complete: (prompt, signal) => this.completeOnce(prompt, signal),
      });
      for (const s of suggestions) suggestionStore.add(s);
    } catch (err) {
      // A refresh is best-effort — existing cards stay put, and the
      // panel still needs the emit so its list reflects the store.
      console.error('[Zapi] suggestion refresh failed:', err);
    } finally {
      this.suggestionsRefreshing = false;
    }
    this.emitSettings();
  }

  /**
   * One-shot completion against the configured Mind for non-turn work
   * (suggestion generation). Reuses streamMind so provider/model/base-
   * URL selection stays in exactly one place; chunks are dropped since
   * only the full reply matters.
   */
  private completeOnce(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // A provider that throws before reaching its callbacks would
      // otherwise leave this promise pending (and the rejection
      // unhandled) — fold it into the same reject.
      this.streamMind(prompt, [], [], 'talk', signal ?? new AbortController().signal, {
        onChunk: () => {},
        onComplete: (fullText) => resolve(fullText),
        onError: reject,
      }).catch(reject);
    });
  }

  /**
   * Announce a finished agent run: a transient overlay line plus (unless
   * muted) a spoken one-liner.
   *
   * `silent` suppresses the whole announcement (banner and voice) — used
   * for routines when `routinesMuted` is on, where the user asked for
   * quiet but still wants the work done.
   *
   * Audio is additionally skipped when the user is mid-turn: their reply
   * matters more than a status ping, so the bubble still appears and the
   * voice simply waits.
   */
  private announceCompletion(agentId: string, summary: string, opts?: { silent?: boolean }): void {
    if (opts?.silent) return;
    const profile = settingsStore.listAgents().find((a) => a.id === agentId);
    const name = profile?.name ?? 'Agent';
    const line = `${name} finished: ${summary}`.replace(TAG_STRIP_REGEX, '').trim();
    this.showTransientBanner(line);

    if (this.voiceState !== 'idle') return;
    const spoken = `${name} finished.`;
    void this.synthesizeSpeech(spoken).then((audio) => {
      if (audio) this.playSpeech(audio);
    });
  }

  /**
   * One-cue scene used purely as a transient banner. Reuses the scene
   * scheduler (so it self-clears on the normal end-of-scene timer) rather
   * than inventing a second overlay channel.
   */
  private showTransientBanner(text: string): void {
    let bounds;
    try {
      bounds = screen.getPrimaryDisplay().bounds;
    } catch {
      return;
    }
    // Bottom-center, clear of the taskbar, and clamped so a long summary
    // can't run off the right edge. The write cue wraps at 46ch with
    // rows growing DOWN from the anchor baseline, so the centering and
    // the anchor lift both have to be wrap-aware: a flat 7px/char guess
    // pushed long labels right-of-center, and an unlifted multi-row
    // block let the last line clip the bottom edge at high-DPI heights.
    const WRITE_COLS = 46;   // renderer's wrapWriteLines cap
    const WRITE_CH_PX = 10;  // ~per-char advance of Caveat SemiBold 30px
    const WRITE_ROW_PX = 38; // 1.25em row pitch the write cue draws at
    const maxChars = Math.max(12, Math.floor(bounds.width / 14));
    const label = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
    const rows = Math.max(1, Math.ceil(label.length / WRITE_COLS));
    const widestRow = Math.min(WRITE_COLS, label.length);
    const x = Math.round(bounds.x + bounds.width / 2 - (widestRow * WRITE_CH_PX) / 2);
    const y = Math.round(bounds.y + bounds.height * 0.92 - (rows - 1) * WRITE_ROW_PX);
    // Gate on nothing: a banner should survive turn churn, and the next
    // real turn's startRecording clears it if it must.
    this.startScene({ cues: [{ kind: 'write', x, y, text: label, screenIndex: 0 }] }, () => true);
  }

  /**
   * Announce a completed run for a BACKGROUND agent. 'main' is skipped —
   * its own summary already speaks through the normal reply path, so it
   * would double up. Routed through the status sink so every runtime is
   * covered without the orchestrator knowing about announcements.
   */
  private maybeAnnounceAgentDone(status: AgentStatus): void {
    if (status.agentId === AGENT_ID_MAIN) return;
    if (status.phase !== 'done') return;
    this.announceCompletion(status.agentId, status.message ?? 'done.');
  }

  private async runAgentLoop(task: string): Promise<void> {
    await this.orchestrator.runTask(AGENT_ID_MAIN, task);
  }

  /**
   * One streaming call to the configured Mind provider. All three
   * providers share the same call shape; `mode` rides along in the
   * options bag so the provider can pick the agent system prompt
   * (buildSystemPrompt(tone, { hasWebSearch, mode })) over the talk one.
   */
  private async streamMind(
    prompt: string,
    screenshots: ScreenCapture[],
    history: ConversationTurn[],
    mode: 'talk' | 'agent',
    signal: AbortSignal,
    callbacks: MindCallbacks,
  ): Promise<void> {
    const settings = settingsStore.getAll();
    const mindOptions = {
      reasoningDepth: settings.reasoningDepth,
      replyTone: settings.replyTone,
      signal,
      mode,
    };

    if (settings.mindProvider === 'openai') {
      // A custom model id wins over the picker value — lets users point
      // at model names the dropdown doesn't list. The service treats it
      // as opaque, so the cast is safe.
      const model = (settings.customOpenAIModel || settings.selectedOpenAIModel) as OpenAIModel;
      await this.openai.streamChat(prompt, screenshots, history, model, {
        ...mindOptions,
        // '' → default api.openai.com; set points at ClinePass/proxies.
        baseUrl: settings.openAIBaseUrl || undefined,
      }, callbacks);
      return;
    }

    if (settings.mindProvider === 'ollama') {
      const connections = (settings.localConnections ?? []).filter((c) => c.enabled);
      const conn = connections[0];
      if (!conn) {
        callbacks.onError(new Error('No enabled local connection. Add one in Mind → Local.'));
        return;
      }
      const bearerToken = keyStore.getApiKey(`local_${conn.id}`) ?? undefined;
      let model: string;
      if (conn.activeModelId) {
        model = conn.activeModelId;
      } else if (conn.modelIds.length > 0) {
        model = conn.modelIds[0];
      } else {
        const discovered = await this.ollama.getModels(conn.url, bearerToken);
        model = discovered[0] ?? 'llama3';
      }
      const fullModelId = conn.prefixId ? `${conn.prefixId}${model}` : model;
      await this.ollama.streamChat(
        prompt,
        screenshots,
        history,
        fullModelId,
        mindOptions,
        callbacks,
        conn.url,
        bearerToken,
      );
      return;
    }

    await this.claude.streamChat(
      prompt,
      screenshots,
      history,
      settings.selectedModel,
      mindOptions,
      callbacks,
    );
  }

  /**
   * Synthesize `text` with the configured TTS provider. Returns null
   * when speech is disabled, the chosen provider has no key, or
   * synthesis failed — callers then just skip playback.
   */
  private async synthesizeSpeech(text: string): Promise<Buffer | null> {
    const settings = settingsStore.getAll();
    if (!settings.speakReplies) return null;
    const provider = settings.ttsProvider;
    const keyName = provider === 'fishaudio' ? 'fishaudio' : 'elevenlabs';
    if (!keyStore.getKeyStatus()[keyName]) {
      // Never fall back to the other provider here — a Fish Audio user
      // would get an ElevenLabs voice they didn't choose and didn't
      // configure. Tell them what's missing instead: a silent return is
      // indistinguishable from a muted microphone, so "it never speaks"
      // had no actionable cause anywhere in the UI. Once per provider per
      // session (the set is the same one that gates the log line) — the
      // condition persists, and a toast on every turn would be its own
      // kind of noise. Adding the key clears the status and the silence
      // goes away on its own.
      if (!this.ttsMissingKeyWarned.has(provider)) {
        this.ttsMissingKeyWarned.add(provider);
        console.warn(
          `[Zapi] speakReplies is on but no ${provider} key is configured — replies stay silent.`,
        );
        this.callbacks.onError(
          provider === 'fishaudio'
            ? 'add your Fish Audio key in the panel to hear replies'
            : 'add your ElevenLabs key in the panel to hear replies',
        );
      }
      return null;
    }
    try {
      if (provider === 'fishaudio') {
        // Fish reads its own voice id (reference_id) and the shared
        // voiceSpeed slider. Both are passed explicitly rather than leaning
        // on the service's settings fallback, so the value that reaches the
        // request is visible at the call site.
        return await this.fishTts.synthesize(text, {
          voiceId: settings.fishVoiceId,
          speed: settings.voiceSpeed,
        });
      }
      return await this.tts.synthesize(text, {
        voiceId: settings.voiceId,
        speed: settings.voiceSpeed,
        stability: settings.voiceStability,
      });
    } catch (err) {
      console.error('[Zapi] TTS error:', err);
      analytics.trackTtsError(String(err));
      return null;
    }
  }

  /**
   * Speak (and show) a short canned line — mode-toggle confirmations
   * and the agent's "what should I do?" prompt. Emits to the chat
   * surfaces so the stream doesn't leave the turn stuck on 'streaming'.
   */
  private async speakLine(text: string, isCurrent: () => boolean): Promise<void> {
    this.callbacks.onAiResponseChunk(text);
    this.callbacks.onAiResponseComplete(text);
    const audio = await this.synthesizeSpeech(text);
    if (!isCurrent()) return;
    if (audio) {
      this.setVoiceState('responding');
      this.playSpeech(audio);
    }
    this.setVoiceState('idle');
  }

  /**
   * Voice self-settings — short commands that tune Zapi itself, applied
   * through the same setters the panel and tray use (so every change
   * still emits SETTINGS_CHANGED and rebuilds the tray). Runs INSTEAD
   * of a model call and answers with a short spoken confirmation; the
   * caller gates it to <8-word transcripts so only bare commands land
   * here.
   *
   * Returns true when the transcript was a self-setting command (the
   * turn is done), false when it should fall through to the pipeline.
   */
  private async applyVoiceSelfSetting(
    text: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    // Lowercase, flatten punctuation to spaces (so "stop talking, please"
    // matches "stop talking please"), collapse whitespace, and strip an
    // optional "hey zapi," lead — the VAD path already removes its wake
    // span, but a PTT transcript carries whatever the user said.
    const body = text
      .toLowerCase()
      .replace(/[.!?,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:hey |okay |ok |please )?(?:zapi|zappi|zappy)\s+/i, '')
      .trim();

    const confirm = async (line: string): Promise<true> => {
      await this.speakLine(line, isCurrent);
      return true;
    };

    // Accepted shapes (the smoke mirrors this list): every command core
    // is anchored ^…$ — mid-sentence mentions can never fire, so "i hope
    // you stop talking soon" still becomes a model turn — and each core
    // may carry an optional tail of fixed short words:
    //   please | thanks | thank you | now | for now | again | yourself |
    //   yourselves | to me | with me | a bit | a little | just | ok | okay
    //
    //   speakReplies off : stop|quit|end + talking|announcing|speaking|
    //                      chatting|replying|responding
    //                      don't|dont|do not + talk|speak|announce|reply|…
    //                      be|stay|keep|go quiet · hush|shush|shh
    //   speakReplies on  : start|resume|keep|go back to + talking|…
    //                      talk|speak(ing) to me|with me|to us|again
    //                      you can|may + talk|speak|announce|reply|respond
    //                      unmute · speak up · speak freely
    //   routinesMuted on : mute|silence|quiet + (the|my|your|our) routines
    //   routinesMuted off: unmute + (the|my|your|our) routines
    //                      let (the|my|your) routines talk|speak|announce
    //   alwaysOn on      : listen always · always listen(ing) · always on
    //                      keep|stay|start|resume (always) listening (always)
    //                      never stop listening
    //   alwaysOn off     : stop (always) listening · don't|do not listen
    //                      listening off · turn off listening
    //   speed            : talk|speak(ing) (a|a little|a bit) slower|faster
    //                      slow down · speed up
    const TAIL = String.raw`(?:\s+(?:please|thanks|thank you|now|for now|again|yourself|yourselves|to me|with me|to us|a bit|a little|just|ok|okay|alright))*`;
    const cmd = (core: string): RegExp => new RegExp(`^${core}${TAIL}$`);

    // Voice speed, clamped to the slider's own documented range.
    const clampSpeed = (v: number): number => Math.min(1.2, Math.max(0.7, v));
    if (
      cmd('(?:talk|speak)(?:ing)? (?:a |a little |a bit )?(?:slower|more slowly)').test(body) ||
      cmd('slow down').test(body)
    ) {
      this.setVoiceSpeed(clampSpeed(settingsStore.get('voiceSpeed') - 0.15));
      return confirm('slower.');
    }
    if (
      cmd('(?:talk|speak)(?:ing)? (?:a |a little |a bit )?(?:faster|quicker|more quickly)').test(body) ||
      cmd('speed up').test(body)
    ) {
      this.setVoiceSpeed(clampSpeed(settingsStore.get('voiceSpeed') + 0.15));
      return confirm('faster.');
    }

    // Spoken replies. "stop talking" can't confirm out loud — with
    // speakReplies off the reply text still reaches the stream, and the
    // silence itself is the proof the setting took. Off-phrases are
    // checked first so "don't talk to me" can't land on the on-branch.
    if (
      cmd('(?:stop|quit|end) (?:talking|announcing|speaking|chatting|replying|responding)').test(body) ||
      cmd("(?:don't|dont|do not) (?:talk|speak|announce|reply|respond|say anything)").test(body) ||
      cmd('(?:be|stay|keep|go) quiet').test(body) ||
      cmd('(?:hush|shush|shh)').test(body)
    ) {
      this.setSpeakReplies(false);
      return confirm('okay, quiet now.');
    }
    if (
      cmd('(?:start|resume|keep|go back to) (?:talking|announcing|speaking|replying|responding)').test(body) ||
      cmd('(?:talk|speak)(?:ing)? (?:to me|with me|to us|again)').test(body) ||
      cmd('you (?:can|may) (?:talk|speak|announce|reply|respond)').test(body) ||
      cmd('(?:unmute|speak up|speak freely)').test(body)
    ) {
      this.setSpeakReplies(true);
      return confirm('talking again.');
    }

    // Routine announcements.
    if (cmd('(?:mute|silence|quiet)(?: the| my| your| our)? routines?').test(body)) {
      this.setRoutinesMuted(true);
      return confirm('routines muted.');
    }
    if (
      cmd('unmute(?: the| my| your| our)? routines?').test(body) ||
      cmd('let(?: the| my| your| our)? routines? (?:talk|speak|announce)').test(body)
    ) {
      this.setRoutinesMuted(false);
      return confirm('routines unmuted.');
    }

    // Always-on listening.
    if (
      cmd('listen always').test(body) ||
      cmd('always listen(?:ing)?').test(body) ||
      cmd('always[- ]on').test(body) ||
      cmd('(?:keep|stay|start|resume)(?: always)? listening(?: always)?').test(body) ||
      cmd('never stop listening').test(body)
    ) {
      this.setAlwaysOn(true);
      return confirm('always listening.');
    }
    if (
      cmd('stop (?:always )?listening').test(body) ||
      cmd("(?:don't|dont|do not) listen").test(body) ||
      cmd('listening off').test(body) ||
      cmd('(?:turn|switch) off (?:always )?listening').test(body)
    ) {
      this.setAlwaysOn(false);
      return confirm("i'll stop listening.");
    }

    return false;
  }

  handleAudioChunk(buffer: Buffer): void {
    if (!this.isRecording) return;
    this.transcriptionProvider?.sendAudio(buffer);
  }

  /**
   * Silence any speech the overlay is still playing. A turn's gates
   * (isCurrent) stop us from *starting* stale audio, but a buffer already
   * handed to the overlay keeps playing until it ends — a user who
   * interrupts mid-sentence otherwise keeps hearing the old answer under
   * their new question. Every cancel boundary funnels through here.
   */
  private stopSpeech(): void {
    this.callbacks.onStopAudio?.();
  }

  /**
   * Replace whatever is speaking with `buffer`. The explicit stop first
   * matters on multi-display setups: playback is single-target while the
   * stop is broadcast, so without it a second monitor's overlay could
   * still be mid-sentence and the two would talk over each other.
   */
  private playSpeech(buffer: Buffer): void {
    this.stopSpeech();
    this.callbacks.onPlayAudio(buffer);
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private setVoiceState(state: VoiceState): void {
    this.voiceState = state;
    this.callbacks.onVoiceStateChanged(state);
  }

  private emitSettings(): void {
    this.callbacks.onSettingsChanged(this.getSettings());
    // Re-evaluate schedules on any settings change so a routine edited
    // outside these handlers (or a routinesMuted flip) takes effect at
    // once. Safe to call at high frequency: the scheduler's tick is
    // re-entrancy-guarded and only walks the routine list, so the 30 Hz
    // stream-bounds writes below cost nothing measurable.
    this.routines.reload();
  }

  private emitMemoryStats(): void {
    this.callbacks.onMemoryStatsChanged(this.context.getStats());
  }
}
