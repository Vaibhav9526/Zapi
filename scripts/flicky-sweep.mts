/**
 * Rebrand straggler sweep: every case-insensitive 'flicky' left in the tree.
 *
 * Walks the repo, skipping build/dep output (node_modules, dist, release,
 * landing, .git) and the review/report documents that are *about* the
 * rebrand (AUDIT*.md, REVIEW*.md, FEATURES.md, REPORT.md) plus this script
 * and dev-verify.mts, then buckets each hit:
 *
 *   [INTENTIONAL] FlickySettings / FlickyAPI (frozen TS contracts), the
 *                 FLICKY_DISABLE_GPU env var, wake-word alias regexes that
 *                 accept "flicky" beside "clicky" as a mishear, and the
 *                 `window.flicky` contextBridge key (frozen across preload
 *                 and every renderer file).
 *   [STRAY]       everything else — user-visible strings, log prefixes,
 *                 comments, file names, config values.
 *
 * Exits 1 when any STRAY hit exists so CI can gate on it. Report-only: this
 * script never edits anything, and a STRAY hit may well be a file another
 * worker is mid-edit on.
 *
 * Run: bunx tsx scripts/flicky-sweep.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'landing', '.git']);
/* Report documents that are about the rebrand, plus the scripts that run
   this sweep. */
const SKIP_FILE = /^(?:AUDIT\w*|REVIEW\w*|FEATURES|REPORT)\.md$/i;
const SKIP_FILES_EXACT = new Set(['flicky-sweep.mts', 'dev-verify.mts']);
const MAX_BYTES = 4 * 1024 * 1024;
const PER_FILE_CAP = 15;

const NEEDLE = /flicky/i;

interface Hit {
  file: string;
  line: number;
  text: string;
  reason: string | null;
}
const intentional: Hit[] = [];
const stray: Hit[] = [];

/** Classify one matching line; null reason ⇒ STRAY. */
function classify(line: string): string | null {
  if (/\bFlickySettings\b/.test(line)) return 'frozen FlickySettings contract';
  if (/\bFlickyAPI\b/.test(line)) return 'frozen FlickyAPI contract';
  if (/\bFLICKY_DISABLE_GPU\b/.test(line)) return 'FLICKY_DISABLE_GPU env var name';
  // Wake-word aliases are matched as a pair ("zapi|zappi|flicky|clicky") so
  // "flicky" is a deliberate mishear, not a leftover brand.
  if (/clicky/i.test(line)) return 'wake-word mishear alias (paired with clicky)';
  if (/\bwindow\.flicky\b/.test(line) || /exposeInMainWorld\(\s*'flicky'/.test(line)) {
    return 'contextBridge key — frozen across preload + renderers';
  }
  return null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    const base = entry.name;
    if (SKIP_FILE.test(base) || SKIP_FILES_EXACT.has(base)) continue;
    out.push(path.join(dir, base));
  }
  return out;
}

let scanned = 0;
let skippedBinary = 0;
for (const file of walk(root)) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (stat.size > MAX_BYTES) {
    skippedBinary++;
    continue;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    continue;
  }
  // Binary sniff: a NUL in the first block means this isn't text.
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  if (probe.includes(0)) {
    skippedBinary++;
    continue;
  }
  scanned++;
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = buf.toString('utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!NEEDLE.test(text)) continue;
    const reason = classify(text);
    const hit: Hit = { file: rel, line: i + 1, text: text.trim(), reason };
    if (reason === null) stray.push(hit);
    else intentional.push(hit);
  }
}

// ── Report ──────────────────────────────────────────────────────────────
function printGroup(title: string, hits: Hit[]): void {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  console.log(`\n${title} — ${hits.length} hit${hits.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'}`);
  for (const [file, list] of [...byFile.entries()].sort()) {
    console.log(`  ${file}`);
    for (const h of list.slice(0, PER_FILE_CAP)) {
      const tag = h.reason ? `[${h.reason}]` : '';
      console.log(`    ${String(h.line).padStart(5)}: ${h.text.slice(0, 110)} ${tag}`);
    }
    if (list.length > PER_FILE_CAP) {
      console.log(`    ... +${list.length - PER_FILE_CAP} more in this file`);
    }
  }
}

console.log(
  `flicky sweep: ${scanned} text files scanned ` +
    `(${skippedBinary} skipped as binary/oversized), ` +
    `skipped dirs [${[...SKIP_DIRS].join(', ')}] + report docs + this script/dev-verify`,
);
console.log('NOTE git history is not visible to a file sweep; only working-tree files are classified.');

printGroup('[INTENTIONAL]', intentional);
printGroup('[STRAY]', stray);

const byReason = new Map<string, number>();
for (const h of intentional) byReason.set(h.reason ?? '?', (byReason.get(h.reason ?? '?') ?? 0) + 1);
console.log('\nintentional breakdown:');
for (const [reason, n] of [...byReason.entries()].sort()) console.log(`  ${n}\t${reason}`);

console.log(
  `\n${intentional.length} intentional, ${stray.length} stray` +
    (stray.length > 0 ? ' — STRAY hits must be triaged' : ' — clean'),
);
process.exit(stray.length > 0 ? 1 : 0);
