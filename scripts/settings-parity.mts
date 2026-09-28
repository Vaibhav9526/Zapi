/**
 * Settings contract check.
 *
 * Verifies the settings surface stays consistent across the four files
 * that define it. Static check: it parses the sources with a
 * brace-matching reader (comment/string aware) rather than a real TS AST,
 * which is plenty for `interface` bodies and string-literal const maps.
 *
 *   1. StoredSettings  <->  FlickySettings  field-name parity (both ways)
 *   2. Defaults coverage of every non-optional StoredSettings field
 *   3. Every IPC.SET_* channel is wired to a handler in src/main/index.ts
 *   4. Every preload `setXxx` method maps to an IPC channel that exists
 *
 * Run:  bun scripts/settings-parity.mts   (or: npx tsx scripts/settings-parity.mts)
 *
 * EXIT CODE: findings are the point of this script, so a non-zero exit
 * means the *script itself* could not do its job (a file went missing, a
 * declaration it parses could not be found) — not that the app has drift.
 * Drift is reported as FAIL lines plus a findings list, and exits 0.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p: string): string => path.join(ROOT, p);

const FILES = {
  store: 'src/main/services/settings-store.ts',
  types: 'src/shared/types.ts',
  main: 'src/main/index.ts',
  preload: 'src/preload/index.ts',
} as const;

// ── output helpers ────────────────────────────────────────────────────
type Finding = { check: string; message: string; severity: 'error' | 'note' };
const findings: Finding[] = [];

function finding(check: string, message: string, severity: 'error' | 'note' = 'error'): void {
  findings.push({ check, message, severity });
}

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown): boolean {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
  return cond;
}

/** Hard failure: the script cannot proceed. Bails with exit 1. */
function die(message: string): never {
  console.error(`\nFATAL ${message}`);
  process.exit(1);
}

function read(relPath: string): string {
  const abs = rel(relPath);
  if (!fs.existsSync(abs)) die(`missing source file: ${relPath}`);
  const src = fs.readFileSync(abs, 'utf-8');
  if (src.trim() === '') die(`empty source file: ${relPath}`);
  return src;
}


// ── brace-matching reader (comment + string aware) ────────────────────
/**
 * Find the `{ ... }` body starting at/after `startIdx`. Returns inner text.
 * Skips // and block comments plus ', ", ` literals so braces inside doc
 * comments or strings don't throw the depth count off.
 */
function readBraceBody(src: string, startIdx: number): string {
  const open = src.indexOf('{', startIdx);
  if (open === -1) die('no opening brace found while reading body');

  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        // Template literals just scan to the closing backtick; good enough
        // for field-name extraction.
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
    i++;
  }
  die('unbalanced braces while reading body');
}

/** Locate `interface <Name>` (optionally exported) and read its body. */
function interfaceBody(src: string, name: string, fileLabel: string): string {
  const m = new RegExp(`(?:export\\s+)?interface\\s+${name}\\b`).exec(src);
  if (!m) die(`could not find interface ${name} in ${fileLabel}`);
  return readBraceBody(src, m.index);
}

/** Locate `const <name> ... =` (optionally exported) and read its body. */
function constBody(src: string, name: string, fileLabel: string): string {
  const m = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=`).exec(src);
  if (!m) die(`could not find const ${name} in ${fileLabel}`);
  return readBraceBody(src, m.index + m[0].length - 1);
}

/** Strip comments so field scans don't pick up prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `name: Type;` fields of an interface body, with optionality. */
function interfaceFields(body: string): Map<string, { optional: boolean; type: string }> {
  const out = new Map<string, { optional: boolean; type: string }>();
  for (const rawLine of stripComments(body).split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('*') || line.startsWith('//')) continue;
    const m = /^([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*(\?)?\s*:\s*(.+?);?\s*$/.exec(line);
    if (!m) continue;
    out.set(m[1].replace(/^['"]|['"]$/g, ''), {
      optional: m[2] === '?',
      type: m[3].replace(/;$/, '').trim(),
    });
  }
  return out;
}

/** `KEY: 'value',` entries of a const object literal. */
function stringMapEntries(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of stripComments(body).split('\n')) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"]*)\2\s*,?$/.exec(rawLine.trim());
    if (m) out.set(m[1], m[3]);
  }
  return out;
}

/** `KEY: <any expression>,` entries — for presence-only coverage. */
function objectKeys(body: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of stripComments(body).split('\n')) {
    const m = /^([A-Za-z_$][\w$]*|'[^']+')\s*:\s*(.+?)\s*,?\s*$/.exec(rawLine.trim());
    if (m) out.add(m[1].replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

const sorted = (it: Iterable<string>): string[] => [...it].sort((a, b) => a.localeCompare(b));
const fmt = (xs: string[]): string => (xs.length === 0 ? '(none)' : xs.join(', '));


// ── load sources ──────────────────────────────────────────────────────
const storeSrc = read(FILES.store);
const typesSrc = read(FILES.types);
const mainSrc = read(FILES.main);
const preloadSrc = read(FILES.preload);

const storedFields = interfaceFields(interfaceBody(storeSrc, 'StoredSettings', FILES.store));
const rendererFields = interfaceFields(interfaceBody(typesSrc, 'FlickySettings', FILES.types));
const ipcChannels = stringMapEntries(constBody(typesSrc, 'IPC', FILES.types));

if (storedFields.size === 0) die('StoredSettings parsed to 0 fields (parser bug?)');
if (rendererFields.size === 0) die('FlickySettings parsed to 0 fields (parser bug?)');
if (ipcChannels.size === 0) die('IPC parsed to 0 channels (parser bug?)');

console.log(
  `parsed: StoredSettings=${storedFields.size} FlickySettings=${rendererFields.size} ` +
    `IPC=${ipcChannels.size}\n`,
);

// ── 1. field-name parity ──────────────────────────────────────────────
const missingInRenderer = sorted(storedFields.keys()).filter((k) => !rendererFields.has(k));
const missingInStored = sorted(rendererFields.keys()).filter((k) => !storedFields.has(k));

// Runtime-derived fields: computed per-call by main, never persisted, so
// they are legitimately FlickySettings-only. Kept as a named list so a new
// one must be classified on purpose rather than ignored silently.
const RUNTIME_ONLY = new Set(['apiKeyStatus', 'encryptionAvailable']);

const unexpectedStoredOnly = missingInRenderer;
const rendererOnly = missingInStored;
const expectedRuntimeOnly = rendererOnly.filter((k) => RUNTIME_ONLY.has(k));
const unexpectedRendererOnly = rendererOnly.filter((k) => !RUNTIME_ONLY.has(k));
// A new field that isn't on the RUNTIME_ONLY list is drift: it either needs
// persisting, or it needs classifying as runtime-derived on purpose.
const drift = [...unexpectedStoredOnly, ...unexpectedRendererOnly];

const parityOk = check(
  drift.length === 0,
  'check 1: StoredSettings <-> FlickySettings field parity',
  { storedOnly: unexpectedStoredOnly, rendererOnly: unexpectedRendererOnly },
);

for (const k of unexpectedStoredOnly) {
  finding('1-parity', `StoredSettings.${k} has no FlickySettings counterpart (never reaches the renderer)`);
}
for (const k of unexpectedRendererOnly) {
  finding('1-parity', `FlickySettings.${k} is not persisted in StoredSettings`);
}
if (!parityOk) {
  console.log(`  stored-only : ${fmt(unexpectedStoredOnly)}`);
  console.log(`  renderer-only : ${fmt(unexpectedRendererOnly)}`);
}
if (expectedRuntimeOnly.length > 0) {
  console.log(`  note: runtime-derived, never persisted: ${fmt(expectedRuntimeOnly)}`);
}

// ── 2. defaults coverage ──────────────────────────────────────────────
// Two defaults objects exist; both are checked:
//   settings-store.ts -> DEFAULTS         (typed StoredSettings, lands on disk)
//   shared/types.ts   -> DEFAULT_SETTINGS  (typed FlickySettings, renderer seed)
const required = sorted(storedFields.keys()).filter((k) => !storedFields.get(k)!.optional);
const optional = sorted(storedFields.keys()).filter((k) => storedFields.get(k)!.optional);

function coverage(constName: string, keys: Set<string>, label: string): void {
  const gaps = required.filter((k) => !keys.has(k));
  const extras = sorted(keys).filter((k) => !storedFields.has(k));
  check(gaps.length === 0, `check 2: ${constName} covers every non-optional StoredSettings field`, { gaps });
  for (const g of gaps) finding('2-defaults', `${label} ${constName} missing default for StoredSettings.${g}`);
  for (const e of extras) finding('2-defaults', `${label} ${constName}.${e} is not a StoredSettings field`, 'note');
  if (gaps.length > 0) console.log(`  missing: ${fmt(gaps)}`);
}

coverage('DEFAULTS (settings-store.ts)', objectKeys(constBody(storeSrc, 'DEFAULTS', FILES.store)), 'persisted:');
coverage(
  'DEFAULT_SETTINGS (shared/types.ts)',
  objectKeys(constBody(typesSrc, 'DEFAULT_SETTINGS', FILES.types)),
  'renderer:',
);

if (optional.length > 0) {
  console.log(`  note: optional StoredSettings fields need no default: ${fmt(optional)}`);
}

// ── 3. IPC.SET_* wiring in main ────────────────────────────────────────
const setChannels = sorted(ipcChannels.keys()).filter((k) => k.startsWith('SET_'));
if (setChannels.length === 0) die('no IPC.SET_* channels found (parser bug?)');

const mainFlat = stripComments(mainSrc);
const wired: string[] = [];
const handleOnly: string[] = [];
const unwired: string[] = [];

for (const key of setChannels) {
  const onRef = new RegExp(`ipcMain\\s*\\.\\s*on\\s*\\(\\s*IPC\\s*\\.\\s*${key}\\b`);
  const handleRef = new RegExp(`ipcMain\\s*\\.\\s*handle\\s*\\(\\s*IPC\\s*\\.\\s*${key}\\b`);
  if (onRef.test(mainFlat)) wired.push(key);
  else if (handleRef.test(mainFlat)) handleOnly.push(key);
  else if (new RegExp(`IPC\\s*\\.\\s*${key}\\b`).test(mainFlat)) {
    // Referenced in main but never registered — a near miss worth calling
    // out separately from a channel main does not mention at all.
    unwired.push(`${key} (referenced in main/index.ts but no ipcMain.on/handle)`);
  } else {
    unwired.push(`${key} (no reference in main/index.ts at all)`);
  }
}

check(unwired.length === 0, `check 3: all ${setChannels.length} IPC.SET_* channels wired in main/index.ts`, {
  unwired,
});
for (const u of unwired) finding('3-ipc-wiring', `SET channel has no ipcMain.on handler: ${u}`);

// A `handle` on a fire-and-forget SET_* channel means the renderer is using
// the wrong call shape (invoke vs send), so surface it as a note.
if (handleOnly.length > 0) {
  console.log(`  note: registered with ipcMain.handle (not .on): ${fmt(handleOnly)}`);
  for (const h of handleOnly) finding('3-ipc-wiring', `${h} uses ipcMain.handle, not ipcMain.on`, 'note');
}
console.log(`  wired: ${wired.length}/${setChannels.length} via ipcMain.on`);
if (unwired.length > 0) {
  console.log('  unwired:');
  for (const u of unwired) console.log(`    - ${u}`);
}

// ── 4. preload setXxx -> IPC channel exists ────────────────────────────
// Each method's window runs from its `setXxx: (` to the next sibling method,
// so multi-line arrow bodies (`=> \n ipcRenderer.send(...)`) stay inside
// their own window.
const setterRe = /(^|[,\n])\s*(set[A-Z]\w*)\s*:\s*\(/g;
interface Setter { method: string; channelRef: string | null }
const setters: Setter[] = [];
let match: RegExpExecArray | null;
while ((match = setterRe.exec(preloadSrc)) !== null) {
  const method = match[2];
  const rest = preloadSrc.slice(match.index + match[0].length);
  const boundary = /(^|[,\n])\s*[A-Za-z_$][\w$]*\s*:\s*\(/.exec(rest);
  const window = rest.slice(0, boundary ? boundary.index : Math.min(rest.length, 600));
  const ref = /ipcRenderer\s*\.\s*(?:send|invoke)\s*\(\s*IPC\s*\.\s*([A-Za-z_$][\w$]*)/.exec(window);
  setters.push({ method, channelRef: ref ? ref[1] : null });
}
if (setters.length === 0) die('no preload setXxx methods found (parser bug?)');

const badChannel: string[] = [];
const noIpcCall: string[] = [];
for (const s of setters) {
  if (s.channelRef === null) noIpcCall.push(s.method);
  else if (!ipcChannels.has(s.channelRef)) badChannel.push(`${s.method} -> IPC.${s.channelRef}`);
}

check(
  badChannel.length === 0 && noIpcCall.length === 0,
  `check 4: all ${setters.length} preload setXxx methods map to an existing IPC channel`,
  { badChannel, noIpcCall },
);
for (const b of badChannel) finding('4-preload', `preload method targets an undefined channel: ${b}`);
for (const n of noIpcCall) finding('4-preload', `preload setXxx method sends no IPC channel: ${n}`);

// ── summary ───────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.severity === 'error');
const notes = findings.filter((f) => f.severity === 'note');

console.log('\n── findings ' + '─'.repeat(60));
if (findings.length === 0) {
  console.log('none — settings contract is in parity');
} else {
  for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.check}: ${f.message}`);
}

console.log('\n── summary ' + '─'.repeat(62));
console.log(`checks    : ${pass} passed, ${fail} failed (of ${pass + fail})`);
console.log(`findings  : ${errors.length} error, ${notes.length} note`);
console.log(`settings  : ${storedFields.size} stored fields, ${rendererFields.size} renderer settings fields`);
console.log(`channels  : ${ipcChannels.size} total, ${setChannels.length} SET_*, ${wired.length} wired via ipcMain.on`);
console.log(`preload   : ${setters.length} setXxx methods`);
console.log(
  fail === 0
    ? '\nRESULT: PASS — no contract drift detected'
    : `\nRESULT: FAIL — ${fail} check(s) drifted, see findings above`,
);
console.log('(findings are expected output; exit 0 as long as the script parsed cleanly)');
