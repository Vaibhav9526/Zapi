import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic, sanitizeAgentSegment } from './fs-util';

/**
 * Per-agent workspace: a folder the agent owns for the rest of its life.
 *
 *   userData/workspaces/<slug>/
 *     AGENTS.md      identity + memory, re-injected into the prompt
 *     output/        deliverables the agent produced
 *     tmp/           scratch space for intermediates
 *
 * This is the HeyClicky workspace idea adapted to our much smaller
 * surface: there is no skill routing and no MCP layer here, just "the
 * agent's files live in one findable place and the agent can remember
 * things between runs". `AGENTS.md` is the durable part — the model
 * writes it with `[MEMO:...]` tags, we append dated lines under
 * `## Notes`, and `readMemory` hands the file back to be injected as
 * prompt context.
 *
 * Everything here is total: a missing workspace is scaffolded, a missing
 * or empty memory file reads as `''`, and a failed write returns false
 * instead of throwing into a turn. Memory is a nicety; it must never be
 * the reason a task fails.
 */

const MEMORY_FILE = 'AGENTS.md';
/** Memory is injected into every step's prompt — cap it so it can't crowd
 *  out the actual task or the screenshots. */
const MAX_MEMORY_CHARS = 4096;
/** Dated note lines kept under `## Notes`; oldest are dropped. */
const MAX_NOTE_LINES = 40;
/** One fact is one line in the prompt sense, not an essay. */
const MAX_FACT_CHARS = 200;
/** Heading text we own. Matched case-insensitively so a hand-edit to
 *  `## notes` doesn't orphan the section. */
const NOTES_HEADING = /^##\s+notes\s*$/i;
const ANY_HEADING = /^##\s+/;
/** A note line is a dated bullet; the date is what makes pruning by age
 *  possible, so a line that isn't shaped like one is left alone. */
const NOTE_LINE = /^-\s+\d{4}-\d{2}-\d{2}:\s/;

/** The slice of an agent profile the workspace needs. Structural on
 *  purpose: an `AgentProfile` from settings-store satisfies it as-is. */
export interface WorkspaceProfile {
  name?: string;
  /** One-line remit, shown under the title. */
  role?: string;
}

export interface AgentWorkspace {
  /** Sanitized agent id — the on-disk folder name. */
  slug: string;
  dir: string;
  outputDir: string;
  tmpDir: string;
  memoryPath: string;
  /** True when this call created AGENTS.md (dirs may already exist). */
  created: boolean;
}

/** `userData/workspaces` — the root every agent workspace lives under. */
export function workspacesRoot(): string {
  return path.join(app.getPath('userData'), 'workspaces');
}

/** The workspace folder for an agent, from its id or profile name. */
export function workspaceDir(agentId: string): string {
  return path.join(workspacesRoot(), sanitizeAgentSegment(agentId));
}

/** Where deliverables go. Also the artifact store's write target. */
export function outputDir(agentId: string): string {
  return path.join(workspaceDir(agentId), 'output');
}

/** Scratch space, kept separate so `output/` stays a clean deliverable pile. */
export function tmpDir(agentId: string): string {
  return path.join(workspaceDir(agentId), 'tmp');
}

/** The agent's identity + memory file. */
export function memoryPath(agentId: string): string {
  return path.join(workspaceDir(agentId), MEMORY_FILE);
}

function today(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * The scaffold. Identity header first, then the two sections the model
 * is allowed to write into — `## Notes` for dated facts, `## Standing
 * preferences` for things the user told it to always do. The header is
 * ours: `appendMemo` only ever touches the Notes section, so a model's
 * writes can't rewrite who the agent is.
 */
function scaffold(profile?: WorkspaceProfile): string {
  const name = (profile?.name ?? '').trim() || 'Agent';
  const role = (profile?.role ?? '').trim() || 'screen-aware desktop agent for this profile';
  return [
    `# ${name} — Zapi agent`,
    '',
    `role: ${role}`,
    '',
    '## Notes',
    '',
    '## Standing preferences',
    '',
  ].join('\n');
}

/**
 * Make sure the workspace exists: `output/`, `tmp/`, and an `AGENTS.md`
 * to write memory into. Idempotent — an existing AGENTS.md is never
 * rewritten, because that file is the agent's memory and the whole point
 * of calling this is to preserve it.
 */
export function ensureWorkspace(
  agentId: string,
  profile?: WorkspaceProfile,
): AgentWorkspace {
  const dir = workspaceDir(agentId);
  const out = path.join(dir, 'output');
  const tmp = path.join(dir, 'tmp');
  const mem = path.join(dir, MEMORY_FILE);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  let created = false;
  if (!fs.existsSync(mem)) {
    try {
      writeFileAtomic(mem, scaffold(profile));
      created = true;
    } catch (err) {
      // A workspace we can't write is a degraded agent, not a broken
      // one: files still land in output/ and the turn still runs.
      console.warn('[Zapi] workspace scaffold failed:', err);
    }
  }
  return { slug: path.basename(dir), dir, outputDir: out, tmpDir: tmp, memoryPath: mem, created };
}

/**
 * The agent's memory, ready to inject as prompt context. Line-aligned
 * truncation at MAX_MEMORY_CHARS (never mid-line, so the prompt never
 * ends in a half-sentence the model might act on). Returns '' when the
 * workspace was never created or the file is unreadable.
 */
export function readMemory(agentId: string): string {
  const mem = memoryPath(agentId);
  let raw: string;
  try {
    raw = fs.readFileSync(mem, 'utf-8');
  } catch {
    return '';
  }
  if (raw.length <= MAX_MEMORY_CHARS) return raw;
  const head = raw.slice(0, MAX_MEMORY_CHARS);
  const lastBreak = head.lastIndexOf('\n');
  return lastBreak > 0 ? head.slice(0, lastBreak) : head;
}

/** One fact → one dated bullet. Newlines collapse (a fact is a line),
 *  a leading list marker is stripped (so a caller — or a model echoing
 *  one back — can't forge the file's structure, and pure-punctuation
 *  junk like '- - -' rejects instead of being stored), and length is
 *  capped to keep the file curated. A '-' that is part of a value
 *  ('-5 degrees tonight') survives, because only a marker followed by
 *  whitespace or end-of-string counts as a marker. */
function normalizeFact(fact: string): string {
  const flat = String(fact ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cleaned = /^[-*](\s|$)/.test(flat) ? flat.replace(/^(?:[-*][-\s*]*)+/, '') : flat;
  if (!cleaned) return '';
  return cleaned.length > MAX_FACT_CHARS ? `${cleaned.slice(0, MAX_FACT_CHARS - 1)}…` : cleaned;
}

/**
 * Append one durable fact to `## Notes` as `- YYYY-MM-DD: <fact>` and
 * keep the section to the newest MAX_NOTE_LINES bullets.
 *
 * Returns true when a line was added. False is a normal outcome, not an
 * error: the fact was empty, or it is already in the file (a model
 * repeating a memo every step must not fill the file with copies of the
 * same line).
 */
export function appendMemo(agentId: string, fact: string, profile?: WorkspaceProfile): boolean {
  const text = normalizeFact(fact);
  if (!text) return false;

  // Scaffold on demand so a caller that only wants to write a memo (the
  // agent loop, mid-run) doesn't have to remember to ensure first.
  ensureWorkspace(agentId, profile);
  const mem = memoryPath(agentId);

  let lines: string[];
  try {
    lines = fs.readFileSync(mem, 'utf-8').split(/\r?\n/);
  } catch (err) {
    console.warn('[Zapi] memory append: cannot read AGENTS.md:', err);
    return false;
  }

  const bullet = `- ${today()}: ${text}`;
  const heading = lines.findIndex((l) => NOTES_HEADING.test(l));
  if (heading === -1) {
    // No Notes section (hand-edited file, or a half-written one): add it
    // rather than dropping the fact on the floor.
    lines.push('', '## Notes', '', bullet, '');
    return writeMemory(mem, lines.join('\n'));
  }
  const nextHeading = lines.findIndex((l, i) => i > heading && ANY_HEADING.test(l));
  const end = nextHeading === -1 ? lines.length : nextHeading;
  const section = lines.slice(heading + 1, end);

  const notes = section.filter((l) => NOTE_LINE.test(l));
  if (notes.includes(bullet)) return false;
  notes.push(bullet);
  const kept = notes.length > MAX_NOTE_LINES ? notes.slice(notes.length - MAX_NOTE_LINES) : notes;
  // Normalize the section's internal spacing: one blank line under the
  // heading, one before the next heading. Only the Notes section is
  // rewritten — `## Standing preferences` and the header are untouched.
  lines.splice(heading + 1, end - heading - 1, '', ...kept, '');
  return writeMemory(mem, lines.join('\n'));
}

function writeMemory(mem: string, content: string): boolean {
  try {
    writeFileAtomic(mem, content);
    return true;
  } catch (err) {
    console.warn('[Zapi] memory append: cannot write AGENTS.md:', err);
    return false;
  }
}
