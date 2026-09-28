/**
 * Bundle size report for ZAPI.
 *
 * Runs `bun run build`, then prints a table of dist output sizes:
 * main entry, preload, per-window renderer bundles (panel/overlay/stream
 * js+css) plus shared chunks, flags any bundle file > 500 KB, totals dist,
 * and counts packaged assets/ files (electron-builder ships dist/** +
 * assets/**).
 *
 * Runner-agnostic (node builtins only): npx tsx scripts/size-report.mts
 *
 * Exit 1 only when the build itself fails; oversize bundles are flags,
 * not failures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const OVER_KB = 500;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const kb = (bytes: number): number => bytes / 1024;

// ── 1. Build ────────────────────────────────────────────────────────────
console.log('$ bun run build');
{
  // shell:true so Windows resolves the bun shim (.ps1) on PATH.
  const r = spawnSync('bun run build', {
    cwd: root,
    shell: true,
    encoding: 'utf-8',
    timeout: 540000,
  });
  if (r.status !== 0) {
    console.log(
      `FAIL build failed (status=${String(r.status)} signal=${String(r.signal ?? 'none')} error=${String((r as { error?: unknown }).error ?? 'none')})`,
    );
    console.log(
      `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.split('\n').slice(-15).join('\n'),
    );
    console.log('\n0 passed, 1 failed');
    process.exit(1);
  }
}
console.log('PASS build succeeded');

// ── 2. Size table ───────────────────────────────────────────────────────
interface Row {
  file: string;
  bytes: number;
  tag: string;
}
const distDir = path.join(root, 'dist');
const rows: Row[] = listFiles(distDir).map((p) => ({
  file: path.relative(root, p).replace(/\\/g, '/'),
  bytes: fs.statSync(p).size,
  tag: '',
}));

function findOne(suffix: string): Row | undefined {
  const hits = rows.filter((r) => r.file.endsWith(suffix));
  return hits.length === 1 ? hits[0] : undefined;
}
function findAll(re: RegExp): Row[] {
  return rows.filter((r) => re.test(r.file)).sort((a, b) => a.file.localeCompare(b.file));
}

const table: Row[] = [];
const push = (r: Row | undefined, tag: string): void => {
  if (r) table.push({ ...r, tag });
};
push(findOne('dist/main/main/index.js'), 'main entry');
push(findOne('dist/main/preload/index.js'), 'preload');
for (const entry of ['panel', 'overlay', 'stream']) {
  for (const r of findAll(new RegExp(`dist/renderer/assets/${entry}-.+\\.(js|css)$`))) {
    push(r, `${entry} bundle`);
  }
}
for (const r of findAll(/dist\/renderer\/assets\/(react|design-system|waveform)-.+\.(js|css)$/)) {
  push(r, 'shared chunk');
}

console.log('\nfile' .padEnd(52) + 'KB'.padStart(10) + '  note');
console.log('-'.repeat(76));
let over = 0;
for (const r of table) {
  const k = kb(r.bytes);
  const flag = k > OVER_KB ? '  OVER >500KB' : '';
  if (flag) over++;
  console.log(r.file.padEnd(52) + k.toFixed(1).padStart(10) + flag + (r.tag ? `  [${r.tag}]` : ''));
}
const distTotal = rows.reduce((s, r) => s + r.bytes, 0);
console.log('-'.repeat(76));
console.log(`dist total: ${kb(distTotal).toFixed(1)} KB across ${rows.length} files`);
if (over > 0) console.log(`FINDING ${over} bundle file(s) exceed 500 KB`);
else console.log('PASS no bundle file exceeds 500 KB');

// ── 3. Packaged assets ──────────────────────────────────────────────────
const assetsDir = path.join(root, 'assets');
const assetFiles = listFiles(assetsDir);
const assetBytes = assetFiles.reduce((s, p) => s + fs.statSync(p).size, 0);
console.log(
  `assets: ${assetFiles.length} files, ${kb(assetBytes).toFixed(1)} KB packaged via files:[dist/**, assets/**]`,
);

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n1 passed, 0 failed');
process.exit(0);
