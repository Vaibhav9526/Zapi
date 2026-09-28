/**
 * Presence + header check for the overlay chimes.
 *
 * The renderer bundles the sounds from `src/renderer/assets/sfx/` (the
 * vite root — see gen-sfx.mts, which renders them; `assets/` holds the
 * app icons, not these). Main emits IPC.PLAY_SFX with a bare name and the
 * overlay resolves `<name>.wav` — a missing or truncated file is a silent
 * failure at demo time, so the contract is verified here:
 *   every SFX name main emits has a wav on disk (and vice versa),
 *   each file is ≥44 B and carries a well-formed RIFF/WAVE/PCM header.
 *
 * Pure fs — runs under any runner:
 *   bunx tsx scripts/sfx-check.mts   (or: bun scripts/sfx-check.mts)
 * Regenerate the assets with `bun scripts/gen-sfx.mts` (deterministic).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SFX_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'sfx');

// The names main actually emits — source of truth is the send sites in
// index.ts, not a hardcoded copy that could drift from the payload list.
const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf-8');
const emitted = new Set<string>();
for (const m of indexSrc.matchAll(/IPC\.PLAY_SFX\s*,\s*'([^']+)'/g)) emitted.add(m[1]);
check(emitted.size === 4, 'sfx: index.ts emits 4 distinct sfx names', [...emitted]);

const EXPECTED = ['agent-launch', 'agent-done', 'agent-needs-you', 'heard'];
check(
  EXPECTED.every((n) => emitted.has(n)),
  'sfx: main emits exactly the expected payload names',
  [...emitted],
);

const files = fs.existsSync(SFX_DIR)
  ? fs.readdirSync(SFX_DIR).filter((f) => f.endsWith('.wav'))
  : [];
check(files.length === EXPECTED.length, 'sfx: exactly the four wavs on disk', files);

for (const name of EXPECTED) {
  const p = path.join(SFX_DIR, `${name}.wav`);
  if (!fs.existsSync(p)) {
    check(false, `sfx: ${name}.wav exists`, SFX_DIR);
    continue;
  }
  const buf = fs.readFileSync(p);
  const ok =
    buf.length > 44 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE' &&
    buf.toString('ascii', 12, 16) === 'fmt ' &&
    buf.readUInt16LE(20) === 1 && // PCM
    buf.readUInt16LE(22) === 1 && // mono
    buf.readUInt16LE(34) === 16 && // 16-bit
    buf.toString('ascii', 36, 40) === 'data' &&
    44 + buf.readUInt32LE(40) === buf.length; // data chunk spans the file
  check(
    ok,
    `sfx: ${name}.wav — non-empty, RIFF/WAVE PCM16 mono, data chunk consistent`,
    { bytes: buf.length },
  );
}

// A wav nobody emits is dead weight the bundle ships for nothing.
for (const f of files) {
  check(emitted.has(f.replace(/\.wav$/, '')), `sfx: ${f} has a PLAY_SFX emitter`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
