import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

/**
 * Focused-app detection + guide resolution (heyclicky's "driving notes"
 * idea). Two pieces:
 *
 *   foregroundWindowTitle() — Windows-only Win32 probe via PowerShell.
 *     Returns { title, processName } for the window the user is looking
 *     at right now. ~200 ms cold, cached 3 s — every agent step calls it
 *     and a per-step spawn storm is the failure mode the cache exists for.
 *     Any failure (non-Windows, powershell missing, timeout, weird JSON)
 *     resolves to null — app context is a nicety, never a blocker.
 *
 *   focusedAppContext() — maps the foreground process to a guide we ship
 *     in docs/app-guides/ (explorer, vscode, chrome, excel, settings) and
 *     returns { app, title, guideText } ready to prepend to the step
 *     prompt. Null means "no guide applies" — probe and guide failures
 *     look identical to callers.
 */

export interface ForegroundWindow {
  title: string;
  processName: string;
}

export interface FocusedAppContext {
  /** Guide key — 'explorer' | 'vscode' | 'chrome' | 'excel' | 'settings'. */
  app: string;
  /** Foreground window title, handy for the 'Focused app' line. */
  title: string;
  /** The guide's markdown body, ≤6 KB. */
  guideText: string;
}

/** Probe result reuse window — agent steps run seconds apart anyway. */
const CACHE_MS = 3_000;
/** Cold powershell on a loaded box can take ~1 s; bound it anyway. */
const PROBE_TIMEOUT_MS = 5_000;
/** Guides are distilled notes — a huge one would crowd the real prompt. */
const MAX_GUIDE_CHARS = 6144;

/**
 * PowerShell compiles a 3-import class and reads the foreground window.
 * The PID lookup goes through GetWindowThreadProcessId → Get-Process so
 * the same call yields both the title and the owning process name —
 * process is what the guide map keys on (titles are user text and lie).
 *
 * Passed via -EncodedCommand (UTF-16LE base64): the Add-Type here-string
 * is riddled with quotes and no command-line escaping scheme survives
 * node → cmd → powershell reliably.
 */
const PS_SCRIPT = `Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$hwnd = [FG]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
$sb = New-Object System.Text.StringBuilder 512
[void][FG]::GetWindowText($hwnd, $sb, $sb.Capacity)
$procId = [uint32]0
[void][FG]::GetWindowThreadProcessId($hwnd, [ref]$procId)
$name = ''
try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
@{ title = $sb.ToString(); processName = $name } | ConvertTo-Json -Compress
`;

const execFileAsync = promisify(execFile);

let cached: { value: ForegroundWindow | null; at: number } | null = null;

async function probe(): Promise<ForegroundWindow | null> {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as { title?: string; processName?: string };
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const processName = typeof parsed.processName === 'string' ? parsed.processName.trim() : '';
  if (!title && !processName) return null;
  return { title, processName };
}

/**
 * The foreground window's { title, processName }, or null. Non-Windows
 * short-circuits — GetForegroundWindow doesn't exist there and spawning
 * powershell for it would just add a delay to every agent step.
 */
export function foregroundWindowTitle(): Promise<ForegroundWindow | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return Promise.resolve(cached.value);
  }
  return probe()
    .then((value) => {
      cached = { value, at: Date.now() };
      return value;
    })
    .catch(() => {
      // Probe failures cache too — a broken powershell shouldn't get
      // retried (and paid for) on every agent step.
      cached = { value: null, at: Date.now() };
      return null;
    });
}

// ── Guide map ────────────────────────────────────────────────────────

/**
 * Process name (lowercase, no .exe) → guide file in docs/app-guides/.
 * Get-Process reports bare names ('chrome', 'msedge'); both are accepted
 * here so a caller handing us 'chrome.exe' still resolves.
 */
const PROCESS_TO_GUIDE: Record<string, string> = {
  explorer: 'explorer',
  code: 'vscode',
  'code - insiders': 'vscode',
  chrome: 'chrome',
  msedge: 'chrome',
  excel: 'excel',
  systemsettings: 'settings',
};

/** Process name → guide key, or null when we have no notes for it. */
export function appForProcess(processName: string): string | null {
  const bare = processName.trim().toLowerCase().replace(/\.exe$/, '');
  return PROCESS_TO_GUIDE[bare] ?? null;
}

/** One electron lookup, cached — missing/non-electron reads as null. */
let appPathCache: string | null | undefined;
async function electronAppPath(): Promise<string | null> {
  if (appPathCache !== undefined) return appPathCache;
  try {
    // Dynamic so smokes under tsx (no electron binary) degrade instead of
    // failing at import time; under node the electron package resolves to
    // a path string, so `.app` is simply undefined.
    const mod = (await import('electron')) as { app?: { getAppPath(): string } };
    appPathCache = mod.app?.getAppPath?.() ?? null;
  } catch {
    appPathCache = null;
  }
  return appPathCache;
}

/**
 * Where docs/app-guides lives. Electron's app path covers packaged and
 * dev launches; process.cwd() covers `bun run dev` and test runners; the
 * __dirname hop covers tsx-compiled sources and dist/main builds alike
 * (src/main/services and dist/main/services are both 3 deep under root).
 */
async function defaultGuidesDir(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.ZAPI_APP_GUIDES_DIR) candidates.push(process.env.ZAPI_APP_GUIDES_DIR);
  const appPath = await electronAppPath();
  if (appPath) candidates.push(path.join(appPath, 'docs', 'app-guides'));
  candidates.push(path.join(process.cwd(), 'docs', 'app-guides'));
  // typeof-guarded: ESM runners (bun) have no __dirname; typeof of an
  // unbound identifier is 'undefined' rather than throwing.
  if (typeof __dirname === 'string') {
    candidates.push(path.resolve(__dirname, '..', '..', '..', 'docs', 'app-guides'));
  }
  return candidates.find((dir) => fs.existsSync(dir)) ?? null;
}

const guideCache = new Map<string, string | null>();

/**
 * Read `docs/app-guides/<app>.md`, capped at 6 KB — clipped at the last
 * newline inside the cap so the excerpt never ends mid-line. Guides are
 * static docs, so the result (including misses) is cached for the run.
 */
async function loadGuideText(app: string, guidesDir?: string): Promise<string | null> {
  const cacheKey = `${guidesDir ?? ''}::${app}`;
  if (guideCache.has(cacheKey)) return guideCache.get(cacheKey) ?? null;
  let text: string | null = null;
  const dir = guidesDir ?? (await defaultGuidesDir());
  if (dir) {
    try {
      const raw = fs.readFileSync(path.join(dir, `${app}.md`), 'utf-8');
      if (raw.length <= MAX_GUIDE_CHARS) {
        text = raw;
      } else {
        // Cut at the last newline inside the cap; a guide whose first
        // 6 KB is one unbroken line just gets the hard cap.
        const cut = raw.lastIndexOf('\n', MAX_GUIDE_CHARS);
        text = raw.slice(0, cut > 0 ? cut : MAX_GUIDE_CHARS);
      }
    } catch {
      text = null;
    }
  }
  if (guidesDir === undefined) guideCache.set(cacheKey, text);
  return text;
}

export interface FocusedAppDeps {
  /** Test seam — defaults to the real Win32 probe. */
  probe?: () => Promise<ForegroundWindow | null>;
  /** Test seam — defaults to the docs/app-guides resolution. */
  guidesDir?: string;
}

/**
 * Resolve the focused app + its driving guide for this step, or null.
 * The probe result is matched on the PROCESS name — titles are user
 * text and can't be trusted to name the app.
 */
export async function focusedAppContext(
  deps: FocusedAppDeps = {},
): Promise<FocusedAppContext | null> {
  const win = await (deps.probe ?? foregroundWindowTitle)();
  if (!win) return null;
  const app = appForProcess(win.processName);
  if (!app) return null;
  const guideText = await loadGuideText(app, deps.guidesDir);
  if (!guideText) return null;
  return { app, title: win.title, guideText };
}
