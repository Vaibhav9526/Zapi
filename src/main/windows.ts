import { app, BrowserWindow, Display, screen } from 'electron';
import path from 'path';
import { DISPLAY_INFO_ARG_PREFIX, type DisplayInfo, type StreamWindowBounds } from '../shared/types';

const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER === '1';

function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js');
}

/**
 * Navigation + popup hardening shared by all app windows. Renderers are
 * single local pages — nothing legitimately calls window.open, so deny
 * popups outright, and allow renderer-initiated navigation only within
 * our own page origin (the vite dev server in dev, file:// in packaged
 * builds) so a compromised renderer can't pull remote content into a
 * privileged preload context. loadURL/loadFile don't fire will-navigate,
 * so page loads and reloads are unaffected.
 *
 * CSP deliberately not set here: all pages are local (file:// or the dev
 * server) behind contextIsolation + no nodeIntegration — a response-header
 * CSP buys little over the navigation guards, and a per-page <meta> CSP
 * in the HTML files is the cleaner lever if we ever need one.
 */
function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:5173/')
      : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
}

function loadPage(win: BrowserWindow, page: string): void {
  if (isDev) {
    const url = `http://localhost:5173/${page}.html`;
    console.log(`[Zapi] Loading ${page} from dev server: ${url}`);
    win.loadURL(url);
  } else {
    const filePath = path.join(__dirname, '../../renderer', `${page}.html`);
    console.log(`[Zapi] Loading ${page} from file: ${filePath}`);
    win.loadFile(filePath);
  }
}

/**
 * Display hot-plug storm protection. Docking stations, resolution
 * toggles, and GPU resets fire display-added/removed/metrics-changed in
 * rapid bursts, and every sync that observes a changed topology destroys
 * + recreates the affected overlays — a full renderer reload each.
 * Coalesce a burst into one run ~300 ms after the last event. index.ts
 * wires this to the screen events; the crash-driven rebuild has its own
 * separate debounce there.
 */
let displaySyncTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleDisplaySync(fn: () => void): void {
  if (displaySyncTimer) clearTimeout(displaySyncTimer);
  displaySyncTimer = setTimeout(() => {
    displaySyncTimer = null;
    fn();
  }, 300);
}

/** The main Zapi app window (settings + status). */
export function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: true,
    titleBarStyle: 'default',
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#0f0f11',
    title: 'ZAPI',
    // Windows/Linux otherwise show Electron's stock "File Edit View
    // Window Help" bar above the panel. Alt still reveals it.
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true caused renderers to fail to render (blank screen)
      // — likely a require-resolution issue with our relative preload
      // path. Reverted; we'd need to bundle the preload as a single
      // self-contained file (esbuild) before flipping this on safely.
      sandbox: false,
    },
  });

  hardenWindow(win);
  loadPage(win, 'panel');
  return win;
}

/**
 * Maps each overlay's webContents id back to the Display it covers, so
 * `ipcMain.handle('get-display-info')` in main/index.ts can answer the
 * renderer's request based on which window the IPC came from. Solved
 * the race where the renderer's display-info listener attaches after
 * the one-shot push has already fired.
 */
export const overlayDisplayByWebContents = new Map<number, Display>();

function toDisplayInfo(display: Display): DisplayInfo {
  return {
    id: display.id,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
  };
}

/** A transparent, click-through overlay covering one display. */
export function createOverlayWindow(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;
  const displayInfo = toDisplayInfo(display);

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The overlay animates scenes and the cursor off rAF — if Windows
      // ever marks the window occluded (fullscreen app above it), a
      // throttled render loop would freeze ink mid-stroke.
      backgroundThrottling: false,
      // Hand the renderer its coordinate space up front. The IPC push
      // below can land before React has attached its listener, so the
      // overlay needs a value it can read synchronously on mount.
      //
      // Safe as plain JSON only because every DisplayInfo field is
      // numeric, so the serialized value can never contain a space.
      // Windows splits additionalArguments on spaces — if this type ever
      // grows a string field (a display label, say), base64 it first.
      additionalArguments: [DISPLAY_INFO_ARG_PREFIX + JSON.stringify(displayInfo)],
    },
  });

  // Click-through: let mouse events pass to windows underneath
  win.setIgnoreMouseEvents(true, { forward: true });

  // Keep the overlay out of screenshots entirely: desktopCapturer and
  // user screen-shares would otherwise see our ink/pill drawn over the
  // desktop, and the agent's own capture loop would read its own
  // scribbles back as screen state (same exclusion heyclicky's
  // ScreenshotManager applies).
  win.setContentProtection(true);

  // Keep overlay above everything
  win.setAlwaysOnTop(true, 'screen-saver');

  // Visible on all workspaces / virtual desktops
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  hardenWindow(win);
  loadPage(win, 'overlay');

  // Track which display this overlay covers so main can route cursor /
  // scene events to the right window and answer bounds changes.
  // Capture the webContents id up front — by the time `closed` fires,
  // the webContents has been destroyed and accessing `.id` throws.
  const wcId = win.webContents.id;
  overlayDisplayByWebContents.set(wcId, display);
  win.on('closed', () => {
    overlayDisplayByWebContents.delete(wcId);
  });

  // Belt-and-braces: the preload already reads this same snapshot out of
  // argv on every load, including reloads, so this send is redundant
  // rather than an update path. It stays as a cheap safety net in case
  // the argv read ever fails. Bounds changes do NOT arrive here — the
  // window is destroyed and recreated by rebuildOverlays instead.
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('display-info', displayInfo);
  });

  return win;
}

/**
 * Overlay visibility policy: overlays are always shown.
 *
 * These windows double as the drawing canvas for scene ink strokes,
 * point cues, and agent-action echoes — hiding them when the user
 * disables the companion cursor would blank that whole surface, not
 * just the cursor. With the toggle off the renderer hides the cursor
 * itself: main stops forwarding CURSOR_POSITION (index.ts gates the
 * poll on isClickyCursorEnabled and sends an "off" pulse), so nothing
 * cursor-shaped renders while scenes still draw. Rebuilds and display
 * sync call this to re-assert visibility on freshly created overlays.
 */
export function applyOverlayVisibility(windows: readonly BrowserWindow[]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) win.showInactive();
  }
}

/**
 * The transparent, draggable "stream" window that mirrors the live Q/A
 * so the user can read, scroll, and copy. It's a frameless BrowserWindow
 * with a CSS-drag region in the header; mouse events are enabled so
 * scrolling and text selection work normally.
 */
export function createStreamWindow(
  storedBounds: StreamWindowBounds | null,
): BrowserWindow {
  const bounds = resolveStreamBounds(storedBounds);

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 180,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    title: 'Zapi Stream',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  hardenWindow(win);
  loadPage(win, 'stream');
  return win;
}

/**
 * Pick a display to place the stream on: whichever display overlaps the
 * stored rect most, or null when the rect is entirely off-screen.
 */
function bestOverlapDisplay(rect: StreamWindowBounds): Display | null {
  let best: Display | null = null;
  let bestArea = 0;
  for (const d of screen.getAllDisplays()) {
    const b = d.bounds;
    const w = Math.min(rect.x + rect.width, b.x + b.width) - Math.max(rect.x, b.x);
    const h = Math.min(rect.y + rect.height, b.y + b.height) - Math.max(rect.y, b.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  return best;
}

/**
 * Stored bounds may point at a display that's since been removed or
 * shrunk (laptop undocked, resolution changed) — and the stream is
 * frameless + skipTaskbar, so an off-screen window is both invisible
 * and unreachable. Clamp into the most-overlapping display's work area;
 * zero overlap anywhere → fresh default anchor.
 */
function resolveStreamBounds(stored: StreamWindowBounds | null): StreamWindowBounds {
  if (!stored) return defaultStreamBounds();
  const display = bestOverlapDisplay(stored);
  if (!display) return defaultStreamBounds();
  const wa = display.workArea;
  const width = Math.min(stored.width, wa.width);
  const height = Math.min(stored.height, wa.height);
  return {
    width,
    height,
    x: Math.min(Math.max(stored.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(stored.y, wa.y), wa.y + wa.height - height),
  };
}

function defaultStreamBounds(): StreamWindowBounds {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const width = 380;
  const height = 320;
  // Anchor to the bottom-right corner of the primary work area with a
  // small gutter, so on first launch users can find it easily.
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
  };
}
