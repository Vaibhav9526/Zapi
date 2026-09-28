import type { Suggestion } from '../../shared/types';

/**
 * Proactive task cards. Given each agent's recent chat, ask the user's
 * Mind for a handful of concrete follow-up tasks that agent could run on
 * its own, then parse the reply into `Suggestion[]`.
 *
 * The engine is deliberately stateless and side-effect free: it builds a
 * prompt, makes one completion per agent, and hands the cards back. The
 * caller (the SUGGESTION_REFRESH IPC handler) decides what to persist —
 * that keeps this file testable without Electron and lets the panel
 * preview a refresh before it lands on disk.
 */

/** Cards per agent per refresh. */
export const DEFAULT_CAP_PER_AGENT = 5;
/** How many recent chat exchanges feed the prompt per agent. */
const DEFAULT_CHAT_DEPTH = 8;
/** Hard ceiling on a single chat line included in the prompt. */
const MAX_LINE_CHARS = 160;

export interface SuggestionAgentInput {
  id: string;
  name?: string;
}

/** One past exchange; only the user side is required. */
export interface SuggestionChatLine {
  userText: string;
  assistantText?: string;
}

export interface GenerateSuggestionsDeps {
  /** Every active agent profile. */
  agents: SuggestionAgentInput[];
  /** Recent chat per agent id, oldest first. An agent with no history is
   *  skipped — with nothing to build on, any card would be invention. */
  recentChats: Record<string, SuggestionChatLine[]>;
  /** Single-shot text completion against the configured Mind. Resolves
   *  the raw reply; the engine does the JSON salvage. */
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  capPerAgent?: number;
  maxChatsPerAgent?: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Phrases that mark an unfinished thread. A question mark alone is far too
 * common (most chat lines are questions), so the open-loop signal is a
 * specific deferral / follow-up / todo construction.
 */
const OPEN_LOOP_RE =
  /\b(?:later|next (?:step|time|week|month)|after (?:that|this)|follow[- ]?up|still (?:need|owe|have to|want)|don'?t forget|remind me|todo|to-do|left to|unfinished|finish(?:ed)? (?:the|that)|pick (?:that|it) up|come back to|haven'?t (?:done|finished))\b/i;

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();

function clip(s: string, max = MAX_LINE_CHARS): string {
  const t = tidy(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Topics (recent user asks) and probable open loops, oldest-first input. */
export function summarizeChats(
  lines: SuggestionChatLine[],
  maxLines = DEFAULT_CHAT_DEPTH,
): { topics: string[]; openLoops: string[] } {
  const recent = lines.slice(-Math.max(1, maxLines));
  const topics: string[] = [];
  const openLoops: string[] = [];
  for (const line of recent) {
    const ask = clip(line?.userText ?? '');
    if (!ask) continue;
    topics.push(ask);
    if (OPEN_LOOP_RE.test(line.userText ?? '')) openLoops.push(ask);
  }
  return { topics, openLoops };
}

/**
 * The per-agent prompt. Compact by construction: the model is asked for
 * machine-readable JSON and nothing else, and the chat digest is clipped
 * hard, because a long transcript makes a small local model drift into
 * prose instead of JSON.
 */
export function buildSuggestionPrompt(
  agent: SuggestionAgentInput,
  chats: SuggestionChatLine[],
  capPerAgent: number = DEFAULT_CAP_PER_AGENT,
  maxChatsPerAgent: number = DEFAULT_CHAT_DEPTH,
): string {
  const name = agent.name?.trim() || agent.id;
  const { topics, openLoops } = summarizeChats(chats, maxChatsPerAgent);
  const lines = [
    `you are writing task cards for the desktop assistant "${name}".`,
    '',
    'recent topics this assistant covered with the user:',
    ...(topics.length ? topics.map((t) => `- ${t}`) : ['- (no history yet)']),
    '',
    'threads that look unfinished (deferrals, "next time", todos):',
    ...(openLoops.length ? openLoops.map((t) => `- ${t}`) : ['- (none detected)']),
    '',
    `propose at most ${capPerAgent} tasks "${name}" could do next on its own, based only on the above.`,
    'each task is one concrete action the user could accept with a single click, phrased as an instruction to the assistant.',
    'return ONLY a json array, no prose and no code fence:',
    '[{"title":"short card title","task":"the instruction to run","reason":"why now, in a few words"}]',
    'rules:',
    '- no card that merely repeats a finished task from the topics list',
    '- no destructive or irreversible action (delete, send, publish, purchase)',
    '- title under 60 characters, lowercase, no trailing punctuation',
    '- return [] when nothing worthwhile is left to do',
  ];
  return lines.join('\n');
}

/**
 * Salvage a JSON array of cards out of a model reply.
 *
 * Models wrap JSON in fences, prefix it with "here you go:", trail it
 * with a sentence, emit a single object instead of an array, or leave a
 * trailing comma — all cheap to tolerate and all fatal to `JSON.parse`,
 * so each is handled explicitly rather than trusting the reply to be
 * well-formed. `task` is the only required field: a card without an
 * instruction can't be accepted, and the key is aliased across the names
 * models actually reach for.
 */
export function parseSuggestionJson(
  raw: string,
  agentId: string,
  opts: { capPerAgent?: number; now?: () => number } = {},
): Suggestion[] {
  const cap = Math.max(0, opts.capPerAgent ?? DEFAULT_CAP_PER_AGENT);
  if (cap === 0) return [];
  const now = opts.now ?? Date.now;

  const candidates = jsonCandidates(raw);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed === null) continue;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const out: Suggestion[] = [];
    for (const item of items) {
      const card = toSuggestion(item, agentId, now());
      if (card) out.push(card);
      if (out.length >= cap) break;
    }
    // A parse that yields nothing usable (e.g. `[1,2,3]`) is treated as a
    // miss so a later, better-shaped candidate can still win.
    if (out.length > 0) return out;
  }
  return [];
}

/** Progressively looser readings of the reply, best first. */
function jsonCandidates(raw: string): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  const out: string[] = [];
  // Fenced block, ```json or bare ```.
  const fence = /```(?:json|javascript|js)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) out.push(fence[1].trim());
  // Prose around the payload: first '[' to last ']', first '{' to last '}'.
  const lb = text.indexOf('[');
  const rb = text.lastIndexOf(']');
  if (lb !== -1 && rb > lb) out.push(text.slice(lb, rb + 1));
  const lo = text.indexOf('{');
  const ro = text.lastIndexOf('}');
  if (lo !== -1 && ro > lo) out.push(`[${text.slice(lo, ro + 1)}]`);
  out.push(text);
  return out.filter(Boolean);
}

/** `JSON.parse` plus the two malformations models actually produce. */
function tryParse(candidate: string): unknown {
  const attempts = [
    candidate,
    // Smart quotes around keys/values.
    candidate.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"),
    // Trailing comma before a closing bracket.
    candidate.replace(/,\s*([\]}])/g, '$1'),
  ];
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt);
      if (value !== null && typeof value === 'object') return value;
    } catch {
      /* try the next reading */
    }
  }
  return null;
}

const pickString = (item: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === 'string' && tidy(v)) return tidy(v);
  }
  return '';
};

let idCounter = 0;

function toSuggestion(item: unknown, agentId: string, now: number): Suggestion | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const task = pickString(obj, ['task', 'instruction', 'prompt', 'action', 'command']);
  if (!task) return null;
  const title = clip(pickString(obj, ['title', 'name', 'headline', 'label']), 60);
  if (!title) return null;
  idCounter = (idCounter + 1) % 1e6;
  return {
    id: `${now.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // Always the prompted agent: a reply that names some other id is a
    // hallucination, and misfiling the card would run the task elsewhere.
    agentId,
    title,
    task: clip(task, 400),
    reason: clip(pickString(obj, ['reason', 'why', 'because', 'rationale']), 200) || undefined,
    createdAt: now,
    dismissed: false,
  };
}

/**
 * Ask the Mind for follow-up cards, one completion per agent that has
 * chat history. Per-agent failures are swallowed into an empty card list:
 * a rate-limited or offline provider should leave the other agents'
 * cards in place, not blank the whole pile.
 *
 * Returns every card across agents, grouped in the order the agents were
 * given (newest agent first is the caller's business — the store sorts).
 */
export async function generateSuggestions(
  deps: GenerateSuggestionsDeps,
): Promise<Suggestion[]> {
  const cap = Math.max(0, deps.capPerAgent ?? DEFAULT_CAP_PER_AGENT);
  const now = deps.now ?? Date.now;
  const perAgent = await Promise.all(
    deps.agents.map(async (agent) => {
      const chats = deps.recentChats?.[agent.id] ?? [];
      if (chats.length === 0) return [] as Suggestion[];
      if (deps.signal?.aborted) return [] as Suggestion[];
      const prompt = buildSuggestionPrompt(
        agent,
        chats,
        cap,
        deps.maxChatsPerAgent ?? DEFAULT_CHAT_DEPTH,
      );
      try {
        const raw = await deps.complete(prompt, deps.signal);
        return parseSuggestionJson(raw, agent.id, { capPerAgent: cap, now });
      } catch (err) {
        console.warn(`[Zapi] suggestions: ${agent.id} generation failed:`, err);
        return [] as Suggestion[];
      }
    }),
  );
  return perAgent.flat();
}
