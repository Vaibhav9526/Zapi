import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic } from './fs-util';
import type {
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  GroqTranscriptionModel,
  TranscriptionProviderType,
  ReasoningDepth,
  ReplyTone,
  StreamVisibility,
  StreamWindowBounds,
  LocalConnection,
  PttMode,
  TtsProvider,
  AgentProfile,
  Routine,
} from '../../shared/types';

/** Id of the always-present default agent. Never archivable. */
export const MAIN_AGENT_ID = 'main';

/**
 * The default profile, mirrored from `DEFAULT_SETTINGS.agents[0]` in the
 * contract. Duplicated rather than imported because the DEFAULTS literal
 * below needs a fresh object per load (mutation of one profile must not
 * leak into the next process start).
 */
const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: MAIN_AGENT_ID,
  name: 'Zapi',
  kaomoji: '(•‿•)',
  color: '#7b4dff',
  createdAt: 0,
  archived: false,
};

/**
 * Ensure the agent list is usable: an array, with 'main' present and
 * unarchived. Pre-multi-agent settings files have no `agents` key at all,
 * and a half-written one may be missing 'main' entirely — both cases
 * would otherwise leave voice turns pointing at a profile that doesn't
 * exist. Repairs in place and reports whether anything changed so the
 * caller can persist the migration.
 */
function normalizeAgents(input: unknown): { agents: AgentProfile[]; changed: boolean } {
  const raw = Array.isArray(input) ? (input as AgentProfile[]) : null;
  const changed = !raw;
  const agents: AgentProfile[] = raw
    ? raw
        .filter((a): a is AgentProfile => !!a && typeof a === 'object' && typeof a.id === 'string')
        .map((a) => ({
          ...a,
          name: typeof a.name === 'string' && a.name ? a.name : 'Agent',
          kaomoji: typeof a.kaomoji === 'string' ? a.kaomoji : '(•‿•)',
          color: typeof a.color === 'string' && a.color ? a.color : '#7b4dff',
          createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
          archived: a.archived === true,
        }))
    : [];

  const main = agents.find((a) => a.id === MAIN_AGENT_ID);
  if (!main) {
    // Pre-multi-agent install (or 'main' was archived by a bad write):
    // re-seed the default profile so voice turns always have a target.
    agents.unshift({ ...DEFAULT_AGENT_PROFILE });
    return { agents, changed: true };
  }
  // 'main' is load-bearing — un-archive it even if a file says otherwise.
  if (main.archived) {
    main.archived = false;
    return { agents, changed: true };
  }
  return { agents, changed };
}

/**
 * Coerce the persisted routines list into well-formed Routine objects.
 * Malformed entries (missing id/task, unknown kind) are dropped rather
 * than carried — a half-written file must not wedge the scheduler on a
 * NaN interval or empty task. Returns `changed` so the caller can
 * persist the repair, matching normalizeAgents' contract.
 */
function normalizeRoutines(input: unknown): { routines: Routine[]; changed: boolean } {
  const raw = Array.isArray(input) ? (input as Routine[]) : null;
  let changed = !raw;
  const routines: Routine[] = (raw ?? [])
    .filter((r): r is Routine => {
      const ok =
        !!r &&
        typeof r === 'object' &&
        typeof r.id === 'string' &&
        typeof r.task === 'string' &&
        (r.kind === 'interval' || r.kind === 'daily');
      if (!ok) changed = true;
      return ok;
    })
    .map((r) => {
      const next = {
        ...r,
        agentId: typeof r.agentId === 'string' && r.agentId ? r.agentId : MAIN_AGENT_ID,
        name: typeof r.name === 'string' ? r.name : '',
        // An interval routine without a positive interval can never be
        // due — store it disabled rather than dropping the user's entry.
        enabled:
          r.enabled === true &&
          (r.kind === 'daily' ||
            (typeof r.intervalMinutes === 'number' && r.intervalMinutes > 0)),
      } as Routine;
      if (next.enabled !== r.enabled) changed = true;
      return next;
    });
  return { routines, changed };
}

/**
 * Simple JSON-file settings store.
 * Avoids the ESM-only `electron-store` v10 compatibility issues.
 */

export interface StoredSettings {
  mindProvider: MindProvider;
  selectedModel: ClaudeModel;
  selectedOpenAIModel: OpenAIModel;
  reasoningDepth: ReasoningDepth;
  replyTone: ReplyTone;

  ttsProvider: TtsProvider;
  voiceId: string;
  fishVoiceId: string;
  voiceSpeed: number;
  voiceStability: number;
  speakReplies: boolean;

  groqTranscriptionModel: GroqTranscriptionModel;
  transcriptionProvider: TranscriptionProviderType;

  isClickyCursorEnabled: boolean;
  launchAtLogin: boolean;
  pushToTalkShortcut: string;
  pttMode: PttMode;
  autoTypeEnabled: boolean;
  streamVisibility: StreamVisibility;
  streamWindowBounds: StreamWindowBounds | null;

  alwaysOnEnabled: boolean;
  dictationEnabled: boolean;
  dictationShortcut: string;
  agentEnabled: boolean;
  agentMaxSteps: number;
  customOpenAIModel: string;
  /** '' = api.openai.com; set to any OpenAI-compatible endpoint (clinepass, proxy). */
  openAIBaseUrl: string;
  /**
   * Named companion agents ("Clickys" model). 'main' is always present
   * and can never be archived — voice turns route there until Phase B's
   * orchestrator introduces per-agent runtimes.
   */
  agents: AgentProfile[];
  /** Scheduled routines owned by agents (interval/daily) — Phase D. */
  routines: Routine[];
  /** When true, routine completions stay silent (no TTS/overlay announce). */
  routinesMuted: boolean;

  localConnections: LocalConnection[];

  onboardingComplete: boolean;
}

const DEFAULTS: StoredSettings = {
  // ClinePass-first per the api-ui plan: new installs land on the
  // OpenAI-compatible provider so the shipped experience works with a
  // single key + endpoint.
  mindProvider: 'openai',
  selectedModel: 'claude-sonnet-4-6',
  selectedOpenAIModel: 'gpt-5',
  reasoningDepth: 'off',
  replyTone: 'friendly',

  voiceId: 'pMsXgVXv3BLzUgSXRplE',
  ttsProvider: 'fishaudio',
  fishVoiceId: '',
  voiceSpeed: 1.0,
  voiceStability: 0.5,
  speakReplies: true,

  groqTranscriptionModel: 'whisper-large-v3-turbo',
  transcriptionProvider: 'groq',

  isClickyCursorEnabled: true,
  launchAtLogin: false,
  pushToTalkShortcut: 'Ctrl+Alt+X',
  // Default to 'toggle' on macOS because Electron's globalShortcut on
  // darwin can't detect key-up; 'hold' would record forever there.
  pttMode: process.platform === 'darwin' ? 'toggle' : 'hold',
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
  agents: [{ ...DEFAULT_AGENT_PROFILE }],
  routines: [],
  routinesMuted: false,

  localConnections: [],

  onboardingComplete: false,
};

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'zapi-settings.json');
}

/**
 * In-memory cache. The settings file is the single source of truth across
 * runs, but within a run we own it — no external writers — so re-reading
 * disk on every `get`/`set` is wasted I/O. We hydrate once on first access
 * and keep the cache in sync with every `set`.
 */
let cache: StoredSettings | null = null;

function readDisk(): StoredSettings {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    const merged = { ...DEFAULTS, ...JSON.parse(raw) } as StoredSettings;
    // Run the agent migration over whatever landed (including DEFAULTS,
    // whose agents array we must not alias into the cache).
    const { agents, changed } = normalizeAgents(merged.agents);
    merged.agents = agents;
    const routines = normalizeRoutines(merged.routines);
    merged.routines = routines.routines;
    merged.routinesMuted = merged.routinesMuted === true;
    // The 'ollama'/local provider was removed from the picker (single
    // ClinePass API section): a value persisted by an older build — or
    // anything else outside the live union — would strand turns on a
    // provider with no UI. Coerce to 'openai' at load so old installs
    // can't strand.
    const providerStale = merged.mindProvider !== 'anthropic' && merged.mindProvider !== 'openai';
    if (providerStale) merged.mindProvider = 'openai';
    if (changed || routines.changed || providerStale) {
      // Persist the seed immediately: otherwise the repair only lives in
      // memory and the next launch re-derives it (harmless, but the file
      // would keep claiming a pre-multi-agent shape).
      try {
        writeFileAtomic(getFilePath(), JSON.stringify(merged, null, 2));
      } catch (err) {
        console.warn('[Zapi] settings agent migration write failed:', err);
      }
    }
    return merged;
  } catch {
    return { ...DEFAULTS, agents: [{ ...DEFAULT_AGENT_PROFILE }] };
  }
}

function ensureLoaded(): StoredSettings {
  if (cache === null) cache = readDisk();
  return cache;
}

function write(data: StoredSettings): void {
  writeFileAtomic(getFilePath(), JSON.stringify(data, null, 2));
}

export function get<K extends keyof StoredSettings>(key: K): StoredSettings[K] {
  return ensureLoaded()[key];
}

export function set<K extends keyof StoredSettings>(key: K, value: StoredSettings[K]): void {
  const data = ensureLoaded();
  data[key] = value;
  // Persist after mutating the cache. If the disk write fails we still
  // have the new value in memory for the rest of the session — the next
  // launch will revert, which matches the previous behavior.
  write(data);
}

export function getAll(): StoredSettings {
  // Shallow copy so callers can't mutate the cache through the returned ref.
  return { ...ensureLoaded() };
}

// ── Agent profiles ──────────────────────────────────────────────────────

/** Every profile, archived included — the panel renders both sections. */
export function listAgents(): AgentProfile[] {
  // Copy the array (not the profiles) so callers can sort/filter freely.
  return [...ensureLoaded().agents];
}

function writeAgents(agents: AgentProfile[]): AgentProfile[] {
  const data = ensureLoaded();
  data.agents = agents;
  write(data);
  return agents;
}

/** Accent colours handed out round-robin so new agents stay distinct. */
const AGENT_COLORS = ['#7b4dff', '#00b8d9', '#ff6b6b', '#f5a623', '#2ecc71', '#e84393'];

export function createAgent(
  name: string,
  kaomoji?: string,
  color?: string,
): AgentProfile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('agent name is required');
  const data = ensureLoaded();
  const profile: AgentProfile = {
    // Time+random rather than randomUUID: this store is dependency-free
    // by design, and the id only needs to be unique within this list.
    id: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: trimmed,
    kaomoji: kaomoji?.trim() || '(•‿•)',
    color: color?.trim() || AGENT_COLORS[data.agents.length % AGENT_COLORS.length],
    createdAt: Date.now(),
    archived: false,
  };
  writeAgents([...data.agents, profile]);
  return profile;
}

export function renameAgent(id: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const agents = ensureLoaded().agents;
  const target = agents.find((a) => a.id === id);
  if (!target) return false;
  target.name = trimmed;
  writeAgents([...agents]);
  return true;
}

/**
 * Archive (never delete) so a task's history and counters stay attached to
 * the profile. Refuses 'main' — the default agent is load-bearing for
 * voice turns and the overlay, and archiving it would strand the app with
 * no agent to route to.
 */
export function archiveAgent(id: string): boolean {
  if (id === MAIN_AGENT_ID) {
    console.warn('[Zapi] refusing to archive the main agent');
    return false;
  }
  const agents = ensureLoaded().agents;
  const target = agents.find((a) => a.id === id);
  if (!target) return false;
  target.archived = true;
  writeAgents([...agents]);
  return true;
}

// ── Routines ────────────────────────────────────────────────────────────

export function listRoutines(): Routine[] {
  return [...ensureLoaded().routines];
}

function writeRoutines(routines: Routine[]): void {
  const data = ensureLoaded();
  data.routines = routines;
  write(data);
}

/**
 * Create (id absent → generated) or update (id present → replace in
 * place) a routine. Unknown ids are treated as creates so the IPC layer
 * never has to branch.
 */
export function upsertRoutine(
  routine: Omit<Routine, 'id'> | Routine,
): Routine {
  const routines = ensureLoaded().routines;
  if ('id' in routine && routine.id) {
    const idx = routines.findIndex((r) => r.id === routine.id);
    const next: Routine = { ...(routine as Routine) };
    if (idx >= 0) {
      // lastRunAt is scheduler-owned state — a panel edit must not wipe
      // the schedule bookkeeping or the routine would fire immediately.
      next.lastRunAt = routines[idx].lastRunAt;
      const out = [...routines];
      out[idx] = next;
      writeRoutines(out);
      return next;
    }
    writeRoutines([...routines, next]);
    return next;
  }
  const created: Routine = {
    ...(routine as Omit<Routine, 'id'>),
    id: `routine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  };
  writeRoutines([...routines, created]);
  return created;
}

export function deleteRoutine(id: string): boolean {
  const routines = ensureLoaded().routines;
  if (!routines.some((r) => r.id === id)) return false;
  writeRoutines(routines.filter((r) => r.id !== id));
  return true;
}

/** Scheduler-owned bookkeeping: stamp the run so the next due-time computes from it. */
export function markRoutineRun(id: string, ts: number): void {
  const routines = ensureLoaded().routines;
  const idx = routines.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const next = [...routines];
  next[idx] = { ...routines[idx], lastRunAt: ts };
  writeRoutines(next);
}

export function setRoutinesMuted(muted: boolean): void {
  set('routinesMuted', muted);
}
