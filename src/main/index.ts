import { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage, session, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import { CompanionManager } from './companion-manager';
import {
  createPanelWindow,
  createOverlayWindow,
  createStreamWindow,
  applyOverlayVisibility,
  overlayDisplayByWebContents,
  scheduleDisplaySync,
} from './windows';
import { IPC, type StreamVisibility, type StreamWindowBounds, type LocalConnection, type AgentStatus, type CaptureMode } from '../shared/types';
import { AUDIO_IPC } from './services/audio-capture';
import * as chatHistory from './services/chat-history-store';
import * as artifactStore from './services/artifact-store';
import * as agentWorkspace from './services/agent-workspace';
import * as suggestionStore from './services/suggestion-store';
import * as settingsStore from './services/settings-store';
import * as usageStore from './services/usage-store';
import { setApiKey, deleteApiKey, getApiKey } from './services/key-store';
import { validateApiKey, validateStoredApiKey } from './services/key-validation';
import { OllamaAPI, normalizeBase } from './services/ollama-api';
import { initGpuGuard, confirmGpuHealthy } from './services/gpu-guard';
import { randomUUID } from 'crypto';

// userData collision: package name 'zapi' resolves userData to
// %APPDATA%\zapi, which a different installed app already owns (its own
// db/sfx/agents live there). Claim an unambiguous dir up front — every
// store (settings/keys/chat/usage/artifacts) resolves through
// app.getPath('userData'), so this must run before anything reads it.
// Our known files are migrated out of the shared dir; the foreign app's
// own files (zapi.db, sfx/, agents/) are left untouched.
{
  const legacyDir = path.join(app.getPath('appData'), 'zapi');
  const ours = path.join(app.getPath('appData'), 'ZAPI Companion');
  const knownFiles = [
    'zapi-settings.json',
    'zapi-keys.json',
    'zapi-chats.json',
    'zapi-usage.json',
    'zapi-suggestions.json',
    'zapi-artifacts.json',
  ];
  try {
    if (fs.existsSync(legacyDir)) {
      fs.mkdirSync(ours, { recursive: true });
      for (const f of knownFiles) {
        const src = path.join(legacyDir, f);
        const dst = path.join(ours, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
      const legacyArtifacts = path.join(legacyDir, 'artifacts');
      const ourArtifacts = path.join(ours, 'artifacts');
      if (fs.existsSync(legacyArtifacts) && !fs.existsSync(ourArtifacts)) {
        fs.cpSync(legacyArtifacts, ourArtifacts, { recursive: true });
      }
    }
  } catch (e) {
    console.warn('[Zapi] userData migration skipped:', e);
  }
  app.setPath('userData', ours);
}

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
// Zapi lives in the tray, so on Windows the natural thing to do when
// you can't find it is to double-click the shortcut again. Without this
// handler that second launch just exited and nothing visible happened —
// which reads as "the app is broken". Surface the panel instead.
app.on('second-instance', () => {
  if (!companion) return;
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.show();
    panelWindow.focus();
  } else {
    togglePanel();
  }
});

// Must run before the app is ready: the switches it may set only apply
// pre-ready, and the GPU failure it counts happens during startup, so
// the listener has to exist before then. Gated on the instance lock so
// a duplicate launch that's about to quit never touches the counter.
if (gotLock) {
  initGpuGuard();
}

let tray: Tray | null = null;
let panelWindow: BrowserWindow | null = null;
let overlayWindows: BrowserWindow[] = [];
let streamWindow: BrowserWindow | null = null;
let companion: CompanionManager;
let isAppQuitting = false;
let lastVoiceState = 'idle';
/** Latest agent-loop status; gates the tray 'Stop agent' item. */
let lastAgentStatus: AgentStatus | null = null;
/** Whether a scene is currently playing (cue beats animating). */
let sceneActive = false;

/**
 * Panel is the surface the user is already reading agent state on — a toast
 * on top of it is pure duplication, so suppress notifications while it has
 * focus. Only the panel gates this: the overlays are click-through and the
 * stream window is a live feed the user may not be watching, but neither
 * reliably reports focus the way the panel does.
 */
function panelHasFocus(): boolean {
  return Boolean(panelWindow && !panelWindow.isDestroyed() && panelWindow.isFocused());
}

/** Display name for an agent id, falling back to the id itself. */
function agentLabel(agentId: string): string {
  try {
    const found = settingsStore.listAgents().find((a) => a.id === agentId);
    return found?.name || agentId;
  } catch {
    // listAgents reads the store off disk; never let a read failure cost the
    // user the completion toast itself.
    return agentId;
  }
}

/**
 * Toast for an agent run finishing. `outcome` is 'done' | 'failed'; a failure
 * is phrased as "needs you" because that's the actionable state — the run
 * stopped and wants a human, which is exactly what a toast should interrupt for.
 *
 * `silent: true` because the outcome already plays a sting through PLAY_SFX;
 * a second sound from the Windows toaster would double up. The toast is the
 * out-of-focus channel, the sting is the in-focus one.
 */
function notifyAgentOutcome(
  status: AgentStatus,
  outcome: 'done' | 'failed',
): void {
  if (!Notification.isSupported()) return;
  // Already looking at the panel — the user sees the status line change.
  if (panelHasFocus()) return;

  const name = agentLabel(status.agentId);
  const detail = (status.message || '').trim();
  const failed = outcome === 'failed';
  const title = failed ? `${name} needs you` : `${name} finished`;
  const body = detail || (failed ? 'The run stopped before finishing.' : 'All done.');

  try {
    new Notification({ title, body, silent: true }).show();
  } catch (err) {
    // A toast failing must never take the agent loop down with it.
    console.error('[Zapi] agent notification failed:', err);
  }
}
/** Cursor-position poll interval — cleared on will-quit. */
let cursorPollTimer: ReturnType<typeof setInterval> | null = null;
/** Which overlay owns the mic right now, and in which mode. */
let audioCaptureWcId: number | null = null;
let audioCaptureMode: CaptureMode | null = null;
/**
 * Cached copy of isClickyCursorEnabled — the 30 fps cursor poll must not
 * pay for getSettings() (settings read + key-status probe) per tick.
 * Seeded at boot; refreshed by onSettingsChanged/onCursorVisibilityChanged.
 */
let clickyCursorEnabled = true;
/** Debounce timer for stream-window bounds write-back. */
let streamBoundsTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Setup's "press your shortcut" check — see IPC.PTT_TEST_START. The flag
 * must never latch: a closed/reloaded panel or an abandoned check would
 * silently disable PTT for the rest of the session, so it self-expires
 * and resets whenever the panel navigates or closes.
 */
let pttTestMode = false;
let pttTestTimer: ReturnType<typeof setTimeout> | null = null;
const PTT_TEST_EXPIRY_MS = 10_000;
function setPttTestMode(on: boolean): void {
  pttTestMode = on;
  if (pttTestTimer) {
    clearTimeout(pttTestTimer);
    pttTestTimer = null;
  }
  if (on) {
    pttTestTimer = setTimeout(() => {
      pttTestMode = false;
      pttTestTimer = null;
    }, PTT_TEST_EXPIRY_MS);
  }
}
/** Perms-poll lifecycle, controlled by panel visibility. */
let permsTimer: ReturnType<typeof setInterval> | null = null;
const startPermsPoll = (): void => {
  if (permsTimer) return;
  const tick = async (): Promise<void> => {
    if (!companion) return;
    // An unhandled rejection in main is fatal — keep the probe
    // self-contained so a flaky status read can't kill the app.
    try {
      const perms = await companion.getPermissions();
      sendToPanel(IPC.PERMISSION_STATUS, perms);
    } catch (err) {
      console.error('[Zapi] permissions poll failed:', err);
    }
  };
  void tick();
  permsTimer = setInterval(() => { void tick(); }, 5000);
};
const stopPermsPoll = (): void => {
  if (!permsTimer) return;
  clearInterval(permsTimer);
  permsTimer = null;
};

app.on('before-quit', () => { isAppQuitting = true; });

// ── Helpers ────────────────────────────────────────────────────────────

function createTrayIcon(): Electron.NativeImage {
  // Resolve the icon relative to the built JS. In dev that's
  // dist/main/main/ → ../../../assets; in a packaged app the same
  // path resolves inside the asar bundle since assets/** is shipped.
  const assetRoot = path.join(__dirname, '../../../assets');
  const size32 = path.join(assetRoot, 'icons', '32x32.png');
  const size16 = path.join(assetRoot, 'icons', '16x16.png');

  try {
    // Windows renders tray icons from a multi-size .ico crisply at any
    // DPI; a 16px PNG gets upscaled and blurry at 125%/150% scaling.
    if (process.platform === 'win32') {
      const ico = nativeImage.createFromPath(path.join(assetRoot, 'icon.ico'));
      if (!ico.isEmpty()) return ico;
    }

    const primary = process.platform === 'darwin' ? size32 : size16;
    const img = nativeImage.createFromPath(primary);
    if (img.isEmpty()) throw new Error('empty tray icon image');

    // On macOS attach a 2x representation so the tray icon stays
    // crisp on Retina. On Windows/Linux resize to 16 for the tray.
    if (process.platform === 'darwin') {
      const hi = nativeImage.createFromPath(size32);
      if (!hi.isEmpty()) {
        img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
      }
      return img.resize({ width: 16, height: 16 });
    }
    return img.resize({ width: 16, height: 16 });
  } catch (err) {
    console.error('[Zapi] tray icon load failed, using fallback:', err);
    // Generated fallback — cornflower-blue filled circle so the tray
    // entry is still clickable even if the PNGs are missing.
    const size = 32;
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = size / 2, cy = size / 2, r = size / 2 - 2;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const i = (y * size + x) * 4;
        if (dist <= r) {
          canvas[i] = 100;
          canvas[i + 1] = 149;
          canvas[i + 2] = 237;
          canvas[i + 3] = 255;
        }
      }
    }
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }
}

function sendToPanel(channel: string, ...args: unknown[]): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send(channel, ...args);
  }
}

function sendToOverlays(channel: string, ...args: unknown[]): void {
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

/**
 * Pick a single overlay to receive an event. Used for things that must
 * not duplicate across displays — TTS audio playback being the canonical
 * case (broadcasting to all overlays plays the buffer once per display
 * and audibly doubles).
 */
function sendToOneOverlay(channel: string, ...args: unknown[]): void {
  const target = overlayWindows.find((w) => !w.isDestroyed());
  if (target) target.webContents.send(channel, ...args);
}

function sendToOverlayById(wcId: number, channel: string, ...args: unknown[]): void {
  const target = overlayWindows.find((w) => !w.isDestroyed() && w.webContents.id === wcId);
  if (target) target.webContents.send(channel, ...args);
}

/**
 * Route mic capture to one overlay and remember which — when that overlay
 * is later destroyed (display removed, renderer crash) the audio source
 * dies silently, so the tracker lets us stop/re-arm instead of leaving a
 * turn waiting on chunks that will never arrive.
 */
function startCaptureOn(mode: CaptureMode): void {
  const target = overlayWindows.find((w) => !w.isDestroyed());
  if (!target) return;
  audioCaptureWcId = target.webContents.id;
  audioCaptureMode = mode;
  target.webContents.send(AUDIO_IPC.START_CAPTURE, { mode });
}

function stopCapture(): void {
  const id = audioCaptureWcId;
  audioCaptureWcId = null;
  audioCaptureMode = null;
  // Aim the stop at the tracked overlay; fall back to the usual
  // first-alive pick if the tracker was somehow cleared.
  if (id !== null) sendToOverlayById(id, AUDIO_IPC.STOP_CAPTURE);
  else sendToOneOverlay(AUDIO_IPC.STOP_CAPTURE);
}

function findOverlayContainingPoint(pos: { x: number; y: number }): BrowserWindow | undefined {
  return overlayWindows.find((w) => {
    if (w.isDestroyed()) return false;
    const display = overlayDisplayByWebContents.get(w.webContents.id);
    if (!display) return false;
    const b = display.bounds;
    return (
      pos.x >= b.x && pos.x < b.x + b.width &&
      pos.y >= b.y && pos.y < b.y + b.height
    );
  });
}

/**
 * Action kinds whose echo carries a real desktop point — mirrors the
 * driver's POINTER_KINDS and the renderer's SPATIAL_ECHO_KINDS. Every
 * other kind (type, key, scroll, wait) arrives with 0,0 filler coords,
 * which point-routing would dump on whichever display owns the origin.
 * Those chips belong beside the status pill on the display the user is
 * actually looking at — the cursor's, falling back to the primary.
 */
const POINTER_ECHO_KINDS: ReadonlySet<string> = new Set([
  'move', 'click', 'dclick', 'rclick', 'drag',
]);

function overlayForEcho(a: { x: number; y: number; kind: string }): BrowserWindow | undefined {
  if (POINTER_ECHO_KINDS.has(a.kind)) {
    return findOverlayContainingPoint({ x: a.x, y: a.y });
  }
  const cursorTarget = findOverlayContainingPoint(screen.getCursorScreenPoint());
  if (cursorTarget) return cursorTarget;
  const pb = screen.getPrimaryDisplay().bounds;
  return (
    findOverlayContainingPoint({ x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 }) ??
    overlayWindows.find((w) => !w.isDestroyed())
  );
}

function sendToStream(channel: string, ...args: unknown[]): void {
  if (streamWindow && !streamWindow.isDestroyed()) {
    streamWindow.webContents.send(channel, ...args);
  }
}

function sendToAll(channel: string, ...args: unknown[]): void {
  sendToPanel(channel, ...args);
  sendToOverlays(channel, ...args);
  sendToStream(channel, ...args);
}

// ── App Lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Windows 10/11 resolve the toaster (Action Center + toast) against the
  // AppUserModelID. Electron's default is `electron.app.<name>`, which the OS
  // can't attribute to an installed shortcut — so Notification.show() silently
  // no-ops and agent completions never appear. Bind it to the same appId
  // electron-builder stamps into the exe so toasts survive a real install.
  // Must run after ready and before any Notification is constructed.
  app.setAppUserModelId('com.zapi.app');

  // A process that lost the single-instance race already called
  // app.quit() — it must not boot tray/overlays/shortcuts on the way out.
  if (!gotLock) return;
  confirmGpuHealthy();

  // All renderers are local + context-isolated, but with no handler
  // Electron grants every permission request — allowlist only what Zapi
  // needs (mic capture; screen-capture probing; clipboard for the
  // stream's copy buttons) so nothing else can be handed out by default.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'clipboard-read' ||
      permission === 'clipboard-sanitized-write',
    );
  });

  // Initialize companion manager
  companion = new CompanionManager({
    onVoiceStateChanged: (state) => {
      lastVoiceState = state;
      sendToAll(IPC.VOICE_STATE_CHANGED, state);
      updateStreamForVoiceState(state);
    },
    onTranscriptUpdate: (result) => sendToAll(IPC.TRANSCRIPT_UPDATE, result),
    onAiResponseChunk: (chunk) => {
      sendToPanel(IPC.AI_RESPONSE_CHUNK, chunk);
      sendToStream(IPC.AI_RESPONSE_CHUNK, chunk);
    },
    onAiResponseComplete: (text) => {
      sendToPanel(IPC.AI_RESPONSE_COMPLETE, text);
      sendToStream(IPC.AI_RESPONSE_COMPLETE, text);
    },
    onError: (message) => {
      sendToPanel(IPC.AI_ERROR, message);
      sendToStream(IPC.AI_ERROR, message);
    },
    onScene: (scene) => {
      sceneActive = !!scene;
      // Broadcast to every overlay: a scene's cues can span displays
      // (per-cue screenIndex), so single-target routing would drop the
      // rest. Each renderer culls strokes outside its own display bounds
      // (InkLayer) and hops point cues only when they land on its display
      // (OverlayApp), so extra copies are inert on the wrong screens.
      sendToOverlays(IPC.SCENE, scene);
      sendToStream(IPC.SCENE, scene);
      // Keep the stream visible across the scene in 'responses' mode,
      // even after voice state has returned to idle. When the scene
      // ends we re-evaluate based on the current voice state.
      if (scene) applyStreamVisibility(companion.getSettings().streamVisibility);
      else updateStreamForVoiceState(lastVoiceState);
    },
    onSceneCue: (i) => {
      // Beats broadcast too — each overlay reveals only the strokes
      // inside its own bounds while every screen stays beat-synchronized.
      sendToOverlays(IPC.SCENE_CUE, i);
      sendToStream(IPC.SCENE_CUE, i);
      // The scene scheduler emits beat `null` after the last cue dwell,
      // just before emitting scene(null). Clear the active flag here
      // too so a status reader doesn't briefly observe sceneActive=true
      // with no current beat.
      if (i === null) sceneActive = false;
    },
    onAgentStatus: (status) => {
      // Rebuild the tray on phase flips only — per-action message updates
      // would rebuild the menu dozens of times per run for no benefit.
      const phaseChanged = status.phase !== lastAgentStatus?.phase;
      lastAgentStatus = status;
      sendToAll(IPC.AGENT_STATUS, status);
      if (phaseChanged) rebuildTrayMenu();
      // UI sounds, broadcast so every display's overlay can play the cue:
      // launch chirp on the run-start status (thinking at step 0 is the
      // only step-0 thinking emit), outcome sting on done/failed.
      if (status.phase === 'thinking' && status.step === 0) {
        sendToOverlays(IPC.PLAY_SFX, 'agent-launch');
      } else if (status.phase === 'done') {
        sendToOverlays(IPC.PLAY_SFX, 'agent-done');
        notifyAgentOutcome(status, 'done');
      } else if (status.phase === 'failed') {
        sendToOverlays(IPC.PLAY_SFX, 'agent-needs-you');
        notifyAgentOutcome(status, 'failed');
      }
    },
    onAgentAction: (a) => {
      // Pointer echoes land where the action happened; coord-less kinds
      // ride a 0,0 filler, so route those to the cursor's display — the
      // chip renders beside the status pill, not on the origin display.
      // The stream also gets a copy for its live action feed.
      const target = overlayForEcho(a);
      if (target) target.webContents.send(IPC.AGENT_ACTION, a);
      sendToStream(IPC.AGENT_ACTION, a);
    },
    onTypeFulfilled: (req) => {
      // Toast goes on a single overlay (cursor display) so the user
      // sees one notification, not one per monitor.
      sendToOneOverlay(IPC.TYPE_FULFILLED, req);
      sendToStream(IPC.TYPE_FULFILLED, req);
    },
    onSettingsChanged: (s) => {
      clickyCursorEnabled = s.isClickyCursorEnabled;
      sendToPanel(IPC.SETTINGS_CHANGED, s);
      // Mode checkboxes in the tray menu mirror settings — rebuild so a
      // change made in the panel (or via voice command) stays in sync.
      rebuildTrayMenu();
    },
    onMemoryStatsChanged: (stats) => sendToPanel(IPC.MEMORY_STATS, stats),
    onChatEntryAdded: (entry) => sendToPanel(IPC.CHAT_ENTRY_ADDED, entry),
    // Mic capture must NEVER fan out across overlays — each overlay
    // would open its own getUserMedia + AudioContext and stream chunks
    // back, which on a multi-monitor setup made companion-manager append
    // the same audio N times into one buffer. Whisper then transcribed
    // an interleaved mess. Single overlay only.
    onStartAudioCapture: (mode) => startCaptureOn(mode),
    onStopAudioCapture: () => stopCapture(),
    // 'play-audio'/'stop-audio' are raw channel literals on purpose —
    // the audio pipe predates the shared IPC const (inherited from
    // heyclicky), and preload/index.ts listens on the same literals
    // (:358–365) with scripts/preload-check.mts allow-listing them.
    // Moving them into the frozen shared/types.ts contract requires a
    // coordinated preload+types rename — deliberately left raw.
    onPlayAudio: (buf) => sendToOneOverlay('play-audio', buf),
    // Broadcast, not sendToOneOverlay: playback targets a single overlay,
    // but an earlier buffer may still be playing on a different display
    // after the cursor moved, and only the holding overlay can silence it.
    onStopAudio: () => sendToOverlays('stop-audio'),
    onCursorVisibilityChanged: (enabled) => {
      clickyCursorEnabled = enabled;
      applyOverlayVisibility(overlayWindows);
    },
    onStreamVisibilityChanged: (v) => applyStreamVisibility(v),
    // Hands-free acknowledgment chirp: a VAD utterance passed the wake
    // gate and became a turn.
    onVadAccepted: () => sendToOverlays(IPC.PLAY_SFX, 'heard'),
    // OS-voice TTS fallback: broadcast, same one-voice rule as the
    // chimes — OverlayApp only speaks on the cursor-bearing display,
    // so a fan-out can't echo the reply once per monitor.
    onSpeakText: (text, rate) => sendToOverlays(IPC.SPEAK_TEXT, text, rate),
  });

  // Seed the cached flag once — from here on the settings-changed and
  // cursor-visibility callbacks keep it current.
  clickyCursorEnabled = companion.getSettings().isClickyCursorEnabled;

  // Create tray
  tray = new Tray(createTrayIcon());
  tray.setToolTip('ZAPI');

  console.log('[Zapi] Tray created, registering click handler...');

  tray.on('click', () => togglePanel());
  tray.on('double-click', () => togglePanel());
  rebuildTrayMenu();

  // Create overlay windows for each display. Topology changes diff
  // against the existing set so plugging in one new monitor doesn't
  // tear down and rebuild every overlay (each rebuild has to reload
  // the renderer bundle from scratch).
  rebuildOverlays();
  // Hot-plug storms (docks, resolution toggles, GPU resets) fire these in
  // bursts — coalesce into one sync ~300 ms after the last event rather
  // than churning overlay destroy/recreate per event. The deferred body
  // re-checks isAppQuitting so a queued sync can't spawn windows during
  // teardown.
  const syncDisplaysSoon = (): void =>
    scheduleDisplaySync(() => {
      if (!isAppQuitting) syncOverlaysToDisplays();
    });
  screen.on('display-added', syncDisplaysSoon);
  screen.on('display-removed', syncDisplaysSoon);
  // Resolution / DPI / arrangement changes (docking a laptop, changing
  // scaling in Settings) keep the same display ids but move the bounds.
  // Without this the overlay stayed at the stale rect, so the blue
  // cursor pointed at the wrong spot or lived off-screen entirely.
  screen.on('display-metrics-changed', (_e, display, changed) => {
    if (!changed.some((c) => c === 'bounds' || c === 'scaleFactor' || c === 'workArea')) return;
    syncOverlayBounds(display);
  });

  // Stream window is created lazily — the default `streamVisibility:'off'`
  // means a fresh-install user used to have an entire Chromium renderer
  // running in the background just to receive IPC nobody would ever see.
  applyStreamVisibility(companion.getSettings().streamVisibility);

  // Sync the OS login-item state with our stored preference. Handles
  // the case where the user disables the login item externally (e.g.
  // via System Settings) — next launch reconciles the two.
  // Skipped in dev: unpackaged it would register the bare electron
  // binary as a startup item.
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: companion.getSettings().launchAtLogin });
    } catch (err) {
      console.error('[Zapi] initial setLoginItemSettings failed:', err);
    }
  }

  // Register global push-to-talk shortcut.
  //
  // Two modes, chosen by the `pttMode` setting:
  //   'hold'   — Windows/Linux only. globalShortcut fires repeatedly on
  //              OS key-repeat while the accelerator is held; we start on
  //              the first fire and stop after 250 ms of silence (release).
  //   'toggle' — first tap starts, second tap stops. Required on macOS,
  //              where globalShortcut fires exactly once per press and
  //              Electron exposes no key-up event.
  //
  // On macOS we always behave as 'toggle' regardless of the stored setting,
  // so a user who set 'hold' on another platform doesn't get a stuck mic.
  const isMac = process.platform === 'darwin';
  let pttDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pttActive = false;
  /** Number of accelerator fires seen during the current hold. */
  let pttFireCount = 0;
  let currentShortcut = '';

  // 'hold' timing. The OS doesn't start auto-repeating a held key until
  // its repeat-delay elapses — on Windows that's 250 ms at the fastest
  // setting and 1 s at the slowest (default ≈ 500 ms). The old fixed
  // 250 ms silence window therefore expired *before the first repeat
  // ever arrived*: recording stopped after a quarter second, a useless
  // sliver of audio went to Whisper, then the repeat kicked in and
  // started a brand-new turn — over and over while the key was held.
  // Give the first repeat a generous window; once repeats are flowing
  // (~30 Hz) a tight window is plenty.
  const PTT_HOLD_INITIAL_GRACE_MS = 1100;
  const PTT_HOLD_REPEAT_GRACE_MS = 250;

  const pttHandler = () => {
    // Setup verification: prove the binding reaches us without
    // actually opening the mic.
    sendToPanel(IPC.PTT_SHORTCUT_FIRED);
    if (pttTestMode) return;

    const mode = isMac ? 'toggle' : companion.getSettings().pttMode;

    if (mode === 'toggle') {
      if (!pttActive) {
        pttActive = true;
        // If startPushToTalk's underlying transcription provider fails
        // to initialise, companion silently flips isRecording back to
        // false. Reconcile the local toggle so the next tap retries
        // the start path instead of issuing a stop on nothing.
        void companion.startPushToTalk()
          .then(() => {
            pttActive = companion.recording;
          })
          .catch((err) => console.error('[Zapi] startPushToTalk failed:', err));
      } else {
        pttActive = false;
        void companion.stopPushToTalk()
          .then(() => {
            pttActive = companion.recording;
          })
          .catch((err) => console.error('[Zapi] stopPushToTalk failed:', err));
      }
      return;
    }

    // 'hold' mode (Windows/Linux): rely on key-repeat, debounce on silence.
    if (pttDebounceTimer) {
      clearTimeout(pttDebounceTimer);
      pttDebounceTimer = null;
    }
    if (!pttActive) {
      pttActive = true;
      pttFireCount = 0;
      void companion.startPushToTalk().catch((err) => console.error('[Zapi] startPushToTalk failed:', err));
    }
    pttFireCount += 1;
    const grace = pttFireCount === 1 ? PTT_HOLD_INITIAL_GRACE_MS : PTT_HOLD_REPEAT_GRACE_MS;
    pttDebounceTimer = setTimeout(() => {
      pttActive = false;
      pttFireCount = 0;
      pttDebounceTimer = null;
      void companion.stopPushToTalk().catch((err) => console.error('[Zapi] stopPushToTalk failed:', err));
    }, grace);
  };

  ipcMain.on(IPC.PTT_TEST_START, () => setPttTestMode(true));
  ipcMain.on(IPC.PTT_TEST_STOP, () => setPttTestMode(false));

  function registerPttShortcut(accelerator: string): boolean {
    const previous = currentShortcut;
    try {
      if (previous) globalShortcut.unregister(previous);
      const ok = globalShortcut.register(accelerator, pttHandler);
      if (ok) {
        currentShortcut = accelerator;
        return true;
      }
    } catch (err) {
      console.error('[Zapi] shortcut register failed:', err);
    }
    // Surface the failure — a silently ignored hotkey reads as a dead app.
    // The last-known-good binding is restored below, so what still works
    // matches what the settings UI shows after companion reverts.
    sendToPanel(
      IPC.AI_ERROR,
      `Couldn't register shortcut "${accelerator}" — it may be taken by another app. Try a different combo.`,
    );
    // Failure path: always try to restore the last-known-good binding so
    // the user isn't left without any shortcut at all, even when the
    // failing register call used the same accelerator as before.
    if (previous) {
      try {
        globalShortcut.register(previous, pttHandler);
        currentShortcut = previous;
      } catch (err) {
        console.error('[Zapi] shortcut rollback failed:', err);
        currentShortcut = '';
      }
    }
    return false;
  }

  registerPttShortcut(companion.getSettings().pushToTalkShortcut);
  companion.setShortcutReRegister(registerPttShortcut);

  // ── Push-to-dictate (second hotkey) ─────────────────────────────────
  // Same mechanics as PTT — toggle/hold honoring pttMode, forced to
  // 'toggle' on macOS — but the recorded turn is FORCED dictation via the
  // start/stopDictationPushToTalk pair, independent of dictationEnabled.
  // No pttTestMode gate: that flag belongs to setup's PTT verification.
  let dictationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let dictationActive = false;
  /** Number of accelerator fires seen during the current hold. */
  let dictationFireCount = 0;
  let currentDictationShortcut = '';

  const dictationHandler = () => {
    const mode = isMac ? 'toggle' : companion.getSettings().pttMode;

    if (mode === 'toggle') {
      if (!dictationActive) {
        dictationActive = true;
        // Mirror the PTT reconcile: a failed start flips isRecording back
        // to false, so sync the local toggle to companion state.
        void companion.startDictationPushToTalk()
          .then(() => {
            dictationActive = companion.recording;
          })
          .catch((err) => console.error('[Zapi] startDictationPushToTalk failed:', err));
      } else {
        dictationActive = false;
        void companion.stopDictationPushToTalk()
          .then(() => {
            dictationActive = companion.recording;
          })
          .catch((err) => console.error('[Zapi] stopDictationPushToTalk failed:', err));
      }
      return;
    }

    // 'hold' mode (Windows/Linux): rely on key-repeat, debounce on silence.
    if (dictationDebounceTimer) {
      clearTimeout(dictationDebounceTimer);
      dictationDebounceTimer = null;
    }
    if (!dictationActive) {
      dictationActive = true;
      dictationFireCount = 0;
      void companion.startDictationPushToTalk().catch((err) => console.error('[Zapi] startDictationPushToTalk failed:', err));
    }
    dictationFireCount += 1;
    const grace = dictationFireCount === 1 ? PTT_HOLD_INITIAL_GRACE_MS : PTT_HOLD_REPEAT_GRACE_MS;
    dictationDebounceTimer = setTimeout(() => {
      dictationActive = false;
      dictationFireCount = 0;
      dictationDebounceTimer = null;
      void companion.stopDictationPushToTalk().catch((err) => console.error('[Zapi] stopDictationPushToTalk failed:', err));
    }, grace);
  };

  function registerDictationShortcut(accelerator: string): boolean {
    const previous = currentDictationShortcut;
    try {
      if (previous) globalShortcut.unregister(previous);
      const ok = globalShortcut.register(accelerator, dictationHandler);
      if (ok) {
        currentDictationShortcut = accelerator;
        return true;
      }
    } catch (err) {
      console.error('[Zapi] dictation shortcut register failed:', err);
    }
    sendToPanel(
      IPC.AI_ERROR,
      `Couldn't register dictation shortcut "${accelerator}" — it may be taken by another app. Try a different combo.`,
    );
    // Failure path mirrors PTT: restore the last-known-good binding so
    // the user isn't left without any dictation shortcut at all.
    if (previous) {
      try {
        globalShortcut.register(previous, dictationHandler);
        currentDictationShortcut = previous;
      } catch (err) {
        console.error('[Zapi] dictation shortcut rollback failed:', err);
        currentDictationShortcut = '';
      }
    }
    return false;
  }

  registerDictationShortcut(companion.getDictationShortcut());
  companion.setDictationShortcutReRegister(registerDictationShortcut);

  function suspendPttShortcut(): void {
    if (currentShortcut) {
      try { globalShortcut.unregister(currentShortcut); } catch { /* no-op */ }
    }
    // Shortcut capture must silence both hotkeys — otherwise the
    // dictation binding fires mid-capture while recording the new PTT key.
    if (currentDictationShortcut) {
      try { globalShortcut.unregister(currentDictationShortcut); } catch { /* no-op */ }
    }
  }
  function resumePttShortcut(): void {
    const desired = companion.getSettings().pushToTalkShortcut;
    registerPttShortcut(desired);
    registerDictationShortcut(companion.getDictationShortcut());
  }
  ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, () => suspendPttShortcut());
  ipcMain.on(IPC.RESUME_PUSH_TO_TALK_SHORTCUT, () => resumePttShortcut());

  // ── IPC Handlers ───────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_SETTINGS, () => companion.getSettings());
  ipcMain.handle(IPC.GET_PERMISSIONS, () => companion.getPermissions());
  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.VALIDATE_API_KEY, (_e, name, key: string) => validateApiKey(name, key));
  ipcMain.handle(IPC.VALIDATE_STORED_API_KEY, (_e, name) => validateStoredApiKey(name));

  // Setup mic check: capture runs, levels flow to the panel, nothing is
  // transcribed. The overlay owns the mic; relay its telemetry here.
  ipcMain.on(IPC.MIC_TEST_START, () => companion.startMicTest());
  ipcMain.on(IPC.MIC_TEST_STOP, () => {
    companion.stopMicTest();
    // stopMicTest stops capture outright — with always-on enabled the VAD
    // gate would stay dead until the next state change. Mirror the
    // post-turn resume gate (companion-manager: never under a recording,
    // never while the agent loop is driving the mic).
    if (
      companion.getSettings().alwaysOnEnabled &&
      !companion.recording &&
      lastVoiceState !== 'acting'
    ) {
      startCaptureOn('vad');
    }
  });
  ipcMain.on(IPC.MIC_LEVEL, (_e, level: number) => sendToPanel(IPC.MIC_LEVEL, level));
  ipcMain.on(IPC.MIC_ERROR, (_e, message: string) => {
    console.error('[Zapi] mic capture error from overlay:', message);
    sendToPanel(IPC.MIC_ERROR, message);
    sendToPanel(IPC.AI_ERROR, `microphone unavailable — ${message}`);
    // The mic died while companion may still think it's recording —
    // ask it to reset the in-flight turn (safe no-op when idle).
    companion.resetFromMicError();
  });

  ipcMain.on(IPC.SET_MODEL, (_e, model) => companion.setModel(model));
  ipcMain.on(IPC.SET_OPENAI_MODEL, (_e, model) => companion.setOpenAIModel(model));
  ipcMain.on(IPC.SET_MIND_PROVIDER, (_e, provider) => companion.setMindProvider(provider));
  ipcMain.on(IPC.SET_REASONING_DEPTH, (_e, depth) => companion.setReasoningDepth(depth));
  ipcMain.on(IPC.SET_REPLY_TONE, (_e, tone) => companion.setReplyTone(tone));
  ipcMain.on(IPC.SET_VOICE_ID, (_e, id) => companion.setVoiceId(id));
  ipcMain.on(IPC.SET_VOICE_SPEED, (_e, speed) => companion.setVoiceSpeed(speed));
  ipcMain.on(IPC.SET_VOICE_STABILITY, (_e, stab) => companion.setVoiceStability(stab));
  ipcMain.on(IPC.SET_SPEAK_REPLIES, (_e, enabled) => companion.setSpeakReplies(enabled));
  ipcMain.on(IPC.TOGGLE_CURSOR, (_e, enabled) => companion.toggleCursor(enabled));
  ipcMain.on(IPC.SET_LAUNCH_AT_LOGIN, (_e, enabled) => companion.setLaunchAtLogin(enabled));
  ipcMain.on(IPC.SET_PUSH_TO_TALK_SHORTCUT, (_e, accel: string) => companion.setPushToTalkShortcut(accel));
  ipcMain.on(IPC.SET_PTT_MODE, (_e, mode) => companion.setPttMode(mode));
  ipcMain.on(IPC.SET_AUTO_TYPE_ENABLED, (_e, enabled: boolean) => companion.setAutoTypeEnabled(enabled));
  ipcMain.on(IPC.SET_STREAM_VISIBILITY, (_e, v: StreamVisibility) => companion.setStreamVisibility(v));
  ipcMain.on(IPC.SET_STREAM_WINDOW_BOUNDS, (_e, b: StreamWindowBounds) => companion.setStreamWindowBounds(b));
  ipcMain.on(IPC.SET_TTS_PROVIDER, (_e, p) => companion.setTtsProvider(p));
  ipcMain.on(IPC.SET_FISH_VOICE_ID, (_e, id) => companion.setFishVoiceId(id));
  ipcMain.on(IPC.SET_FISH_TTS_MODEL, (_e, model) => companion.setFishTtsModel(model));
  // Mode switches
  ipcMain.on(IPC.SET_ALWAYS_ON, (_e, enabled: boolean) => companion.setAlwaysOn(enabled));
  ipcMain.on(IPC.SET_DICTATION, (_e, enabled: boolean) => companion.setDictation(enabled));
  ipcMain.on(IPC.SET_DICTATION_SHORTCUT, (_e, accel: string) => companion.setDictationShortcut(accel));
  ipcMain.on(IPC.SET_AGENT_ENABLED, (_e, enabled: boolean) => companion.setAgentEnabled(enabled));
  ipcMain.on(IPC.SET_AGENT_MAX_STEPS, (_e, n: number) => companion.setAgentMaxSteps(n));
  ipcMain.on(IPC.SET_CUSTOM_OPENAI_MODEL, (_e, m: string) => companion.setCustomOpenAIModel(m));
  ipcMain.on(IPC.SET_OPENAI_BASE_URL, (_e, v: string) => companion.setOpenAIBaseUrl(v));
  // A named agentId stops just that agent's run; a bare stop (tray/stream
  // button, or the voice command) stops everything currently running.
  ipcMain.on(IPC.AGENT_STOP, (_e, agentId?: string) => companion.stopAgent(agentId));
  // Always-on mode: the overlay's VAD ships each finished utterance as
  // one PCM buffer; companion decides whether it becomes a turn.
  ipcMain.on(IPC.VAD_UTTERANCE, (_e, buffer: Buffer) => {
    // Sync throws in ipcMain.on propagate as uncaughtException — one bad
    // utterance must not crash the process.
    try {
      companion.handleVadUtterance(buffer);
    } catch (err) {
      console.error('[Zapi] handleVadUtterance failed:', err);
    }
  });
  // (clearStream used to be a needless renderer→main→same-renderer
  // round trip — the stream's "clear" button now updates its own
  // state directly, no IPC.)
  ipcMain.on(IPC.REQUEST_PERMISSION, (_e, kind) => {
    void companion.requestPermission(kind).catch((err) => {
      console.error('[Zapi] requestPermission failed:', err);
    });
  });
  ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url) => {
    // Outbound web/mail schemes only — never file://, smb://, or custom
    // handlers (a compromised renderer could NTLM-relay via file/smb).
    // OS deeplinks don't come through here — permission panes are opened
    // companion-side via openDeepLink.
    if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url)) return;
    shell.openExternal(url).catch((err) => {
      console.error('[Zapi] openExternal failed:', err);
    });
  });
  ipcMain.on(IPC.QUIT_APP, () => app.quit());
  ipcMain.on(IPC.REPLAY_ONBOARDING, () => companion.replayOnboarding());
  ipcMain.on(IPC.COMPLETE_ONBOARDING, () => {
    // First completion only: onboardingComplete persists, so this fires
    // once per fresh onboarding — never on plain launches. The delay lets
    // the panel settle on its main view before ink starts drawing.
    const firstTime = !companion.getSettings().onboardingComplete;
    companion.completeOnboarding();
    if (firstTime) {
      setTimeout(() => companion.playDemoScene(), 800);
    }
  });
  ipcMain.on(IPC.SET_GROQ_MODEL, (_e, model) => companion.setGroqModel(model));

  // ── Routines (Phase D) ───────────────────────────────────────────────
  // Mutations persist, then hand the scheduler a reload so a newly due
  // interval routine is evaluated immediately instead of waiting for the
  // next 15 s tick. Companion owns the emit so the panel/tray re-render.
  ipcMain.handle(IPC.ROUTINE_LIST, () => settingsStore.listRoutines());
  ipcMain.on(IPC.ROUTINE_UPSERT, (_e, routine) => {
    try {
      const saved = settingsStore.upsertRoutine(routine);
      companion.reloadRoutines();
      companion.emitAgentsChanged();
      console.log(`[Zapi] routine saved: ${saved.name} (${saved.id})`);
    } catch (err) {
      companion.reportAgentError(
        `couldn't save routine — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  ipcMain.on(IPC.ROUTINE_DELETE, (_e, { id }: { id: string }) => {
    if (!settingsStore.deleteRoutine(id)) {
      companion.reportAgentError("couldn't delete that routine — not found");
      return;
    }
    companion.reloadRoutines();
    companion.emitAgentsChanged();
  });
  ipcMain.on(IPC.SET_ROUTINES_MUTED, (_e, muted: boolean) => {
    settingsStore.setRoutinesMuted(muted);
    // Mute only silences announcements, never a run — so no reload needed,
    // but the panel still needs the new value.
    companion.emitAgentsChanged();
  });

  // ── Artifacts + suggestions ───────────────────────────────────────
  // Reads hit the stores directly (same pattern as routines/usage);
  // anything that runs a turn goes through companion so the pipeline's
  // turn guards apply uniformly.
  // Open the agent's workspace folder in Explorer. Scaffold first so a
  // brand-new agent still has a real folder to open.
  ipcMain.on(IPC.OPEN_AGENT_WORKSPACE, (_e, { agentId }: { agentId?: string }) => {
    const id = agentId || 'main';
    const profile = settingsStore.listAgents().find((a) => a.id === id);
    const ws = agentWorkspace.ensureWorkspace(id, profile);
    void shell
      .openPath(ws.dir)
      .then((errText) => {
        if (errText) companion.reportAgentError(`couldn't open the workspace — ${errText}`);
      })
      .catch((err: unknown) => {
        companion.reportAgentError(
          `couldn't open the workspace — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });

  ipcMain.handle(IPC.ARTIFACT_LIST, (_e, agentId?: string) => artifactStore.list(agentId));
  ipcMain.on(IPC.ARTIFACT_OPEN, (_e, { id }: { id: string }) => {
    const artifact = artifactStore.byId(id);
    if (!artifact) {
      companion.reportAgentError("couldn't find that file — it may have been cleaned up");
      return;
    }
    // openPath resolves with an error STRING on failure rather than
    // rejecting — a missing/unopenable file must surface either way.
    void shell
      .openPath(artifact.path)
      .then((errText) => {
        if (errText) companion.reportAgentError(`couldn't open ${artifact.title} — ${errText}`);
      })
      .catch((err: unknown) => {
        companion.reportAgentError(
          `couldn't open ${artifact.title} — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  });
  ipcMain.on(IPC.ARTIFACT_REVEAL, (_e, { id }: { id: string }) => {
    const artifact = artifactStore.byId(id);
    if (!artifact) {
      companion.reportAgentError("couldn't find that file — it may have been cleaned up");
      return;
    }
    try {
      shell.showItemInFolder(artifact.path);
    } catch (err) {
      companion.reportAgentError(
        `couldn't reveal ${artifact.title} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  ipcMain.handle(IPC.SUGGESTION_LIST, (_e, agentId?: string) => suggestionStore.list(agentId));
  ipcMain.on(IPC.SUGGESTION_ACCEPT, (_e, { id }: { id: string }) => companion.acceptSuggestion(id));
  ipcMain.on(IPC.SUGGESTION_DISMISS, (_e, { id }: { id: string }) => companion.dismissSuggestion(id));
  ipcMain.on(IPC.SUGGESTION_REFRESH, () => {
    void companion.refreshSuggestions().catch((err) => {
      console.error('[Zapi] suggestion refresh failed:', err);
    });
  });

  // Preload sends the bare agentId; the channel doc predates that and
  // says { agentId } — accept either so a straggler build can't wedge it.
  ipcMain.on(IPC.CHAT_MARK_READ, (_e, payload: string | { agentId?: string }) => {
    const agentId = typeof payload === 'string' ? payload : payload?.agentId;
    if (agentId) chatHistory.markRead(agentId);
  });

  // A typed chat message runs the same turn shape as a routine — the
  // pipeline decides whether the queue is free.
  ipcMain.on(IPC.TEXT_TURN, (_e, { agentId, text }: { agentId?: string; text?: string }) => {
    void companion
      .runTextTurn(agentId ?? 'main', text ?? '')
      .catch((err) => console.error('[Zapi] text turn failed:', err));
  });

  ipcMain.on(IPC.CLEAR_CONTEXT, () => companion.clearContext());
  ipcMain.handle(IPC.COMPACT_CONTEXT, () => companion.compactContext());
  ipcMain.on(IPC.PLAY_VOICE_PREVIEW, (_e, voiceId) => {
    void companion.playVoicePreview(voiceId).catch((err) => {
      console.error('[Zapi] voice preview failed:', err);
    });
  });
  ipcMain.handle(IPC.GET_MEMORY_STATS, () => companion.getMemoryStats());
  // Monthly usage counters (talk turns / agent runs / dictated lines)
  // — reads the persisted store directly, no companion round-trip.
  ipcMain.handle(IPC.GET_USAGE_STATS, () => usageStore.getStats());
  // Omitting agentId reads/clears every agent's history — the panel's
  // global affordance — while a specific id scopes to one agent.
  ipcMain.handle(IPC.GET_CHAT_HISTORY, (_e, agentId?: string) => companion.getChatHistory(agentId));
  ipcMain.on(IPC.CLEAR_CHAT_HISTORY, (_e, agentId?: string) => companion.clearChatHistory(agentId));

  // ── Agent profiles (multi-agent) ─────────────────────────────────────
  // Phase A is data-only: profiles persist and render, but voice still
  // routes to 'main'. Phase B wires per-agent runtimes.
  ipcMain.handle(IPC.AGENT_LIST, () => settingsStore.listAgents());
  ipcMain.on(IPC.AGENT_CREATE, (_e, init: { name: string; kaomoji?: string; color?: string }) => {
    try {
      const created = settingsStore.createAgent(init.name, init.kaomoji, init.color);
      console.log(`[Zapi] agent created: ${created.name} (${created.id})`);
      companion.emitAgentsChanged();
    } catch (err) {
      companion.reportAgentError(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.on(IPC.AGENT_RENAME, (_e, { id, name }: { id: string; name: string }) => {
    if (!settingsStore.renameAgent(id, name)) {
      companion.reportAgentError(`couldn't rename agent "${name}" — not found`);
      return;
    }
    companion.emitAgentsChanged();
  });
  ipcMain.on(IPC.AGENT_ARCHIVE, (_e, { id }: { id: string }) => {
    // Archiving 'main' is refused by the store (it's load-bearing). Any
    // other agent can't be mid-run yet — Phase A has one runtime — so
    // there is no in-flight work to stop.
    if (!settingsStore.archiveAgent(id)) {
      companion.reportAgentError("couldn't archive that agent — 'main' always stays");
      return;
    }
    companion.emitAgentsChanged();
  });

  // API Key Management
  ipcMain.on(IPC.SET_API_KEY, (_e, name, value) => companion.setApiKey(name, value));
  ipcMain.on(IPC.DELETE_API_KEY, (_e, name) => companion.deleteApiKey(name));
  ipcMain.handle(IPC.GET_API_KEY_STATUS, () => companion.getApiKeyStatus());

  // Model list for the OpenAI/ClinePass model picker: whatever the
  // configured endpoint (or api.openai.com) says it serves. Any failure
  // — no key, offline, non-2xx, weird JSON — returns [] and the panel
  // falls back to its hardcoded list.
  ipcMain.handle(IPC.LIST_REMOTE_MODELS, async (): Promise<string[]> => {
    const key = getApiKey('openai');
    if (!key) return [];
    const base =
      normalizeBase((settingsStore.get('openAIBaseUrl') ?? '').trim()) ||
      'https://api.openai.com';
    try {
      const res = await fetch(`${base}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? [])
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  });

  // Local Connection Management
  const ollamaAPI = new OllamaAPI();

  function emitLocalConnections(): void {
    const settings = companion.getSettings();
    sendToPanel(IPC.SETTINGS_CHANGED, settings);
  }

  ipcMain.handle(IPC.GET_LOCAL_CONNECTIONS, () => {
    return settingsStore.get('localConnections') ?? [];
  });

  ipcMain.handle(IPC.ADD_LOCAL_CONNECTION, (_e, conn: Omit<LocalConnection, 'id'>) => {
    const connections = settingsStore.get('localConnections') ?? [];
    const newConn: LocalConnection = { ...conn, id: randomUUID() };
    settingsStore.set('localConnections', [...connections, newConn]);
    emitLocalConnections();
    return newConn;
  });

  ipcMain.handle(IPC.UPDATE_LOCAL_CONNECTION, (_e, id: string, patch: Partial<LocalConnection>) => {
    const connections = settingsStore.get('localConnections') ?? [];
    const updated = connections.map((c) => (c.id === id ? { ...c, ...patch, id } : c));
    settingsStore.set('localConnections', updated);
    emitLocalConnections();
  });

  ipcMain.handle(IPC.DELETE_LOCAL_CONNECTION, (_e, id: string) => {
    const connections = settingsStore.get('localConnections') ?? [];
    settingsStore.set('localConnections', connections.filter((c) => c.id !== id));
    try { deleteApiKey(`local_${id}`); } catch { /* key may not exist */ }
    emitLocalConnections();
  });

  ipcMain.handle(IPC.TEST_LOCAL_CONNECTION, (_e, url: string, bearerToken?: string) => {
    return ollamaAPI.testConnection(url, bearerToken);
  });

  ipcMain.handle(IPC.SET_LOCAL_CONNECTION_KEY, (_e, id: string, token: string) => {
    setApiKey(`local_${id}`, token);
  });

  ipcMain.handle(IPC.DELETE_LOCAL_CONNECTION_KEY, (_e, id: string) => {
    try { deleteApiKey(`local_${id}`); } catch { /* key may not exist */ }
  });

  // Ollama Model Management
  ipcMain.handle(IPC.GET_OLLAMA_MODELS, (_e, url: string, bearerToken?: string) => {
    return ollamaAPI.getModelDetails(url, bearerToken);
  });

  ipcMain.on(IPC.PULL_OLLAMA_MODEL, (event, url: string, modelTag: string, bearerToken?: string) => {
    const controller = new AbortController();
    // The panel may be closed mid-pull — webContents.send on a destroyed
    // sender throws inside the promise chain (fatal unhandled rejection).
    const send = (channel: string, payload?: unknown): void => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
      } catch (err) {
        console.error('[Zapi] ollama pull update send failed:', err);
      }
    };
    ollamaAPI.pullModel(
      url,
      modelTag,
      bearerToken,
      (progress) => send(IPC.OLLAMA_PULL_PROGRESS, progress),
      controller.signal,
    ).then(() => {
      send(IPC.OLLAMA_PULL_COMPLETE, { model: modelTag });
    }).catch((err: Error) => {
      if (err.name !== 'AbortError') {
        send(IPC.OLLAMA_PULL_ERROR, { error: err.message });
      }
    });
  });

  ipcMain.handle(IPC.DELETE_OLLAMA_MODEL, (_e, url: string, modelName: string, bearerToken?: string) => {
    return ollamaAPI.deleteModel(url, modelName, bearerToken);
  });

  ipcMain.handle(IPC.CREATE_OLLAMA_MODEL, (_e, url: string, modelTag: string, modelfileJson: string, bearerToken?: string) => {
    return ollamaAPI.createModel(url, modelTag, modelfileJson, bearerToken);
  });

  // Audio capture: relay chunks from overlay renderer to companion.
  // Sync throws here are uncaughtException — guard the hot path.
  ipcMain.on(AUDIO_IPC.AUDIO_CHUNK, (_e, buffer: Buffer) => {
    try {
      companion.handleAudioChunk(buffer);
    } catch (err) {
      console.error('[Zapi] handleAudioChunk failed:', err);
    }
  });

  // Track cursor position for overlay rendering. Three optimisations vs
  // the naive 60-fps fanout:
  //   1. Skip the entire poll when "Show cursor" is off.
  //   2. 30 fps is plenty — the cursor companion has its own 50 ms CSS
  //      transition, so doubling the rate just doubled the IPC traffic.
  //   3. Only send to the overlay whose display the cursor is on. When
  //      the cursor leaves a display we send one "off" pulse to the old
  //      overlay so its `isCursorOnThisDisplay` state flips false; we
  //      stop sending updates to it until the cursor re-enters.
  let lastCursorTargetWcId: number | null = null;
  // Keep a ref so will-quit can clear it — an interval that throws or
  // outlives teardown would crash the exit path.
  cursorPollTimer = setInterval(() => {
    try {
      if (!clickyCursorEnabled) {
        // If we previously had a target, tell it to clear so a stale
        // companion cursor doesn't linger on the last screen.
        if (lastCursorTargetWcId !== null) {
          sendToOverlayById(lastCursorTargetWcId, IPC.CURSOR_POSITION, { x: -9999, y: -9999, off: true });
          lastCursorTargetWcId = null;
        }
        return;
      }
      const pos = screen.getCursorScreenPoint();
      const targetWin = findOverlayContainingPoint(pos);
      const targetId = targetWin?.webContents.id ?? null;
      if (targetId !== lastCursorTargetWcId && lastCursorTargetWcId !== null) {
        sendToOverlayById(lastCursorTargetWcId, IPC.CURSOR_POSITION, { x: -9999, y: -9999, off: true });
      }
      if (targetWin) {
        targetWin.webContents.send(IPC.CURSOR_POSITION, pos);
      }
      lastCursorTargetWcId = targetId;
    } catch (err) {
      console.error('[Zapi] cursor poll failed:', err);
    }
  }, 33);

  // Perms poll lifecycle is hoisted to module scope above; togglePanel()
  // wires it to the panel window's show/hide events on first creation.

  // Open the main window on first launch.
  togglePanel();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Stop the routine tick before teardown — a timer firing mid-quit would
  // start a turn against a half-destroyed pipeline.
  try {
    companion?.stopRoutines();
  } catch { /* companion may not exist yet */ }
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }
  stopPermsPoll();
  flushStreamBounds();
  // Without an explicit destroy Windows keeps a ghost tray icon until
  // the user hovers it.
  try {
    tray?.destroy();
  } catch { /* already gone */ }
  tray = null;
  // Drain any pending store writes before exit — each of these uses the
  // same debounced-flush pattern, so the last few hundred ms of appends
  // would otherwise be lost.
  try {
    chatHistory.flushSync();
    artifactStore.flushSync();
    suggestionStore.flushSync();
  } catch (err) {
    console.error('[Zapi] store flush failed:', err);
  }
});

// macOS: don't quit when all windows are closed (tray app)
app.on('window-all-closed', () => {
  // Don't quit — this is a tray app
});

// ── Window Management ──────────────────────────────────────────────────

/**
 * (Re)build the tray context menu. The mode checkboxes read live
 * settings each rebuild — onSettingsChanged calls us so panel-made or
 * voice-made changes show up without a restart. The 'Stop agent' item
 * is enabled only while the loop drives (acting/thinking), tracked via
 * lastAgentStatus and refreshed on phase flips.
 */
function rebuildTrayMenu(): void {
  if (!tray || !companion) return;
  const s = companion.getSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Panel', click: () => togglePanel() },
      { type: 'separator' },
      {
        label: 'Always-on listening',
        type: 'checkbox',
        checked: s.alwaysOnEnabled,
        click: (item) => companion.setAlwaysOn(item.checked),
      },
      {
        label: 'Dictation mode',
        type: 'checkbox',
        checked: s.dictationEnabled,
        click: (item) => companion.setDictation(item.checked),
      },
      {
        label: 'Agent mode',
        type: 'checkbox',
        checked: s.agentEnabled,
        click: (item) => companion.setAgentEnabled(item.checked),
      },
      {
        label: 'Stop agent',
        enabled: lastAgentStatus?.phase === 'acting' || lastAgentStatus?.phase === 'thinking',
        click: () => companion.stopAgent(),
      },
      // Canned ink demo through the real scene scheduler — no API keys needed.
      { label: 'Play ink demo', click: () => companion.playDemoScene() },
      { type: 'separator' },
      { label: 'Quit ZAPI', click: () => app.quit() },
    ]),
  );
}

/** When the panel last lost focus — see togglePanel. */
let panelBlurredAt = 0;

function togglePanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    // On Windows, clicking the tray icon blurs the panel *before* our
    // click handler runs, so `isFocused()` was always false and the tray
    // could only ever show the panel, never hide it. Treat a blur in the
    // last few hundred ms as "was focused when you clicked".
    const recentlyFocused = Date.now() - panelBlurredAt < 400;
    if (panelWindow.isVisible() && !panelWindow.isMinimized() && (panelWindow.isFocused() || recentlyFocused)) {
      panelWindow.hide();
      return;
    }
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.show();
    panelWindow.focus();
    return;
  }

  panelWindow = createPanelWindow();
  panelWindow.on('blur', () => { panelBlurredAt = Date.now(); });
  panelWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Zapi] Panel FAILED to load:', code, desc, url);
  });
  // A reload (or crash-recovery load) leaves the page that started the
  // PTT verification behind — never let the flag outlive its owner page.
  panelWindow.webContents.on('did-start-loading', () => setPttTestMode(false));
  panelWindow.on('close', (e) => {
    // Don't destroy on close — hide so reopening is instant and keeps state.
    if (!isAppQuitting) {
      e.preventDefault();
      panelWindow?.hide();
      // Closing the panel mid-check ends the verification.
      setPttTestMode(false);
    }
  });
  // Permissions polling is only useful while the banner can render.
  panelWindow.on('show', startPermsPoll);
  panelWindow.on('hide', stopPermsPoll);

  panelWindow.show();
  panelWindow.focus();
}

/**
 * Recover after the mic-hosting overlay was destroyed. An active
 * recording would otherwise hang waiting for chunks, so finish the turn
 * with the audio already received; an always-on VAD stream (or an open
 * mic test) re-arms on a surviving overlay.
 */
function handleLostCapture(mode: CaptureMode | null): void {
  if (mode === null) return;
  audioCaptureWcId = null;
  audioCaptureMode = null;
  if (companion.recording) {
    void companion.stopPushToTalk().catch((err) => {
      console.error('[Zapi] stopPushToTalk after overlay loss failed:', err);
    });
  } else {
    startCaptureOn(mode);
  }
}

/** Debounced auto-rebuild state — see watchOverlayHealth. */
let overlayAutoRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let lastOverlayAutoRebuildAt = 0;

/**
 * A crashed or never-loaded overlay is a permanently dead ink surface —
 * and if it's the overlay hosting the mic, a silent audio failure too.
 * Log and schedule a rebuild; debounced (a multi-display crash storm
 * fires once per window) and rate-limited so a bundle that crashes on
 * every load can't spin recreate-forever.
 */
function watchOverlayHealth(win: BrowserWindow): void {
  const onLost = (why: string, details?: unknown): void => {
    if (win.isDestroyed() || isAppQuitting) return;
    console.error(`[Zapi] overlay renderer lost (${why}):`, details ?? '');
    scheduleOverlayRebuild();
  };
  win.webContents.on('render-process-gone', (_e, details) => onLost('render-process-gone', details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => onLost('did-fail-load', `${code} ${desc}`));
}

function scheduleOverlayRebuild(): void {
  if (overlayAutoRebuildTimer || isAppQuitting) return;
  overlayAutoRebuildTimer = setTimeout(() => {
    overlayAutoRebuildTimer = null;
    // A crash event <150 ms before quit would otherwise spin up fresh
    // overlay windows mid-teardown.
    if (isAppQuitting) return;
    const now = Date.now();
    if (now - lastOverlayAutoRebuildAt < 10_000) {
      console.error('[Zapi] overlay rebuild rate-limited');
      return;
    }
    lastOverlayAutoRebuildAt = now;
    rebuildOverlays();
  }, 150);
}

function spawnOverlay(display: Electron.Display): BrowserWindow {
  const win = createOverlayWindow(display);
  watchOverlayHealth(win);
  return win;
}

function rebuildOverlays(): void {
  // A rebuild kills whichever overlay hosted the mic — remember the
  // capture mode so it can be stopped/re-armed once the new set is up.
  const lostCaptureMode = audioCaptureWcId !== null ? audioCaptureMode : null;
  for (const win of overlayWindows) {
    if (!win.isDestroyed()) win.destroy();
  }

  overlayWindows = screen.getAllDisplays().map(spawnOverlay);
  // Overlays stay visible even when "Show cursor" is off — they're the
  // canvas for scene ink + agent echoes; the renderer hides the cursor
  // element itself via the gated CURSOR_POSITION feed.
  applyOverlayVisibility(overlayWindows);
  handleLostCapture(lostCaptureMode);
}

/**
 * Reconcile overlay windows with the current display topology. Only
 * creates overlays for newly-added displays and destroys overlays for
 * displays that are gone — leaves untouched overlays running so we
 * don't reload all renderer bundles on every monitor change.
 */
function syncOverlaysToDisplays(): void {
  const currentDisplays = screen.getAllDisplays();
  const currentIds = new Set(currentDisplays.map((d) => d.id));

  // Drop overlays whose display is gone. isDestroyed() must run before
  // touching .webContents — accessing it on a destroyed window throws.
  const survivors: BrowserWindow[] = [];
  let lostCaptureMode: CaptureMode | null = null;
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    const display = overlayDisplayByWebContents.get(win.webContents.id);
    if (!display || !currentIds.has(display.id)) {
      if (win.webContents.id === audioCaptureWcId) lostCaptureMode = audioCaptureMode;
      win.destroy();
      continue;
    }
    survivors.push(win);
  }

  // Add overlays for newly-attached displays.
  const survivorDisplayIds = new Set(
    survivors.map((w) => overlayDisplayByWebContents.get(w.webContents.id)?.id).filter((id): id is number => id !== undefined),
  );
  for (const display of currentDisplays) {
    if (!survivorDisplayIds.has(display.id)) {
      survivors.push(spawnOverlay(display));
    }
  }

  overlayWindows = survivors;
  // Overlays stay visible even when "Show cursor" is off — they're the
  // canvas for scene ink + agent echoes; the renderer hides the cursor
  // element itself via the gated CURSOR_POSITION feed.
  applyOverlayVisibility(overlayWindows);
  handleLostCapture(lostCaptureMode);
}

/** Move an existing overlay to its display's new bounds after a metrics change. */
function syncOverlayBounds(display: Electron.Display): void {
  for (const win of overlayWindows) {
    if (win.isDestroyed()) continue;
    const tracked = overlayDisplayByWebContents.get(win.webContents.id);
    if (!tracked || tracked.id !== display.id) continue;
    win.setBounds(display.bounds);
    overlayDisplayByWebContents.set(win.webContents.id, display);
    win.webContents.send('display-info', {
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    });
  }
}

/**
 * Lazily create the stream window. Returns the live BrowserWindow.
 * The window is destroyed (not hidden) when the user sets visibility
 * back to 'off', so calling this again will spin up a fresh instance.
 */
function ensureStreamWindow(): BrowserWindow {
  if (streamWindow && !streamWindow.isDestroyed()) return streamWindow;
  const bounds = companion.getSettings().streamWindowBounds;
  streamWindow = createStreamWindow(bounds);
  streamWindow.on('close', (e) => {
    if (!isAppQuitting) {
      // Hide only — a window close can't distinguish a deliberate
      // dismissal from a stray Alt+F4, so it must not persist 'off'.
      // The setting only changes via the explicit panel toggle and
      // keeps driving visibility on the next voice/agent trigger.
      e.preventDefault();
      streamWindow?.hide();
    }
  });
  streamWindow.on('moved', persistStreamBounds);
  streamWindow.on('resized', persistStreamBounds);
  return streamWindow;
}

function destroyStreamWindow(): void {
  const win = streamWindow;
  // Null the field first — a close-driven path can re-enter while the old
  // window is mid-teardown, and ensureStreamWindow must see the slot empty
  // rather than race the destroy.
  streamWindow = null;
  if (!win || win.isDestroyed()) return;
  // Defer the actual destroy: destroying a window synchronously from inside
  // a close/settings dispatch re-enters the emitter mid-event.
  setImmediate(() => {
    try {
      win.destroy();
    } catch { /* already gone */ }
  });
}

/**
 * Show or hide the stream window based on the current visibility
 * setting. 'responses' mode is refined further by updateStreamForVoiceState
 * which flicks it on when Zapi is thinking / speaking.
 */
function applyStreamVisibility(v: StreamVisibility): void {
  if (v === 'off') {
    destroyStreamWindow();
    return;
  }
  if (v === 'always') {
    ensureStreamWindow().showInactive();
    return;
  }
  // 'responses' — reconcile with whatever Zapi is currently doing
  // so switching *into* this mode immediately reflects the real state.
  // We don't pre-create the window here; updateStreamForVoiceState will
  // spin it up the first time something happens worth showing.
  updateStreamForVoiceState(lastVoiceState);
}

function updateStreamForVoiceState(state: string): void {
  const v = companion.getSettings().streamVisibility;
  if (v !== 'responses') return;
  const active =
    state === 'listening' ||
    state === 'processing' ||
    state === 'responding' ||
    // Agent mode pins the stream for the whole run — it hosts the
    // stop button, so hiding it mid-run would strand the control.
    state === 'acting' ||
    sceneActive;
  if (active) {
    ensureStreamWindow().showInactive();
  } else if (state === 'idle') {
    if (streamWindow && !streamWindow.isDestroyed()) streamWindow.hide();
  }
}

/**
 * Write the stream window's bounds back to settings — debounced: 'moved'/
 * 'resized' fire per drag step on some platforms and each write fans out
 * a settings broadcast + tray rebuild (REVIEW M7). ~250 ms collapses a
 * drag into one persist; will-quit flushes a pending write so the last
 * position isn't lost on exit.
 */
function persistStreamBounds(): void {
  if (streamBoundsTimer) clearTimeout(streamBoundsTimer);
  streamBoundsTimer = setTimeout(() => {
    streamBoundsTimer = null;
    if (!streamWindow || streamWindow.isDestroyed()) return;
    const [x, y] = streamWindow.getPosition();
    const [width, height] = streamWindow.getSize();
    companion.setStreamWindowBounds({ x, y, width, height });
  }, 250);
}

/** Flush a pending bounds write synchronously — used by will-quit. */
function flushStreamBounds(): void {
  if (!streamBoundsTimer) return;
  clearTimeout(streamBoundsTimer);
  streamBoundsTimer = null;
  if (!streamWindow || streamWindow.isDestroyed()) return;
  try {
    const [x, y] = streamWindow.getPosition();
    const [width, height] = streamWindow.getSize();
    companion.setStreamWindowBounds({ x, y, width, height });
  } catch { /* window mid-teardown */ }
}
