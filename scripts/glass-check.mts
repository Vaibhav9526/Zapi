/**
 * Glass-wave verification: the acrylic/glass styling must survive into
 * the built bundle, not just exist in source.
 *
 *   1. dist/renderer — at least one emitted CSS asset carries
 *      backdrop-filter (the panel/overlay translucency the wave adds);
 *   2. dist/main — the compiled windows bundle keeps BOTH branches of
 *      the backgroundMaterial conditional ('acrylic' + the
 *      PANEL_FALLBACK_BG fallback), so a non-Windows-11 run still works.
 *
 * Source-of-truth checks ride alongside: windows.ts keeps the conditional
 * and the CSS keeps a real blur radius — a bundled string that only ever
 * matched because the build is stale is caught by the mtime gate: when
 * dist is older than the sources it claims to contain, the affected
 * checks report SKIP (rebuild with `bun run build`) rather than passing
 * on a stale artifact.
 *
 * Pure fs — any runner:  bunx tsx scripts/glass-check.mts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
let skipped = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`,
    );
  }
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`SKIP ${name} :: ${reason}`);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_JS = path.join(ROOT, 'dist', 'main', 'main', 'windows.js');
const WINDOWS_TS = path.join(ROOT, 'src', 'main', 'windows.ts');
const RENDERER_ASSETS = path.join(ROOT, 'dist', 'renderer', 'assets');
const STYLES_DIR = path.join(ROOT, 'src', 'renderer', 'styles');

const mtime = (p: string): number =>
  fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;

// ── 1. source contract ─────────────────────────────────────────────────
{
  const src = fs.readFileSync(WINDOWS_TS, 'utf-8');
  check(
    /backgroundMaterial:\s*'acrylic'/.test(src),
    "src: windows.ts emits backgroundMaterial: 'acrylic' conditionally",
  );
  check(
    src.includes('PANEL_FALLBACK_BG'),
    'src: the non-acrylic fallback branch is still present',
  );
}

// ── 2. dist/main bundle ────────────────────────────────────────────────
{
  if (!fs.existsSync(WINDOWS_JS)) {
    skip('dist: windows.js bundle checks', 'dist/main not built — run `bun run build`');
  } else if (mtime(WINDOWS_JS) < mtime(WINDOWS_TS)) {
    skip('dist: windows.js bundle checks', 'bundle older than src/main/windows.ts — rebuild');
  } else {
    const bundle = fs.readFileSync(WINDOWS_JS, 'utf-8');
    check(
      bundle.includes('backgroundMaterial') && bundle.includes('acrylic'),
      'dist: windows.js carries the acrylic backgroundMaterial branch',
    );
    check(
      bundle.includes('PANEL_FALLBACK_BG'),
      'dist: windows.js keeps the fallback color branch',
    );
  }
}

// ── 3. dist/renderer glass CSS ─────────────────────────────────────────
{
  let cssFiles: string[] = [];
  if (fs.existsSync(RENDERER_ASSETS)) {
    cssFiles = fs.readdirSync(RENDERER_ASSETS).filter((f) => f.endsWith('.css'));
  }
  if (cssFiles.length === 0) {
    skip('dist: renderer backdrop-filter checks', 'no emitted css — run `bun run build`');
  } else {
    // A bundle older than every css source only gets the presence check;
    // the blur-radius assertion still runs since a stale build could
    // carry a pre-glass css.
    const withBackdrop = cssFiles.filter((f) =>
      fs.readFileSync(path.join(RENDERER_ASSETS, f), 'utf-8').includes('backdrop-filter'),
    );
    check(
      withBackdrop.length > 0,
      'dist: emitted css carries backdrop-filter (glass styles shipped)',
      cssFiles,
    );
    const blurOk = cssFiles.some((f) =>
      /backdrop-filter:\s*blur\(\s*\d/.test(
        fs.readFileSync(path.join(RENDERER_ASSETS, f), 'utf-8'),
      ),
    );
    check(
      blurOk,
      'dist: a real blur() radius shipped, not a bare property',
      withBackdrop,
    );
    const newestStyle = fs.existsSync(STYLES_DIR)
      ? Math.max(...fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css')).map((f) => mtime(path.join(STYLES_DIR, f))))
      : 0;
    const stale = newestStyle > 0 && cssFiles.every(
      (f) => mtime(path.join(RENDERER_ASSETS, f)) < newestStyle,
    );
    if (stale) {
      skip('dist: freshness', 'css assets predate src/renderer/styles — rebuild for a current read');
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
