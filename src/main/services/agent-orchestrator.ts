import {
  parseAgentActions,
  parseFileTags,
  stripFileBlocks,
  TAG_STRIP_REGEX,
} from './element-detector';
import { leaseWaitPhase } from './input-lease';
import { focusedAppContext } from './active-window';
import { runAgentActions } from './agent-driver';
import { captureAllDisplays } from './screen-capture';
import * as settingsStore from './settings-store';
import * as chatHistory from './chat-history-store';
import * as artifactStore from './artifact-store';
import * as usageStore from './usage-store';
import * as analytics from './analytics';
import type {
  AgentStatus,
  ChatEntry,
  ConversationTurn,
  ScreenCapture,
  VoiceState,
  AgentAction,
} from '../../shared/types';

/**
 * Per-agent turn primitives, so the extracted loop can drive either the
 * mic-owning companion pipeline or a standalone background runtime
 * without knowing which it is.
 *
 * For the 'main' runtime these bindings point at CompanionManager's own
 * fields, which is what keeps its behavior byte-identical to the
 * pre-extraction loop: a PTT press, a VAD turn, or resetFromMicError all
 * still bump the same turnId and abort the same controller the loop
 * installed. Non-main runtimes get their own private state via
 * `LocalTurnControl`.
 */
export interface AgentTurnControl {
  /** Bump the turn counter (a new turn supersedes the previous one) and return it. */
  beginTurn(): number;
  /** Current turn id, for the "is my turn still current" gate. */
  currentTurnId(): number;
  /** Install the in-flight controller so interrupts/stops can reach it. */
  setAbort(ctl: AbortController | null): void;
  currentAbort(): AbortController | null;
  /**
   * Voice state is mic-side and therefore belongs to exactly one runtime
   * ('main'). Left undefined on background runtimes, which must never
   * flip the microphone's state out from under the user.
   */
  setVoiceState?(state: VoiceState): void;
  voiceState?(): VoiceState;
}

/** Standalone turn state for a runtime that doesn't own the mic. */
class LocalTurnControl implements AgentTurnControl {
  private turnId = 0;
  private abort: AbortController | null = null;

  beginTurn(): number {
    this.turnId += 1;
    return this.turnId;
  }

  currentTurnId(): number {
    return this.turnId;
  }

  setAbort(ctl: AbortController | null): void {
    this.abort = ctl;
  }

  currentAbort(): AbortController | null {
    return this.abort;
  }
}

/** Collaborators the loop needs from the owning pipeline. */
export interface AgentRuntimeDeps {
  turn: AgentTurnControl;
  /**
   * True for the runtime that owns the mic: it alone may clear scenes and
   * speak a summary. Background runtimes skip both — clearing would wipe
   * the foreground agent's ink, and speaking would talk over the user.
   */
  ownsVoice: boolean;
  streamMind(
    prompt: string,
    screenshots: ScreenCapture[],
    history: ConversationTurn[],
    mode: 'talk' | 'agent',
    signal: AbortSignal,
    callbacks: {
      onChunk: (chunk: string) => void;
      onComplete: (fullText: string, usage?: { inputTokens: number; outputTokens: number }) => void;
      onError: (error: Error) => void;
    },
  ): Promise<void>;
  recordExchange(userText: string, assistantText: string): Promise<void>;
  emitMemoryStats(): void;
  synthesizeSpeech(text: string): Promise<Buffer | null>;
  playSpeech(buffer: Buffer): void;
  onStatus(status: AgentStatus): void;
  onAction(action: { x: number; y: number; label: string; kind: AgentAction['kind'] }): void;
  onChatEntryAdded(entry: ChatEntry): void;
  onAiResponseChunk(chunk: string): void;
  onAiResponseComplete(fullText: string): void;
  clearSceneTimers(): void;
  /** Broadcast a scene clear (voice-owning runtime only). */
  onSceneClear(): void;
}

/**
 * One agent's isolated run state. Previously these lived as fields on the
 * singleton CompanionManager (turnId, currentAbort, lastScreenshots), which
 * is why only one run could exist at a time; they are per-instance here so
 * several agents can reason concurrently.
 */
export class AgentRuntime {
  readonly id: string;
  private deps: AgentRuntimeDeps;
  /** Screenshots captured for the step in flight; loop-local by nature. */
  private lastScreenshots: ScreenCapture[] = [];
  private status: AgentStatus | null = null;
  /** Set while a run is in flight, so stop() can find and abort it. */
  private running = false;

  constructor(id: string, deps: AgentRuntimeDeps) {
    this.id = id;
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  getStatus(): AgentStatus | null {
    return this.status;
  }

  /**
   * Abort this agent's run and publish an idle status so the status card
   * clears immediately rather than waiting for the loop to unwind.
   */
  stop(): void {
    const ctl = this.deps.turn.currentAbort();
    if (ctl) {
      ctl.abort();
      this.deps.turn.setAbort(null);
    }
    this.emit({ phase: 'idle', step: 0, maxSteps: 0 });
  }

  private emit(partial: Omit<AgentStatus, 'agentId'>): void {
    const status: AgentStatus = { agentId: this.id, ...partial };
    this.status = status;
    this.deps.onStatus(status);
  }

  /**
   * The agent loop, extracted from CompanionManager. Logic is deliberately
   * unchanged — same budgets, same retry, same tag-less strikes, same
   * history feedback — with `this` field reads swapped for `this.deps`
   * calls and the agentId stamped on every status.
   */
  async run(task: string): Promise<void> {
    const { deps } = this;
    const settings = settingsStore.getAll();
    const maxSteps = Math.max(1, settings.agentMaxSteps || 1);
    const myTurnId = deps.turn.beginTurn();
    const abort = new AbortController();
    deps.turn.setAbort(abort);
    const isCurrent = () => deps.turn.currentTurnId() === myTurnId && !abort.signal.aborted;
    this.running = true;

    console.log(`[Zapi] [${this.id}] Agent task (${maxSteps} steps max): "${task}"`);
    if (deps.ownsVoice) {
      // The driver owns the screen for the whole run, so retire any scene
      // the previous turn left mid-playback. processVadUtterance
      // deliberately skips this teardown while 'acting' (to preserve voice
      // state for the stop command), which means a talk-turn scene could
      // otherwise keep drawing on top of the agent's actions.
      deps.clearSceneTimers();
      deps.onSceneClear();
    }
    deps.turn.setVoiceState?.('acting');
    this.emit({ phase: 'thinking', step: 0, maxSteps, message: task });

    // The model sees the task once plus a running log of its own
    // actions. Screenshots are NOT accumulated — each iteration
    // attaches a fresh capture to the new user turn, keeping the
    // request size flat no matter how long the run goes.
    const history: ConversationTurn[] = [{ role: 'user', content: `task: ${task}` }];

    let final: { done: boolean; failed: boolean; message: string } | null = null;
    let stepsRun = 0;
    // Hung providers must not wedge the run, and DSL-deaf models must not
    // burn the whole step budget one empty reply at a time.
    const STEP_TIMEOUT_MS = 90_000;
    const RUN_TIMEOUT_MS = 10 * 60 * 1000;
    const MAX_TAGLESS_STRIKES = 2;
    const runStart = Date.now();
    let taglessStrikes = 0;
    /** Every artifact this run produced, across steps — stamped onto the
     *  run's single chat entry so the pile on the card is reachable. */
    const runArtifactIds: string[] = [];

    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (!isCurrent()) return;
        // Wall-clock safety net: individual steps are each bounded by the
        // per-step timeout, but a run of slow successes still dies here.
        if (Date.now() - runStart > RUN_TIMEOUT_MS) {
          final = { done: false, failed: true, message: 'agent run timed out' };
          break;
        }
        stepsRun = step;
        this.emit({ phase: 'thinking', step, maxSteps });

        let screenshots: ScreenCapture[] = [];
        try {
          screenshots = await captureAllDisplays();
        } catch (err) {
          console.error(`[Zapi] [${this.id}] agent screen capture failed:`, err);
        }
        if (!isCurrent()) return;
        this.lastScreenshots = screenshots;
        if (screenshots.length === 0) {
          final = { done: false, failed: true, message: "can't see the screen" };
          break;
        }

        // Holder object: callbacks assign into fields so the values
        // aren't falsely narrowed to null/'' — TS doesn't track writes
        // made inside function expressions into plain `let`s.
        const stepResult = { text: '', error: null as Error | null };
        // Chunk buffer (still hidden from UI) backing the tag-less strike
        // check, so a step counts even if onComplete's text were partial.
        let buffered = '';
        const basePrompt = `step ${step}/${maxSteps} — look at the screen and emit the next action tag(s).`;
        // Focused-app guide: the window in the foreground is almost
        // always the app the agent is driving, so its driving notes
        // (docs/app-guides) ride in front of the step instruction —
        // keyboard-first habits in VS Code, ms-settings: URIs in
        // Settings, etc. Probed per step because the user can switch
        // apps mid-run; the probe is ~200 ms on Windows and cached 3 s.
        // Null on non-Windows / unmatched process / missing guide — a
        // bare prompt, never a dangling 'Focused app:' heading.
        const focused = await focusedAppContext();
        const stepPrefix = focused
          ? `Focused app: ${focused.app}\n\n${focused.guideText}\n\n`
          : '';
        // One retry on provider hang: the inner controller scopes the 90 s
        // timeout to a single attempt, while a turn-level abort (new PTT /
        // AGENT_STOP) propagates into it. Provider aborts resolve silently
        // (no onComplete/onError), so the timer's own flag — not the
        // result shape — is what distinguishes timeout from interrupt.
        let stepTimedOut = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          stepTimedOut = false;
          stepResult.text = '';
          stepResult.error = null;
          buffered = '';
          const stepAbort = new AbortController();
          const onTurnAbort = (): void => stepAbort.abort();
          // Already dead before we start: propagate immediately, since an
          // abort listener attached after the fact would never fire and
          // the step would run out its full timeout on a settled turn.
          if (abort.signal.aborted) {
            stepAbort.abort();
          } else {
            abort.signal.addEventListener('abort', onTurnAbort, { once: true });
          }
          const timer = setTimeout(() => {
            stepTimedOut = true;
            stepAbort.abort();
          }, STEP_TIMEOUT_MS);
          try {
            await deps.streamMind(
              stepPrefix +
                (attempt === 1
                  ? basePrompt
                  : `${basePrompt} previous step timed out — emit action tags promptly.`),
              screenshots,
              history,
              'agent',
              stepAbort.signal,
              {
                // Action tags aren't chat content — buffer (don't render)
                // so raw tag syntax never flashes through panel/stream.
                onChunk: (c) => { buffered += c; },
                onComplete: (text) => { stepResult.text = text; },
                onError: (err) => { stepResult.error = err; },
              },
            );
          } finally {
            clearTimeout(timer);
            abort.signal.removeEventListener('abort', onTurnAbort);
          }
          if (!isCurrent()) return;
          if (!stepTimedOut) break;
          console.warn(
            `[Zapi] [${this.id}] agent step ${step} attempt ${attempt} timed out after ${STEP_TIMEOUT_MS}ms`,
          );
        }
        if (stepTimedOut) {
          final = { done: false, failed: true, message: 'model timed out' };
          break;
        }
        if (!isCurrent()) return;
        if (stepResult.error) {
          final = { done: false, failed: true, message: stepResult.error.message };
          break;
        }
        const fullText = stepResult.text || buffered;

        // File blocks come out first and are removed from the text the
        // action parser sees: their content is data, so an [ACT:key:...]
        // inside a script the model just wrote is text, not an action.
        const fileIds: string[] = [];
        for (const file of parseFileTags(fullText)) {
          try {
            const artifact = artifactStore.writeArtifact(this.id, file.filename, file.content);
            fileIds.push(artifact.id);
            runArtifactIds.push(artifact.id);
            console.log(`[Zapi] [${this.id}] artifact → ${artifact.title} (${artifact.kind})`);
          } catch (err) {
            // A rejected filename or a full disk must not kill the run —
            // the model still did the on-screen work.
            console.error(`[Zapi] [${this.id}] artifact write failed:`, err);
          }
        }
        const actions = parseAgentActions(stripFileBlocks(fullText), screenshots);
        // DSL-deaf models (typically OpenAI ones ignoring the prompt's tag
        // grammar) would otherwise chat pleasantly through every step while
        // the driver executes nothing. [ACT:done]/[ACT:fail] parse as
        // actions, so only a truly tag-free reply strikes — and a reply
        // that delivered a file counts as tagged for the same reason.
        if (actions.length === 0 && fileIds.length === 0) {
          taglessStrikes += 1;
          if (taglessStrikes >= MAX_TAGLESS_STRIKES) {
            final = { done: false, failed: true, message: "model isn't emitting actions" };
            break;
          }
        } else {
          taglessStrikes = 0;
        }
        this.emit({ phase: 'acting', step, maxSteps });
        // The signal rides in the hooks object: agent-driver checks it
        // between actions and inside waits, so AGENT_STOP (or a PTT press)
        // actually halts a running batch instead of letting a long
        // [ACT:type] (300 ms per character) play out under the user.
        // onLeaseWait is passed for the driver-side input lease: while
        // this agent is queued behind another agent's physical actions it
        // reports 'waiting' instead of pretending to work.
        const result = await (runAgentActions as unknown as (
          acts: AgentAction[],
          shots: ScreenCapture[],
          h?: {
            onAction?: (info: { x: number; y: number; label: string; kind: AgentAction['kind'] }) => void;
            signal?: AbortSignal;
            onLeaseWait?: (queued: boolean) => void;
          },
        ) => Promise<{ done: boolean; failed: boolean; message: string; executed: string[] }>)(
          actions,
          this.lastScreenshots,
          {
            onAction: (a) => {
              if (isCurrent()) deps.onAction(a);
            },
            signal: abort.signal,
            onLeaseWait: (queued: boolean) => {
              // The grant matters as much as the queue. Handling only
              // `true` left the card reading 'waiting' for the whole
              // batch the driver was already executing — the audit
              // caught it as "stuck on waiting after the lease was
              // granted". `leaseWaitPhase` also swallows the emit when
              // the turn died while queued, so an interrupted run never
              // resurrects itself.
              const phase = leaseWaitPhase(queued, this.status?.phase ?? null, isCurrent());
              if (phase === null) return;
              // Keep whatever the card was last saying rather than
              // blanking the action line on the way back to 'acting'.
              this.emit({
                phase,
                step,
                maxSteps,
                ...(this.status?.message ? { message: this.status.message } : {}),
              });
            },
          },
        );
        if (!isCurrent()) return;

        // Feed the model's own output plus what the driver actually did
        // back as the next slice of history — that's how it learns a
        // click missed or a window didn't open.
        history.push({ role: 'assistant', content: fullText });
        history.push({
          role: 'user',
          content:
            `result: ${result.executed.join('; ') || 'no actions'}` +
            (result.message ? ` — ${result.message}` : ''),
        });
        this.emit({
          phase: 'acting',
          step,
          maxSteps,
          message: result.executed[result.executed.length - 1] ?? result.message,
        });

        if (result.done || result.failed) {
          final = result;
          break;
        }

        // Give the UI a beat to react (window opens, menus settle)
        // before the next screenshot reads the screen.
        await new Promise((r) => setTimeout(r, 700));
      }

      // Ran out of steps without the model declaring done/fail.
      if (!final) {
        final = { done: false, failed: true, message: `hit the step limit (${maxSteps})` };
      }
    } finally {
      this.running = false;
      if (deps.turn.currentAbort() === abort) deps.turn.setAbort(null);
      // A run that was superseded while parked on the lease must not
      // leave its card reading 'waiting' for a queue it is no longer in.
      // The post-loop emit below is gated on isCurrent(), so without
      // this the dead run's card would say 'waiting' forever. Scoped to
      // a card that is actually saying 'waiting' — a live run reaches
      // this finally on the normal done/failed/step-cap path and must
      // not be told it's idle before those emits land.
      if (
        deps.turn.currentTurnId() !== myTurnId &&
        this.status?.phase === 'waiting'
      ) {
        this.emit({ phase: 'idle', step: 0, maxSteps: 0 });
      }
      // stop() aborts without bumping the turn — the run died but no new
      // turn owns the voice state, so release 'acting' here. A PTT
      // interrupt bumps turnId and the new turn sets its own state.
      if (
        deps.turn.currentTurnId() === myTurnId &&
        abort.signal.aborted &&
        deps.turn.voiceState?.() === 'acting'
      ) {
        deps.turn.setVoiceState?.('idle');
      }
    }

    // Loop finished under its own power (done / failed / step cap).
    const cleanSummary =
      (final.message ?? '').replace(TAG_STRIP_REGEX, '').trim() ||
      (final.done ? 'done.' : "couldn't finish that.");

    await deps.recordExchange(task, cleanSummary);
    deps.emitMemoryStats();
    // History and usage land on THIS agent's card, not the default one.
    const entry = chatHistory.append(this.id, {
      userText: task,
      assistantText: cleanSummary,
      kind: 'agent',
      ...(runArtifactIds.length > 0 ? { artifactIds: [...runArtifactIds] } : {}),
    });
    deps.onChatEntryAdded(entry);
    usageStore.recordAgentMessage(this.id);
    analytics.trackAgentRun(stepsRun, final.done);
    // The transcript seeded a stream turn; fill it with the summary.
    deps.onAiResponseChunk(cleanSummary);
    deps.onAiResponseComplete(cleanSummary);

    if (deps.ownsVoice) {
      const audio = await deps.synthesizeSpeech(cleanSummary);
      if (audio && isCurrent()) {
        deps.turn.setVoiceState?.('responding');
        deps.playSpeech(audio);
      }
    }
    if (!isCurrent()) return;
    this.emit({
      phase: final.done ? 'done' : 'failed',
      step: stepsRun,
      maxSteps,
      message: cleanSummary,
    });
    deps.turn.setVoiceState?.('idle');
  }
}

/**
 * Registry of agent runtimes.
 *
 * Runtimes are created lazily and cached per agent id, so a profile the
 * user renamed or archived keeps the same runtime (and its in-flight run)
 * across the change. Physical input is serialized by the driver's input
 * lease; reasoning runs concurrently here.
 */
export class AgentOrchestrator {
  private runtimes = new Map<string, AgentRuntime>();
  /** Builds deps for a runtime; supplied by the owning pipeline. */
  private factory: (id: string) => AgentRuntimeDeps;

  constructor(factory: (id: string) => AgentRuntimeDeps) {
    this.factory = factory;
  }

  /** Cached runtime for `agentId`, created on first use. */
  runtimeFor(agentId: string): AgentRuntime {
    const existing = this.runtimes.get(agentId);
    if (existing) return existing;
    const created = new AgentRuntime(agentId, this.factory(agentId));
    this.runtimes.set(agentId, created);
    return created;
  }

  /** Run a task on behalf of `agentId`. Runtimes are independent. */
  async runTask(agentId: string, task: string): Promise<void> {
    await this.runtimeFor(agentId).run(task);
  }

  /**
   * Stop one agent's run, or every running agent when `agentId` is omitted
   * (the bare AGENT_STOP from the tray/stream has no id to act on).
   */
  stop(agentId?: string): void {
    if (agentId !== undefined) {
      this.runtimes.get(agentId)?.stop();
      return;
    }
    for (const runtime of this.runtimes.values()) {
      if (runtime.isRunning) runtime.stop();
    }
  }

  getStatus(agentId: string): AgentStatus | null {
    return this.runtimes.get(agentId)?.getStatus() ?? null;
  }

  isRunning(agentId: string): boolean {
    return this.runtimes.get(agentId)?.isRunning ?? false;
  }
}

export { LocalTurnControl };
