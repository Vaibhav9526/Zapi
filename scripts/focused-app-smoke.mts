/**
 * Smoke test for the focused-app guide injection (heyclicky-adoption):
 *
 *   active-window.ts — foregroundWindowTitle() Win32 probe, the
 *     process→guide map, and focusedAppContext() (probe + map + guide
 *     read, all failure paths → null).
 *   prompts.ts — buildSystemPrompt's appGuide option injecting a
 *     `Focused app: <name>` section into the agent system prompt only.
 *
 * Run:  bunx tsx scripts/focused-app-smoke.mts
 * Pure node — no electron stub needed: the probe degrades to null off
 * Windows, and the guide dir resolves off cwd/ZAPI_APP_GUIDES_DIR, not
 * app.getAppPath, when electron isn't importable.
 */
import path from 'node:path';
import {
  foregroundWindowTitle,
  focusedAppContext,
  appForProcess,
} from '../src/main/services/active-window';
import { buildSystemPrompt } from '../src/main/services/prompts';

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const GUIDES = path.join(process.cwd(), 'docs', 'app-guides');

async function main(): Promise<void> {
  // ── Probe shape ──────────────────────────────────────────────────────
  // On Windows this is a real Win32 read (the terminal running the test
  // is the foreground window); off-Windows it's an immediate null. Either
  // way the contract is the same: structured value or null, never throw.
  const win = await foregroundWindowTitle();
  check(
    win === null ||
      (typeof win.title === 'string' && typeof win.processName === 'string'),
    'foregroundWindowTitle resolves structured value or null',
    win,
  );

  // ── Process → guide map ──────────────────────────────────────────────
  check(appForProcess('explorer.exe') === 'explorer', 'map: explorer.exe → explorer');
  check(appForProcess('explorer') === 'explorer', 'map: bare explorer');
  check(appForProcess('Code.exe') === 'vscode', 'map: Code.exe → vscode (case-insensitive)');
  check(appForProcess('chrome.exe') === 'chrome', 'map: chrome.exe → chrome');
  check(appForProcess('msedge.exe') === 'chrome', 'map: msedge.exe → chrome (same notes)');
  check(appForProcess('EXCEL.EXE') === 'excel', 'map: EXCEL.EXE → excel');
  check(appForProcess('SystemSettings.exe') === 'settings', 'map: SystemSettings.exe → settings');
  check(appForProcess('notepad.exe') === null, 'map: notepad.exe → no guide');
  check(appForProcess('') === null, 'map: empty → null');

  // ── focusedAppContext ────────────────────────────────────────────────
  // Injected probe: a VS Code foreground window must resolve its guide.
  const vscode = await focusedAppContext({
    probe: async () => ({ title: 'x.ts — repo', processName: 'code.exe' }),
    guidesDir: GUIDES,
  });
  check(vscode?.app === 'vscode', 'context: code.exe → app vscode');
  check(
    !!vscode && vscode.guideText.includes('VS Code'),
    'context: vscode guide text loads',
    vscode?.guideText?.slice(0, 60),
  );
  check(
    !!vscode && vscode.guideText.length <= 6144,
    'context: guide text ≤6KB',
    vscode?.guideText.length,
  );

  const explorer = await focusedAppContext({
    probe: async () => ({ title: 'Downloads', processName: 'explorer.exe' }),
    guidesDir: GUIDES,
  });
  check(explorer?.app === 'explorer', 'context: explorer.exe → app explorer');

  const unmapped = await focusedAppContext({
    probe: async () => ({ title: 'np', processName: 'notepad.exe' }),
    guidesDir: GUIDES,
  });
  check(unmapped === null, 'context: unmapped process → null');

  const noWindow = await focusedAppContext({ probe: async () => null });
  check(noWindow === null, 'context: probe null → null');

  const badDir = await focusedAppContext({
    probe: async () => ({ title: 'x', processName: 'code.exe' }),
    guidesDir: path.join(GUIDES, 'does-not-exist'),
  });
  check(badDir === null, 'context: missing guides dir → null');

  // Real call with no injection: probe may return null (headless/CI) or a
  // process we don't map — both are fine. What must hold is the shape.
  const real = await focusedAppContext();
  check(
    real === null ||
      (typeof real.app === 'string' && typeof real.guideText === 'string'),
    'focusedAppContext() resolves structured value or null',
    real?.app,
  );

  // ── buildSystemPrompt appGuide ────────────────────────────────────────
  const withGuide = buildSystemPrompt('friendly', {
    hasWebSearch: false,
    mode: 'agent',
    appGuide: { app: 'vscode', text: '  GUIDE-BODY-MARKER  ' },
  });
  check(
    withGuide.includes('Focused app: vscode'),
    'prompt: agent + appGuide → Focused app section',
  );
  check(
    withGuide.includes('GUIDE-BODY-MARKER'),
    'prompt: guide excerpt body injected',
  );
  check(
    withGuide.indexOf('Focused app:') > withGuide.indexOf('[ACT:done'),
    'prompt: guide section follows the agent rules',
  );

  const noGuide = buildSystemPrompt('friendly', { hasWebSearch: false, mode: 'agent' });
  check(!noGuide.includes('Focused app:'), 'prompt: agent without appGuide → no section');

  const talkWithGuide = buildSystemPrompt('friendly', {
    hasWebSearch: false,
    mode: 'talk',
    appGuide: { app: 'vscode', text: 'GUIDE-BODY-MARKER' },
  });
  check(
    !talkWithGuide.includes('Focused app:') && !talkWithGuide.includes('GUIDE-BODY-MARKER'),
    'prompt: talk mode ignores appGuide',
  );

  const emptyGuide = buildSystemPrompt('friendly', {
    hasWebSearch: false,
    mode: 'agent',
    appGuide: { app: 'vscode', text: '   ' },
  });
  check(!emptyGuide.includes('Focused app:'), 'prompt: blank guide text → no section');

  console.log(`\ntotal: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('focused-app-smoke crashed:', err);
  process.exit(1);
});
