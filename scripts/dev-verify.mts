// scripts/dev-verify.mts
// run: bunx tsx scripts/dev-verify.mts
//
// One-shot dev verifier for ZAPI. Runs, in order:
//   1. bunx tsc -p tsconfig.main.json --noEmit
//   2. bunx tsc -p tsconfig.renderer.json --noEmit
//   3. every discovered test script (sorted): scripts/*-smoke.mts,
//      scripts/*-check.mts, scripts/*-abort.mts, scripts/*-response.mts,
//      scripts/scene-pipeline.mts  (SKIP if unreadable)
//   4. npm run lint                          (report-only: shown but never fails the run)
//
// Test scripts that need a bun preload stub (they name one in their header)
// run via `bun --preload <that stub>`; the rest via bunx tsx.
//
// Exit code = number of FAILs, capped at 1. Skips and the report-only
// lint step never affect the exit code.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Status = 'PASS' | 'FAIL' | 'SKIP';

interface StepResult {
  name: string;
  status: Status;
  note: string;
  reportOnly: boolean;
}

function runCmd(cmd: string): { ok: boolean; tail: string } {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const tail = out ? out.split('\n').slice(-8).join('\n') : '(no output)';
  return { ok: r.status === 0, tail };
}

function cmdStep(name: string, cmd: string, reportOnly = false): StepResult {
  const { ok, tail } = runCmd(cmd);
  return { name, status: ok ? 'PASS' : 'FAIL', note: ok ? '' : tail, reportOnly };
}

function smokeStep(file: string): StepResult {
  const name = `tsx ${file}`;
  if (!existsSync(path.join(ROOT, 'scripts', file))) {
    return { name, status: 'SKIP', note: 'not present yet', reportOnly: false };
  }
  // Bun-stub scripts self-report SKIP outside bun; run them under the
  // preload so they really execute instead of passing vacuously.
  let content = '';
  try {
    content = readFileSync(path.join(ROOT, 'scripts', file), 'utf-8');
  } catch {
    return { name, status: 'SKIP', note: 'unreadable', reportOnly: false };
  }
  // A script that names a `*-preload.ts` file in its header needs a bun
  // stub to run for real; PRELOAD_FOR maps the filename to which stub.
  if (/-preload\.ts/.test(content)) {
    const preload = preloadFor(file);
    if (preload) {
      return cmdStep(`bun ${file}`, `bun --preload ${preload} scripts/${file}`);
    }
  }
  return cmdStep(name, `bunx tsx scripts/${file}`);
}

/**
 * Dynamically discover test scripts so new *-smoke/*-check/*-abort files run
 * free. Anything that needs a bun preload stub is matched by its file name:
 * a script whose own header names the preload to use is launched with it.
 */
const PRELOAD_FOR: Array<[RegExp, string]> = [
  [/agent-abort\.mts$/, './scripts/agent-stub-preload.ts'],
  [/selfsettings-smoke\.mts$/, './scripts/companion-stub-preload.ts'],
  [/(?:store|chat|keystore|routines|artifact|suggestion|suggestion-parse|workspace)-smoke\.mts$/, './scripts/store-preload.ts'],
];

function preloadFor(file: string): string | null {
  for (const [re, preload] of PRELOAD_FOR) if (re.test(file)) return preload;
  return null;
}

function discoverTests(): string[] {
  const dir = path.join(ROOT, 'scripts');
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter(
      (f) =>
        f.endsWith('-smoke.mts') ||
        f.endsWith('-check.mts') ||
        f.endsWith('-abort.mts') ||
        f.endsWith('-response.mts') ||
        f === 'scene-pipeline.mts',
    )
    .sort();
}

const results: StepResult[] = [
  cmdStep('tsc main', 'bunx tsc -p tsconfig.main.json --noEmit'),
  cmdStep('tsc renderer', 'bunx tsc -p tsconfig.renderer.json --noEmit'),
  ...discoverTests().map(smokeStep),
  cmdStep('lint (report-only)', 'npm run lint', true),
];

let pass = 0;
let fail = 0;
let skip = 0;
for (const r of results) {
  const tag = r.status === 'PASS' ? '[PASS]' : r.status === 'FAIL' ? '[FAIL]' : '[SKIP]';
  const extra = r.note ? ` — ${r.reportOnly ? 'report-only; ' : ''}${r.note.split('\n')[0]}` : '';
  console.log(`${tag} ${r.name}${extra}`);
  if (r.status === 'PASS') pass++;
  else if (r.status === 'SKIP') skip++;
  else if (!r.reportOnly) fail++;
}

const counted = results.filter((r) => r.status === 'FAIL' && !r.reportOnly).length;
const reportOnlyFails = results.filter((r) => r.status === 'FAIL' && r.reportOnly).length;
console.log(
  `\ntotal: ${pass} passed, ${fail} failed, ${skip} skipped` +
    (reportOnlyFails > 0 ? ` (${reportOnlyFails} report-only failure${reportOnlyFails > 1 ? 's' : ''} not counted)` : ''),
);
process.exit(Math.min(counted, 1));
