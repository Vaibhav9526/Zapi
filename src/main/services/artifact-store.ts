import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic, sanitizeAgentSegment } from './fs-util';
import { outputDir } from './agent-workspace';
import { MAIN_AGENT_ID } from './settings-store';
import type { Artifact } from '../../shared/types';

/**
 * Local-only index of the files agents have produced. The files
 * themselves live under each agent's workspace `output/` dir (see
 * agent-workspace.ts); this store keeps the metadata (title, kind, size,
 * absolute path) so the UI can show a pile per agent without walking the
 * disk.
 *
 * Rows store ABSOLUTE paths, which is what makes the pre-workspace layout
 * still work: artifacts written by an older install keep their
 * `userData/artifacts/<agentId>/<file>` path and this store reads them
 * back unchanged. Only NEW writes land in the workspace.
 *
 * On-disk shape is `{ [agentId]: Artifact[] }`, newest-first, capped at
 * MAX_PER_AGENT entries per agent. Same cache-then-debounced-atomic-flush
 * pattern as the chat store: reads never touch the file, writes are
 * coalesced, and `flushSync` covers app quit.
 */

const MAX_PER_AGENT = 200;
const FLUSH_DELAY_MS = 400;
/** Windows rejects these as filenames even with an extension attached. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

type ArtifactMap = Record<string, Artifact[]>;

let cache: ArtifactMap | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'zapi-artifacts.json');
}

/**
 * LEGACY artifacts dir, `userData/artifacts/<agentId>/` — where files
 * written before per-agent workspaces existed still live. Kept exported
 * so those rows stay locatable (reveal-in-Explorer on an old artifact,
 * a migration sweep); new writes go to the workspace `output/` dir.
 */
export function artifactsRoot(): string {
  return path.join(app.getPath('userData'), 'artifacts');
}

/** One agent's legacy artifacts dir. See {@link artifactsRoot}. */
export function artifactsDir(agentId: string): string {
  return path.join(artifactsRoot(), sanitizeAgentSegment(agentId));
}

/** Re-exported: the slug rule now lives in fs-util, shared with the
 *  workspace module, but callers have always reached for it here. */
export { sanitizeAgentSegment };

/**
 * Turn a model-supplied filename into a safe bare name. Total function:
 * every input, including `''`, `'..'`, `'CON.txt'`, a 4 kB name, or a
 * name in a script the character map doesn't cover, produces something
 * writable — writeArtifact must never throw a filename back at the user.
 *
 * Everything before the last path separator is discarded rather than
 * escaped: a name carrying `../` or `..\` is either the model miscounting
 * or an escape attempt, and keeping only the final segment is the one
 * transformation where traversal cannot survive. Spaces collapse to
 * dashes (kebab-case is what the prompt asks for), illegal characters go
 * too, the stem is length-capped for Windows' 255-char limit, and
 * Windows device names get a prefix so `CON.csv` is writable.
 *
 * The extension is sliced off BEFORE the character map, not after: a
 * name whose stem is entirely non-ASCII (`预算表.csv`) would otherwise
 * sanitize down to a bare `csv` and lose the only part that said
 * anything about the file. Slicing first keeps it as `untitled.csv`.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // Split on the LAST dot only, so `report.2024.csv` keeps both
  // extensions; a leading dot is not a split point (`.hidden` is a
  // hidden-file attempt, handled by the stem sweep below).
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';
  const stemSource = dot > 0 ? base.slice(0, dot) : base;
  const stem = stemSource
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '');
  const safeExt = /^[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const safeStem = stem || 'untitled';
  const name = safeExt ? `${safeStem}.${safeExt}` : safeStem;
  // Device names are reserved *with* an extension too — Win32 opens
  // `con.csv` as the console device — so the check is against the first
  // dot-segment of the finished name, not the stem. That also catches the
  // case where an unusable extension was dropped and left `con.csv`
  // behind as the stem.
  const deviceBase = name.split('.')[0];
  return WINDOWS_RESERVED.test(deviceBase) ? `file-${name}` : name;
}

/**
 * Extension → broad kind. Held as one set per kind because this list IS
 * the rule documented in AGENT_PROMPT (csv/xlsx → sheet, md/txt → doc,
 * png/svg → image, js/py/ts → code): grouping it that way keeps the two
 * in sync by eye instead of hiding the mapping in an alphabetical dump.
 */
const SHEET_EXT = ['csv', 'tsv', 'xls', 'xlsx', 'ods'];
const DOC_EXT = ['md', 'markdown', 'txt', 'log', 'rtf', 'pdf', 'docx'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const CODE_EXT = [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'sh', 'bash', 'ps1',
  'bat', 'cmd', 'html', 'htm', 'css', 'sql', 'yml', 'yaml', 'toml', 'xml',
  'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'swift', 'kt',
];

/** Broad kind for icons, inferred from the extension (the model doesn't
 *  get to declare it — a .csv it hallucinated is still a sheet). */
export function inferKind(filename: string): Artifact['kind'] {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (SHEET_EXT.includes(ext)) return 'sheet';
  if (DOC_EXT.includes(ext)) return 'doc';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (CODE_EXT.includes(ext)) return 'code';
  return 'other';
}

function readFromDisk(): ArtifactMap {
  const map: ArtifactMap = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        // Only well-formed rows survive: a half-written entry would render
        // as an empty pile item the user can neither open nor explain.
        map[agentId] = (value as Artifact[]).filter(
          (a): a is Artifact =>
            !!a && typeof a === 'object' &&
            typeof (a as Artifact).id === 'string' &&
            typeof (a as Artifact).path === 'string',
        );
      }
    }
  } catch {
    return {};
  }
  return map;
}

function ensureCache(): ArtifactMap {
  if (cache === null) cache = readFromDisk();
  return cache;
}

function flushNow(): void {
  if (cache === null) return;
  try {
    writeFileAtomic(getFilePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[Zapi] artifact index flush failed:', err);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY_MS);
}

/** Newest-first. Sorting on read (rather than trusting the file's order)
 *  keeps the contract true for a hand-edited or pre-1.x index too. */
function newestFirst(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * One agent's artifacts, or every agent's merged pile when `agentId` is
 * omitted (the panel's global "All files" view). Always newest-first and
 * always a copy — callers reorder/filter without corrupting the cache.
 */
export function list(agentId?: string): Artifact[] {
  const map = ensureCache();
  if (agentId !== undefined) return newestFirst(map[agentId] ?? []);
  return newestFirst(Object.values(map).flat());
}

/** Artifact by id across every agent, or null when it is gone. */
export function byId(id: string): Artifact | null {
  for (const artifacts of Object.values(ensureCache())) {
    const hit = artifacts.find((a) => a.id === id);
    if (hit) return { ...hit };
  }
  return null;
}

/** Artifact minus the fields the store owns. */
export type NewArtifact = Omit<Artifact, 'id' | 'createdAt'> &
  Partial<Pick<Artifact, 'id' | 'createdAt'>>;

let idCounter = 0;

/** Monotonic-ish, collision-free within a process and readable in the file. */
function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record an artifact. `id`/`createdAt` are stamped unless the caller
 * supplies them (the parser/import path may already have them). Newest
 * entry goes to the front and the per-agent list is trimmed to
 * MAX_PER_AGENT — old files stay on disk, they just stop being listed.
 */
export function add(artifact: NewArtifact): Artifact {
  const full: Artifact = {
    ...artifact,
    id: artifact.id ?? newId(),
    createdAt: artifact.createdAt ?? Date.now(),
  };
  const map = ensureCache();
  const arr = map[full.agentId] ?? (map[full.agentId] = []);
  arr.unshift(full);
  if (arr.length > MAX_PER_AGENT) arr.length = MAX_PER_AGENT;
  scheduleFlush();
  return { ...full };
}

/** Next free path in `dir` for `name`, so a re-run of the same task
 *  produces `name-2.csv` rather than silently overwriting a deliverable
 *  the user may have already opened or edited. The numeric walk gives up
 *  after 999 tries and falls back to a clock-stamped name, so this
 *  returns a *free* path unconditionally instead of handing back an
 *  occupied one at the end of the range. */
function uniquePath(dir: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = path.join(dir, name);
  for (let n = 2; n < 1000 && fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  if (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${Date.now().toString(36)}${ext}`);
  }
  return candidate;
}

/**
 * Write a model-produced file into the agent's workspace `output/` dir and
 * record it. This is the single entry point the turn pipeline uses — it
 * sanitizes the name, keeps the resolved path inside that dir (belt and
 * braces on top of sanitizeFilename), writes atomically, and returns the
 * Artifact the chat entry can point at.
 *
 * Files land in the workspace (not the legacy artifacts dir) so a
 * deliverable, its scratch files, and the agent's AGENTS.md sit side by
 * side in one folder the user can actually find. Rows from before this
 * change keep their old absolute paths and still resolve.
 *
 * `content` is written verbatim; the caller (the [FILE:] parser) owns
 * the newline handling.
 */
export function writeArtifact(
  agentId: string = MAIN_AGENT_ID,
  filename: string,
  content: string,
): Artifact {
  const dir = outputDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniquePath(dir, sanitizeFilename(filename));
  // The sanitizer already guarantees a bare name; this asserts it rather
  // than trusting it, because a single escaped filename would otherwise
  // put userData-adjacent files in reach of a model reply.
  if (path.dirname(path.resolve(target)) !== path.resolve(dir)) {
    throw new Error(`refusing artifact path outside ${dir}: ${filename}`);
  }
  writeFileAtomic(target, content);
  return add({
    agentId,
    title: path.basename(target),
    path: target,
    kind: inferKind(target),
    size: Buffer.byteLength(content, 'utf-8'),
  });
}

/** Synchronous flush — call on app will-quit to avoid losing pending writes. */
export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
}
