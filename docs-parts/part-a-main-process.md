# Zapi — Part A: The Electron Main Process Layer

This part documents the main-process half of Zapi: the app entry point, the turn
pipeline, the window factories, the shared type contract, and the preload bridge.
Every claim below is traceable to the source files named in each section's
"Source" line. Line numbers refer to the tree at commit `d32a7b3`.

The main process owns four things and nothing else: **process lifecycle** (tray,
windows, global hotkeys, permission policy), **the turn pipeline** (mic →
transcribe → model → scene/TTS), **window topology** (one overlay per display),
and **the IPC contract** that the three renderer processes talk to. It owns no
DOM and no model logic of its own; both live behind services.

## Table of contents

- [1. `src/main/index.ts` — app entry and process wiring](#1-srcmainindexts--app-entry-and-process-wiring)
  - [1.1 The `userData` hijack (module scope)](#11-the-userdata-hijack-module-scope)
  - [1.2 Startup order](#12-startup-order)
  - [1.3 Tray icon and menu](#13-tray-icon-and-menu)
  - [1.4 The three global shortcuts and PTT hold/toggle](#14-the-three-global-shortcuts-and-ptt-holdtoggle)
  - [1.5 IPC registration and routing tables](#15-ipc-registration-and-routing-tables)
  - [1.6 Overlay-to-display routing rules](#16-overlay-to-display-routing-rules)
  - [1.7 Overlay lifecycle, health, and bounds sync](#17-overlay-lifecycle-health-and-bounds-sync)
  - [1.8 The stream window](#18-the-stream-window)
  - [1.9 Shutdown](#19-shutdown)
- [2. `src/main/companion-manager.ts` — the turn pipeline](#2-srcmaincompanion-managerts--the-turn-pipeline)
  - [2.1 Construction and collaborators](#21-construction-and-collaborators)
  - [2.2 The full pipeline, in order](#22-the-full-pipeline-in-order)
  - [2.3 `turnId` and the `isCurrent()` gate](#23-turnid-and-the-iscurrent-gate)
  - [2.4 Always-on listening and the wake gate](#24-always-on-listening-and-the-wake-gate)
  - [2.5 Spoken voice self-settings](#25-spoken-voice-self-settings)
  - [2.6 `resolveAgentTarget` — longest-name-first routing](#26-resolveagenttarget--longest-name-first-routing)
  - [2.7 The scene scheduler](#27-the-scene-scheduler)
  - [2.8 `runTextTurn`, `acceptSuggestion`, `refreshSuggestions`](#28-runtextturn-acceptsuggestion-refreshsuggestions)
  - [2.9 Agent runtime deps and the voice-ownership rule](#29-agent-runtime-deps-and-the-voice-ownership-rule)
  - [2.10 Mind dispatch and TTS fallback](#210-mind-dispatch-and-tts-fallback)
- [3. `src/main/windows.ts` — the three window factories](#3-srcmainwindowsts--the-three-window-factories)
  - [3.1 `createPanelWindow`](#31-createpanelwindow)
  - [3.2 `createOverlayWindow`](#32-createoverlaywindow)
  - [3.3 `createStreamWindow`](#33-createstreamwindow)
  - [3.4 `hardenWindow` and `loadPage`](#34-hardenwindow-and-loadpage)
  - [3.5 `scheduleDisplaySync` and `supportsAcrylic`](#35-scheduledisplaysync-and-supportsacrylic)
- [4. `src/main/services/audio-capture.ts` — the audio IPC names](#4-srcmainservicesaudio-capturets--the-audio-ipc-names)
- [5. `src/shared/types.ts` — the single contract](#5-srcsharedtypests--the-single-contract)
  - [5.1 `IPC` — the channel map](#51-ipc--the-channel-map)
  - [5.2 `FlickySettings` and `DEFAULT_SETTINGS`](#52-flicksettings-and-default_settings)
  - [5.3 `Scene` and `SceneCue`](#53-scene-and-scenecue)
  - [5.4 `AgentAction` and `AgentStatus`](#54-agentaction-and-agentstatus)
  - [5.5 `CaptureMode`, `DisplayInfo`, `UsageStats`](#55-capturemode-displayinfo-usagestats)
- [6. `src/preload/index.ts` — the `window.flicky` bridge](#6-srcpreloadindexts--the-windowflicky-bridge)
- [7. Cross-cutting invariants](#7-cross-cutting-invariants)

---

## 1. `src/main/index.ts` — app entry and process wiring

**Source:** `src/main/index.ts` (1604 lines). No exported symbols — this is a
side-effecting entry point. Everything below names the local function or
top-level block it describes.

### 1.1 The `userData` hijack (module scope)

The very first executable block in the file (lines 34–63) is a bare block
statement at module scope — it is **not** inside `app.whenReady()`, and it must
never be moved there.

The problem it solves: the package name `zapi` resolves
`app.getPath('userData')` to `%APPDATA%\zapi`, and a *different installed app
already owns that directory* (its own `zapi.db`, `sfx/`, `agents/` live there).
So the block:

1. computes `legacyDir = %APPDATA%/zapi` and `ours = %APPDATA%/ZAPI Companion`;
2. if the legacy dir exists, `mkdirSync(ours, { recursive: true })` and copies
   six known JSON files across — `zapi-settings.json`, `zapi-keys.json`,
   `zapi-chats.json`, `zapi-usage.json`, `zapi-suggestions.json`,
   `zapi-artifacts.json` — each guarded by `existsSync(src) && !existsSync(dst)`
   so a re-run never clobbers newer local data;
3. recursively copies the legacy `artifacts/` tree the same way, via
   `fs.cpSync(..., { recursive: true })`;
4. wraps all of it in `try/catch`, logging
   `'[Zapi] userData migration skipped:'` on failure, because a failed
   migration must not stop the app from booting;
5. finally calls `app.setPath('userData', ours)`.

The foreign app's own files are deliberately left alone — only the six names
Zapi itself uses are moved.

**Why it must stay at module scope.** Every store (settings, keys, chat,
usage, suggestions, artifacts) resolves its path through
`app.getPath('userData')`. Moving the call into `whenReady` lets the first
`getPath` read happen before the claim, silently splitting the stores across two
directories. `windows.ts` comments the same rule in reverse: preload stores
resolve outside a running app in the smoke tests, and the Electron
`userData` hijack is main-process-only behaviour.

### 1.2 Startup order

Two things happen before ready:

- `app.requestSingleInstanceLock()` at line 66. If it returns false,
  `app.quit()` is called immediately, and `app.whenReady()` then returns early
  at line 391 (`if (!gotLock) return;`) so a losing process never boots the
  tray, overlays, or hotkeys on its way out.
- `initGpuGuard()` at line 90, inside `if (gotLock)`. The guard has to be
  installed before ready because the switches it may set only apply pre-ready
  and the GPU failure it counts happens during startup.

`app.on('second-instance')` (line 74) does not create a window — Zapi lives in
the tray, so the natural user gesture when the app seems missing is a second
launch. It restores and focuses an existing panel, or calls `togglePanel()`.

Inside `app.whenReady().then(...)`, in order:

1. `app.setAppUserModelId('com.zapi.app')` (line 387). Must be after ready and
   before any `Notification` is constructed. Electron's default
   `electron.app.<name>` cannot be attributed to an installed shortcut on
   Windows, so `Notification.show()` silently no-ops and agent-completion
   toasts never appear.
2. `if (!gotLock) return;` then `confirmGpuHealthy()`.
3. `session.defaultSession.setPermissionRequestHandler` (line 398). With no
   handler Electron grants *every* permission request. The allowlist is exactly
   `media`, `display-capture`, `clipboard-read`, `clipboard-sanitized-write`.
4. `companion = new CompanionManager({ ...callbacks })` (line 408) — 30-odd
   callbacks wiring the pipeline to IPC. See §2.
5. `clickyCursorEnabled = companion.getSettings().isClickyCursorEnabled` — the
   30 fps cursor poll must not call `getSettings()` (a store read plus a
   key-status probe) per tick; the flag is seeded here and refreshed by
   `onSettingsChanged` / `onCursorVisibilityChanged`.
6. Tray creation and `rebuildTrayMenu()`.
7. `rebuildOverlays()` — one overlay per display.
8. Three `screen` event listeners wired through `syncDisplaysSoon` (see §1.7).
9. `applyStreamVisibility(settings.streamVisibility)` — the stream window is
   created lazily so a default `'off'` install is not paying for a whole
   Chromium renderer nobody sees.
10. `app.setLoginItemSettings(...)`, but **only when `app.isPackaged`**:
    unpackaged it would register the bare electron binary as a startup item.
11. The three shortcut registrations (§1.4).
12. ~120 `ipcMain.on` / `ipcMain.handle` registrations (§1.5).
13. `cursorPollTimer = setInterval(..., 33)` — the ~30 fps cursor poll.
14. `togglePanel()` — open the panel on first launch.

### 1.3 Tray icon and menu

`createTrayIcon()` (line 221) resolves `../../../assets` relative to `__dirname`
so it works both in dev (`dist/main/main/`) and packaged (same path inside the
asar). On `win32` it first tries `assets/icon.ico` and returns it if
non-empty — Windows renders multi-size `.ico` crisply at any DPI, while a
16 px PNG gets upscaled and blurry at 125 %/150 % scaling. Otherwise it loads
`32x32.png` on macOS / `16x16.png` elsewhere; on macOS it attaches a 2x
representation for Retina then resizes to 16×16. If the asset is missing it
throws internally and falls through to a **generated** cornflower-blue filled
circle written into a raw `Buffer` (radius `size/2 - 2`, RGB 100/149/237) so
the tray entry is still clickable.

`rebuildTrayMenu()` (line 1392) builds the `Menu` from a template:

| Item | Type | Behaviour |
|---|---|---|
| Show Panel | normal | `togglePanel()` |
| *(separator)* | | |
| Always-on listening | checkbox | `companion.setAlwaysOn(item.checked)` |
| Dictation mode | checkbox | `companion.setDictation(item.checked)` |
| Agent mode | checkbox | `companion.setAgentEnabled(item.checked)` |
| Stop agent | normal | enabled only while `lastAgentStatus.phase` is `acting` or `thinking`; `companion.stopAgent()` |
| Play ink demo | normal | `companion.playDemoScene()` — a canned scene through the real scheduler, no API keys needed |
| *(separator)* | | |
| Quit ZAPI | normal | `app.quit()` |

The menu is rebuilt from live settings, not a snapshot, and
`onSettingsChanged` calls `rebuildTrayMenu()` so panel-made and voice-made
changes show up without a restart. The `onAgentStatus` callback rebuilds it on
**phase flips only** — per-action message updates would rebuild the menu dozens
of times per run for no benefit.

Two helper functions back the notification policy: `panelHasFocus()`
suppresses toasts while the panel is the focused surface (the status line
already changed there), and `notifyAgentOutcome()` phrases a failure as
`"<name> needs you"` rather than "failed" — the run stopped and wants a human.
The toast is `silent: true` because the outcome already plays a sting through
`IPC.PLAY_SFX`.

### 1.4 The three global shortcuts and PTT hold/toggle

Three hotkeys share one shape. `registerPttShortcut`, `registerDictationShortcut`
and `registerAgentShortcut` are structurally identical: unregister the
previous accelerator, try to register the new one, and on failure
`sendToPanel(IPC.AI_ERROR, ...)` and **re-register the last-known-good
binding**. A silently ignored hotkey reads as a dead app, so the failure is
surfaced; the rollback means the user is never left with no hotkey at all.

| Hotkey | Setting | Default | Handler |
|---|---|---|---|
| Push-to-talk | `pushToTalkShortcut` | `Ctrl+Alt+X` | `pttHandler` |
| Push-to-dictate | `dictationShortcut` | `Ctrl+Alt+D` | `dictationHandler` |
| Agent | `agentPttShortcut` | `Ctrl+Shift+A` | `agentHandler` |

Each handler first computes
`const mode = isMac ? 'toggle' : companion.getSettings().pttMode;` — on macOS
the app *always* behaves as toggle regardless of the stored setting, because
`globalShortcut` fires exactly once per press there and Electron exposes no
key-up event, so a user who set `'hold'` on another platform would otherwise
get a stuck mic.

**Toggle mode** flips a local `pttActive` boolean and calls
`startPushToTalk()` / `stopPushToTalk()`. Both branches reconcile afterwards:
`.then(() => { pttActive = companion.recording; })`. If the transcription
provider fails to initialise, `CompanionManager` flips `isRecording` back to
false — without the reconcile, the next tap would issue a stop against nothing
instead of retrying the start.

**Hold mode** (Windows/Linux) leans entirely on OS key-repeat, which fires
`globalShortcut` repeatedly while the accelerator is held. Each fire clears and
re-arms a debounce timer; the first fire also starts recording. The grace
windows are:

```ts
const PTT_HOLD_INITIAL_GRACE_MS = 1100;
const PTT_HOLD_REPEAT_GRACE_MS  = 250;
```

and the fire count selects between them
(`const grace = pttFireCount === 1 ? PTT_HOLD_INITIAL_GRACE_MS : PTT_HOLD_REPEAT_GRACE_MS;`).

The comment on those constants records the exact bug: the OS does not start
auto-repeating a held key until its repeat-delay elapses — 250 ms at the
fastest Windows setting, 1 s at the slowest, ≈500 ms by default. The old fixed
250 ms window therefore expired *before the first repeat ever arrived*:
recording stopped after a quarter second, a useless sliver went to Whisper, and
then the repeat kicked in and started a brand-new turn, over and over, while
the key was held. Once repeats are flowing (~30 Hz) 250 ms is plenty, so only
the first fire gets the generous window.

`pttTestMode` is setup's "press your shortcut" check: while true, `pttHandler`
still emits `IPC.PTT_SHORTCUT_FIRED` (so the panel can prove the binding
reaches main) but returns before touching the mic. The flag is set by
`IPC.PTT_TEST_START` and cleared by `IPC.PTT_TEST_STOP`, on panel
`did-start-loading`, on panel `close`, and by a self-expiry timer
(`PTT_TEST_EXPIRY_MS = 10_000`) — it must never latch. Neither the dictation
nor the agent handler checks `pttTestMode`: that flag belongs to setup's PTT
verification, and arming it there would let the wizard swallow a real agent
request.

`suspendPttShortcut()` / `resumePttShortcut()`
(`IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT` / `..._RESUME_...`) unregister and
re-register **all three** bindings. While the user is recording a new combo, a
live binding firing mid-capture would be actively harmful.

### 1.5 IPC registration and routing tables

`whenReady` registers roughly 120 handlers. Two shapes are used
deliberately:

- `ipcMain.on(channel, ...)` for fire-and-forget mutations — every settings
  setter, mode switch, agent-profile mutation, routine mutation, artifact
  open/reveal.
- `ipcMain.handle(channel, ...)` for anything that returns data — settings,
  permissions, app version, key validation, agent/routine/artifact/suggestion
  lists, memory and usage stats, chat history, and the whole local-connection /
  Ollama surface.

Two safety notes visible in the handlers:

- `IPC.OPEN_EXTERNAL` only accepts `/^(https?|mailto):/i`. Never `file://`,
  `smb://` (a compromised renderer could NTLM-relay), or custom handlers.
- `IPC.VAD_UTTERANCE` and `AUDIO_IPC.AUDIO_CHUNK` wrap their synchronous bodies
  in `try/catch`, because a throw inside `ipcMain.on` propagates as
  `uncaughtException` and one bad utterance would kill the process.

**Outbound routing.** Five helpers, and choosing the right one is a real
behavioural decision:

| Helper | Target | Used for |
|---|---|---|
| `sendToPanel` | panel only | `AI_RESPONSE_CHUNK/COMPLETE`, `AI_ERROR`, `SETTINGS_CHANGED`, `MEMORY_STATS`, `CHAT_ENTRY_ADDED`, `MIC_LEVEL` |
| `sendToOverlays` | every overlay | `SCENE`, `SCENE_CUE`, `PLAY_SFX`, `SPEAK_TEXT`, `stop-audio` |
| `sendToOneOverlay` | first live overlay | `play-audio`, `TYPE_FULFILLED` |
| `sendToOverlayById(wcId, …)` | one specific overlay | `CURSOR_POSITION`, `AUDIO_IPC.STOP_CAPTURE` |
| `sendToStream` | stream window | the live Q/A feed |
| `sendToAll` | panel + overlays + stream | `VOICE_STATE_CHANGED`, `TRANSCRIPT_UPDATE`, `AGENT_STATUS` |

`sendToOneOverlay` exists because broadcasting TTS playback plays the buffer
once per display and audibly doubles. `onStopAudio` is the mirror case: it
*broadcasts*, because only the overlay currently holding a buffer can silence
it, and that overlay may not be the one playback targeted.

Mic capture never fans out. `startCaptureOn(mode)` (line 310) picks a single
live overlay, records its `webContents.id` in `audioCaptureWcId`, and sends
`AUDIO_IPC.START_CAPTURE` with the mode. The comment records the failure that
motivated it: each overlay opening its own `getUserMedia` + `AudioContext`
streamed the same audio N times into one buffer, and Whisper transcribed an
interleaved mess. `stopCapture()` aims the stop at the *tracked* overlay and
falls back to the first-alive pick only if the tracker was cleared.

### 1.6 Overlay-to-display routing rules

`overlayDisplayByWebContents` (exported from `windows.ts`, populated there) is
the map from each overlay's `webContents.id` to the `Display` it covers. Two
routing rules read from it.

**Cursor position.** `cursorPollTimer` runs every 33 ms. When
`clickyCursorEnabled` is false it sends one `{ x: -9999, y: -9999, off: true }`
pulse to the previously-targeted overlay and stops. Otherwise it calls
`screen.getCursorScreenPoint()`, resolves the overlay with
`findOverlayContainingPoint`, and — crucially — when the cursor *leaves* a
display it sends that same `off` pulse to the old overlay so its
`isCursorOnThisDisplay` state flips false, then stops updating it until the
cursor re-enters. The whole tick body is inside `try/catch`: an interval that
throws crashes the process.

`findOverlayContainingPoint` resolves a point by looking up each overlay's
tracked `Display.bounds` and testing half-open containment
(`pos.x >= b.x && pos.x < b.x + b.width`), so a point exactly on a shared
edge belongs to the display to the right/below rather than both.

**Agent action echoes.** `overlayForEcho(a)` (line 353) splits on a set:

```ts
const POINTER_ECHO_KINDS: ReadonlySet<string> = new Set([
  'move', 'click', 'dclick', 'rclick', 'drag',
]);
```

Pointer kinds carry a real desktop point, so the echo goes to
`findOverlayContainingPoint({x, y})`. Every other kind (`type`, `key`,
`scroll`, `wait`) arrives with 0,0 filler coords, and point-routing would dump
its chip on whichever display owns the origin. Those route instead to
`screen.getCursorScreenPoint()`'s display — the chip belongs beside the status
pill the user is looking at — falling back to the primary display's centre and
then to the first live overlay.

**Scene routing** is the deliberate opposite: `onScene` and `onSceneCue`
**broadcast** to every overlay even though `SceneCue` carries a `screenIndex`.
A scene's cues can span displays, so single-target routing would drop the rest.
Each renderer culls strokes outside its own bounds (`InkLayer`) and hops point
cues only when they land on its display (`OverlayApp`), so extra copies are
inert on the wrong screens and every display stays beat-synchronised.

### 1.7 Overlay lifecycle, health, and bounds sync

- `rebuildOverlays()` (line 1538) destroys every overlay and re-creates one per
  `screen.getAllDisplays()` via `spawnOverlay` → `createOverlayWindow` +
  `watchOverlayHealth`. It remembers `lostCaptureMode` first, because a rebuild
  kills whichever overlay hosted the mic, and finishes with
  `handleLostCapture(lostCaptureMode)`.
- `syncOverlaysToDisplays()` (line 1560) is the *incremental* path used on
  hot-plug. It destroys overlays whose display is gone and creates overlays for
  newly-attached displays, **leaving untouched overlays running** so a monitor
  change does not reload every renderer bundle. `isDestroyed()` is always tested
  before touching `.webContents`, which throws on a destroyed window.
- `syncOverlayBounds(display)` (line 1598) handles
  `display-metrics-changed` — same ids, moved rects. Without it the overlay
  stayed at the stale bounds and the cursor pointed at the wrong place. It is
  gated to only act when `changed` includes `'bounds' | 'scaleFactor' |
  'workArea'`, and re-sends `'display-info'` on the raw channel.
- `watchOverlayHealth(win)` (line 1505) listens for `render-process-gone` and
  `did-fail-load`. Both call `scheduleOverlayRebuild()` (line 1515), which is
  debounced 150 ms (a multi-display crash storm fires once per window) **and**
  rate-limited to once per 10 s, so a bundle that crashes on every load cannot
  spin recreate-forever.
- `handleLostCapture(mode)` (line 1481) — if the mic-hosting overlay died while
  recording, `companion.stopPushToTalk()` finishes the turn with the audio
  already received; otherwise an always-on VAD stream re-arms on a survivor.
- Hot-plug storms go through `scheduleDisplaySync` from `windows.ts`, a 300 ms
  coalescing debounce. The deferred body re-checks `isAppQuitting` so a queued
  sync cannot spawn windows during teardown.

### 1.8 The stream window

`ensureStreamWindow()` (line 1618) creates lazily and wires three behaviours:
`close` **hides** rather than destroys (a window close cannot distinguish a
deliberate dismissal from a stray Alt+F4, so it must not persist `'off'`), and
`moved` / `resized` call `persistStreamBounds`.

`applyStreamVisibility(v)`:

- `'off'` → `destroyStreamWindow()`. The window is *destroyed*, not hidden, so
  the next call spins up a fresh instance. `destroyStreamWindow` nulls the
  module field first (a close-driven path can re-enter mid-teardown) and defers
  the actual `destroy()` to `setImmediate`, because destroying synchronously
  from inside a close dispatch re-enters the emitter mid-event.
- `'always'` → `ensureStreamWindow().showInactive()`.
- `'responses'` → delegate to `updateStreamForVoiceState(lastVoiceState)` so
  switching *into* the mode immediately reflects real state.

`updateStreamForVoiceState(state)` shows the stream while state is
`listening`, `processing`, `responding` or `acting`, or while `sceneActive`.
Agent mode pins it for the whole run because it hosts the stop button — hiding
it mid-run would strand the control. `onScene` also re-applies visibility
across a scene so the stream does not vanish between the reply and the ink.

`persistStreamBounds()` is debounced 250 ms: `moved`/`resized` fire per drag
step on some platforms and each write fans out a settings broadcast plus a tray
rebuild. `flushStreamBounds()` runs synchronously from `will-quit` so the last
position is not lost.

### 1.9 Shutdown

`app.on('before-quit')` sets `isAppQuitting = true`. That flag is read by
`rebuildOverlays`' deferred path, `scheduleOverlayRebuild`, `watchOverlayHealth`
and `destroyStreamWindow` so nothing spawns during teardown.

`app.on('will-quit')` (line 1347) runs, in order: `globalShortcut.unregisterAll()`;
`companion?.stopRoutines()` (a timer firing mid-quit would start a turn against
a half-destroyed pipeline); clears `cursorPollTimer`; `stopPermsPoll()`;
`flushStreamBounds()`; `tray?.destroy()` — without an explicit destroy Windows
keeps a ghost tray icon until the user hovers it; and finally the three
synchronous store flushes `chatHistory.flushSync()`,
`artifactStore.flushSync()`, `suggestionStore.flushSync()`, because each uses
a debounced flush and the last few hundred ms of appends would otherwise be
lost.

`window-all-closed` is a deliberate no-op: this is a tray app.

---

## 2. `src/main/companion-manager.ts` — the turn pipeline

**Source:** `src/main/companion-manager.ts` (2272 lines).
**Exported symbol:** `class CompanionManager` (line 150) and
`interface CompanionCallbacks` (line 70). Everything else is private.

### 2.1 Construction and collaborators

`constructor(callbacks)` (line 247) builds `ClaudeAPI`, `OpenAIAPI`,
`OllamaAPI`, `ElevenLabsTTS`, `FishAudioTTS`, `ContextManager`; hydrates
`dictationShortcut` and `agentPttShortcut` from `settingsStore`; constructs
`AgentOrchestrator` with a `buildAgentDeps` factory; constructs
`RoutineScheduler` with three injected functions (`listRoutines`, `onFire`,
`markRun`) and calls `this.routines.start()` — ticking is cheap and
idempotent, and an interval routine that has never run is due immediately, so
"check downloads every 30m" fires on the next tick instead of in 30 minutes.
Finally it calls `analytics.initAnalytics` and `trackAppOpened()`.

Module-level `const AGENT_ID_MAIN = 'main'` is the single default-agent
constant; the comment notes it exists so the Phase-B extraction to
`AgentOrchestrator` was a one-place change.

### 2.2 The full pipeline, in order

Both entry points converge on `processUserText`. In order:

**A. Push-to-talk.** `startPushToTalk()` → `startRecordingWithMode(false)` →
`startRecording()`:

1. `this.turnId += 1`, then `this.currentAbort?.abort()` and null it. Order
   matters — the abort must happen here so a running agent loop's controller
   dies on the press, not just its stale callbacks.
2. `stopSpeech()` — a user pressing the key to interrupt should not still hear
   the previous answer to the end.
3. Emit a reset `onAgentStatus({agentId:'main', phase:'idle', …})`,
   `clearSceneTimers()`, `onScene(null)`, `onSceneCue(null)`.
4. `isRecording = true`, `setVoiceState('listening')`, `trackPushToTalkStarted()`.
5. `createTranscriptionProvider(settings.transcriptionProvider)`, `await
   provider.start()`, clear `micTestActive`, and
   `callbacks.onStartAudioCapture('ptt')` — the always-on VAD capture switches
   to `'ptt'` so chunks stream live.
6. On failure: voice state back to `idle`, `isRecording = false`, provider
   nulled, **`forcedDictation` cleared**, and `onError(...)`. Clearing the
   forced flag matters — no turn will follow, so an armed push-to-dictate would
   force the *next* unrelated PTT turn to dictate.

There is deliberately **no partial-transcript wiring**. The comment records that
the hook was dead code that read as a working live-caption feature: every
provider is a whole-file upload, so the only transcript is the final one from
`stop()`.

`stopPushToTalk()` awaits `pendingStart` first — a quick press/release can
otherwise race past the start and leak a live mic — then calls
`stopRecordingAndProcess()`.

**B. `stopRecordingAndProcess()`** (line 1324):

1. `isRecording = false`, `onStopAudioCapture()`, `trackPushToTalkReleased()`.
2. `await transcriptionProvider.stop()` inside its own `try/catch`. A failed
   upload used to throw straight out, leaving voice state stuck on
   `'listening'` so the next press did nothing; it now reports
   `couldn't transcribe that — …` and returns to `'idle'`.
3. Empty text → back to `'idle'`, return.
4. `onTranscriptUpdate(result)`, `analytics.trackUserMessageSent`.
5. `await this.processUserText(result.text, { cameFromPtt: true })` — wrapped in
   its own `try/catch` because index.ts calls this as a floating
   `void stopPushToTalk()`; an escaping rejection would *also* skip the state
   reset and pin `voiceState` at `'processing'`, which the VAD gate treats as
   busy, killing always-on listening until restart.
6. `finally:` re-open the mic in `'vad'` mode when `alwaysOnEnabled` and not
   recording — **skipped when `voiceState === 'acting'`**, because the agent
   loop owns the capture then and re-arming would hand a second VAD to a
   running loop.

**C. `processUserText(text, opts)`** (line 1425) — everything after a final
transcript. Options: `source?: 'voice' | 'routine' | 'suggestion' | 'typed'`,
`agentId?`, `cameFromPtt?`, `forceAgent?`. It captures
`const myTurnId = this.turnId; const isCurrent = () => this.turnId === myTurnId;`.
Mode flags are read from `settingsStore` at each point of use, **not** from a
turn-start snapshot: a turn can live for minutes and the user may toggle
dictation/agent/auto-type meanwhile.

The branches, in the order the code evaluates them:

1. **Consume the one-shots.** `forcedDictation` and `forcedAgent` are read and
   immediately cleared at the top, so every early return inherits the clear.
2. **Agent voice stop.** If `agentEnabled` and `agentLive` (voice `'acting'` +
   `currentAbort !== null` + not `signal.aborted`) and
   `CompanionManager.STOP_COMMAND.test(trimmed)` → `stopAgent()`,
   `speakLine('stopped.')`, return. The liveness probe is what makes this safe:
   a PTT interrupt already aborted the loop via its turn bump, so PTT
   transcripts always fall through.
3. **Agent live, not a stop command** → return. Speech while the loop drives is
   always a VAD utterance; opening a competing talk turn would fight the driver.
4. **Mode-toggling voice commands.** `/^(hey zapi,? )?(start|begin) dictat/i`
   → `setDictation(true)`, speak `'dictation on.'`. `/stop dictat|^stop
   dictating/i` → off. These run *before* dictation so the trigger phrase
   itself is never typed into the user's document.
5. **Voice self-settings**, gated to `trimmed.split(/\s+/).filter(Boolean)
   .length < 8` (see §2.5).
6. **Dictation** — `forcedDictation || settings.dictationEnabled`. Auto-typed
   when `autoTypeEnabled` via `typeText(trimmed)`, else
   `clipboard.writeText(trimmed)`. Then `onTypeFulfilled`, a synthetic
   `onAiResponseComplete('(dictated)')` to close the stream turn,
   `usageStore.recordDictationUtterance`, a `kind: 'dictation'` chat entry, and
   `setVoiceState('idle')`. No screenshot, no model call.
7. **Agent hotkey route** — `forceAgentTurn && agentEnabled`. The trigger is
   still parsed first (`extractAgentTask(trimmed) ?? trimmed`) so
   "zapi agent scout: check the build" gets both the clean task and the named
   profile. Empty task → `speakLine('what should i do?')`.
8. **Agent trigger** — `fromVoice && agentEnabled`, two ways in: the explicit
   `extractAgentTask`, or a bare imperative via
   `cameFromPtt && looksLikeCommand(trimmed)`. PTT accepts a bare imperative
   because holding the key is the opt-in; always-on VAD keeps requiring a wake
   token, because hearing "play something" in a room conversation must never
   take the mouse. Both call
   `orchestrator.runTask(target.agentId, target.task)`.
9. **Normal talk turn.** `setVoiceState('processing')` — deliberately held
   through think + stream + synthesize so the spinner does not flash for a few
   ms during capture only. `await captureAllDisplays()`. If the result is
   empty, speak a friendly message (a macOS-specific line about Screen
   Recording permission) instead of letting an empty image 400 the upstream
   LLM call, then `'idle'`.
10. `const abort = new AbortController(); this.currentAbort = abort;` then
    `streamMind(text, screenshots, context.getMessagesForSend(), 'talk',
    abort.signal, mindCallbacks)`. Every one of the three `MindCallbacks` starts
    with `if (!isCurrent()) return;`. `onComplete` owns its own `try/catch`
    because providers call it *without awaiting* the returned promise — an
    escaping throw would pin the UI on `'processing'` forever and deafen the
    VAD gate. Finally `if (this.currentAbort === abort) this.currentAbort = null`.

**D. `completeTalkTurn(...)`** (line 1688) — the post-provider work, split out
specifically so the fire-and-forget call site's `try/catch` is impossible to
drop. In order: `trackAiResponseReceived`; strip tags with `TAG_STRIP_REGEX` for
`cleanText` and emit `onAiResponseComplete(cleanText)`;
`context.recordExchange(userText, cleanText, {inputTokens, outputTokens})`;
`emitMemoryStats()`; write every `parseFileTags(fullText)` entry through
`artifactStore.writeArtifact`, each in its own `try/catch` so a rejected
filename or full disk cannot kill the turn; append the `kind: 'talk'` chat
entry carrying `artifactIds`; `usageStore.recordTalkTurn(agentId)`; emit a
`phase: 'done'` agent status naming the written files.

Then the two tag consumers, both fed `stripFileBlocks(fullText)` — file content
is **user data**, so a `[POINT:]` inside a markdown deliverable must not draw on
screen or type into a field: `parseScene(instructionText, lastScreenshots)` →
`startScene(scene, isCurrent)` plus `analytics.trackSceneDrawn`, and
`parseTypeTags(instructionText)` → `typeText` or clipboard, each emitting
`onTypeFulfilled`.

Then speech: `const mutedRoutine = announce && settingsStore.get('routinesMuted')`
— a muted routine still runs, it just does not speak. `synthesizeSpeech(cleanText)`,
`if (!isCurrent()) return;` again, `setVoiceState('responding')` +
`playSpeech(audio)`, `setVoiceState('idle')`. Finally, if `announce && agentId
!== 'main'`, `announceCompletion(...)` with the reply plus the file note —
`'main'` is exempt because its own reply already spoke.

**E. Scene scheduler and TTS** are covered in §2.7 and §2.10.

### 2.3 `turnId` and the `isCurrent()` gate

`private turnId = 0` is the monotonic counter. Every entry point that starts
something new bumps it: `startRecording` (`this.turnId += 1`),
`processVadUtterance` (`const myTurnId = ++this.turnId`),
`playDemoScene` (`++this.turnId`), `runQueuedTask` (`+= 1`), and
`resetFromMicError` (`+= 1`).

Each turn then captures the id and derives the predicate:

```ts
const myTurnId = this.turnId;
const isCurrent = () => this.turnId === myTurnId;
```

**Every async callback that mutates UI must test it.** The concrete sites:
`mindCallbacks.onChunk`, `onComplete`, `onError` in the talk turn; the
`startScene` beat timers; `speakLine`; the post-capture check in the talk turn;
`completeTalkTurn` after `recordExchange` and after `synthesizeSpeech`; and
`processVadUtterance`'s post-transcription check. The payoff per the comments:
no stale chunks, no stale chat entries, no TTS that would have to be killed on
arrival.

Bumping alone is *not* enough, which is why the abort always precedes the bump.
`processVadUtterance`'s comment is explicit: bumping fences off stale
callbacks, but the LLM stream it was meant to supersede would keep running —
and keep holding the provider socket — until it finished on its own.

The one deliberate exception: the end-of-scene clear in `startScene` is **not**
gated, because a turn superseded mid-scene still owns the overlay's cursor
state, and skipping the null-emits left the overlay painting the last point
cue and its stale bubble forever. The cue beats *are* gated, and a newer
scene's `startScene` cancels that timer outright, so the ungated clears can
only ever clear a scene that is still live.

The same gate applies per agent runtime: a background run that is aborted must
not resurrect a status card.

### 2.4 Always-on listening and the wake gate

`handleVadUtterance(pcm)` (line 978) is the always-on entry point. It drops —
with a distinct log line per reason, because "always-on listening does nothing"
is otherwise unanswerable from a hands-on bug report — when:
`!alwaysOnEnabled`; `micTestActive` (the setup check owns the mic and would
transcribe a half-captured buffer); `isRecording || pendingStart`; or
`voiceState` is neither `'idle'` nor `'acting'`. `'acting'` is admitted on
purpose so a hands-free "zapi stop" reaches the stop check; the other
non-idle states drop so the mic does not hear our own TTS.

`processVadUtterance` aborts the in-flight controller, takes `++this.turnId`,
and — when not `acting` — stops speech, clears scene timers, emits a reset
agent status, and sets `'processing'`. When `acting` it touches none of that:
the loop keeps owning voice state until it ends or stops.

`normalizeVadUtterance(text)` is the wake gate:

```ts
/(?:\b(?:hey|ok|okay)\b[,.! ]*)?\b(zapi|zappi|zappy)\b[,.! ]*/i
```

The wake token may appear **anywhere** in the phrase ("hey zapi what's this",
"what is this zapi"); the match is stripped so the model never sees it. PTT
turns never pass through here — a keypress is already an explicit summon, so
the full transcript is kept.

`STOP_COMMAND` is declared once as a `private static readonly` so the gate and
`processUserText` cannot drift on what counts as a stop:

```ts
/^(hey |ok |okay )?(zapi |zappi )?(stop|cancel|abort|enough|never ?mind)[.! ]*$/i
```

While `acting`, a bare stop **bypasses** the wake gate entirely — the user is
reacting to the mouse moving under them, and demanding "zapi" first is exactly
the friction the stop affordance exists to remove. This is safe because the
stripped text still routes to the stop branch, and every other early return in
`processUserText` is a no-op on "stop".

### 2.5 Spoken voice self-settings

`applyVoiceSelfSetting(text, isCurrent)` (line 2280) returns `true` when the
transcript was a self-setting command (turn done) and `false` to fall through.
The caller only offers it to transcripts under 8 words, so a real question that
merely mentions "talk slower" still becomes a model turn.

Normalisation first: lowercase, punctuation flattened to spaces (so
"stop talking, please" matches "stop talking please"), whitespace collapsed,
and an optional `(?:hey |okay |ok |please )?(?:zapi|zappi|zappy)\s+` lead
stripped. The VAD path already removed its wake span, but a PTT transcript
carries whatever the user said.

Every command core is anchored `^…$`, so mid-sentence mentions can never fire.
A shared optional tail allows only fixed short words — `please | thanks |
thank you | now | for now | again | yourself | yourselves | to me | with me | to
us | a bit | a little | just | ok | okay | alright`:

```ts
const TAIL = String.raw`(?:\s+(?:please|thanks|…|alright))*`;
const cmd = (core: string): RegExp => new RegExp(`^${core}${TAIL}$`);
```

| Intent | Accepted cores (abridged) | Effect | Confirmation |
|---|---|---|---|
| Slower | `talk/speak(ing) (a \|a little \|a bit )?slower/more slowly`, `slow down` | `setVoiceSpeed(clamp(v - 0.15))` | `'slower.'` |
| Faster | `…faster/quicker/more quickly`, `speed up` | `setVoiceSpeed(clamp(v + 0.15))` | `'faster.'` |
| Be quiet | `stop/quit/end (talking\|announcing\|speaking\|chatting\|replying\|responding)`, `(don't\|dont\|do not) (talk\|speak\|announce\|reply\|respond\|say anything)`, `(be\|stay\|keep\|go) quiet`, `hush\|shush\|shh` | `setSpeakReplies(false)` | `'okay, quiet now.'` |
| Speak again | `start/resume/keep/go back to …`, `talk/speak(ing) (to me\|with me\|to us\|again)`, `you (can\|may) …`, `unmute\|speak up\|speak freely` | `setSpeakReplies(true)` | `'talking again.'` |
| Mute routines | `(mute\|silence\|quiet)( the\| my\| your\| our)? routines?` | `setRoutinesMuted(true)` | `'routines muted.'` |
| Unmute routines | `unmute … routines?`, `let … routines? (talk\|speak\|announce)` | `setRoutinesMuted(false)` | `'routines unmuted.'` |
| Always listen | `listen always`, `always listen(ing)`, `always[- ]on`, `keep/stay/start/resume ( always)? listening (always)?`, `never stop listening` | `setAlwaysOn(true)` | `'always listening.'` |
| Stop listening | `stop (always )?listening`, `(don't\|dont\|do not) listen`, `listening off`, `turn/switch off (always )?listening` | `setAlwaysOn(false)` | `"i'll stop listening."` |

`clampSpeed` bounds to the slider's documented `0.7 – 1.2` range. Off-phrases
are tested *before* on-phrases so "don't talk to me" cannot land on the
on-branch. "Stop talking" cannot confirm out loud — with `speakReplies` off the
reply text still reaches the stream, and the silence itself is the proof the
setting took.

Crucially these route through the **same setters** the panel and tray use
(`setVoiceSpeed`, `setSpeakReplies`, `setRoutinesMuted`, `setAlwaysOn`), not by
writing the store directly. That is what keeps `SETTINGS_CHANGED` firing and the
tray menu rebuilding.

### 2.6 `resolveAgentTarget` — longest-name-first routing

`resolveAgentTarget(transcript, task)` (line 1837) picks the agent a trigger
utterance names and strips the name so the model never sees it.

```ts
const profiles = [...settingsStore.listAgents()].sort(
  (a, b) => b.name.length - a.name.length,
);
for (const profile of profiles) {
  const name = profile.name;
  if (!name) continue;
  if (!new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(transcript)) continue;
  const lead = new RegExp(`^\\s*${escapeRegExp(name)}\\s*[:,—\\-]\\s*`, 'i');
  const cleaned = lead.test(task) ? task.replace(lead, '').trim() : task;
  return { agentId: profile.id, task: cleaned };
}
return { agentId: AGENT_ID_MAIN, task };
```

- **Longest name first**, so "Path" cannot shadow "Pathfinder".
- `\b`-anchored, case-insensitive, anywhere in the transcript.
- The `lead` regex strips a leading `"<name>:"` / `"<name> -"` / em-dash. The
  parser hands `"zapi agent scout: open notepad"` through as the task
  `"scout: open notepad"`, which must become `"open notepad"` on Scout's card.
- An unrecognized name **falls back to `'main'`** rather than dropping the
  request.
- `escapeRegExp` (module scope, line 139) escapes a user-authored agent name
  before interpolation, so a profile called `C++` cannot produce a broken or
  injected `RegExp`.

### 2.7 The scene scheduler

`startScene(scene, isCurrent, onDone?)` (line 1157) emits the whole cue list
once via `onScene(scene)`, then one `setTimeout` per cue emitting
`onSceneCue(i)` at accumulated offsets. Dwell is per kind:

```ts
'point' → Math.max(2600, Math.min(5500, 1800 + label.length * 80))
'clear' → 300
default → Math.min(2000, 1100 + (cue.text?.length ?? 0) * 40)
```

A `point` cue keeps the old walkthrough timing so longer instructions stay
readable; draw cues are quick strokes plus 40 ms per written character, capped
at 2 s; `clear` just needs a beat for the wipe.

An `endTimer` at `cursor + 4000` holds the finished drawing, then emits
`onSceneCue(null)`, `onScene(null)`, and calls `onDone?.()` **only if**
`isCurrent()`. Each timer is pushed into `sceneTimers`, and
`clearSceneTimers()` (line 1141) clears them all — called at the top of
`startScene`, on every new turn, and on `resetFromMicError`.

`playDemoScene()` (line 1206) is the first-run ink demo: a canned ~6-cue scene
(`buildDemoScene`, arrow → box → write → circle → path → point) through the real
scheduler so it needs no API keys. It refuses to steal a live turn
(`isRecording || pendingStart || voiceState !== 'idle'` all veto), owns a fresh
turn id so a PTT press mid-demo cancels playback, and rides `'responding'` for
the playback span.

`showTransientBanner(text)` (line 2045) reuses the same scheduler for a single
`write` cue rather than inventing a second overlay channel. The geometry is
wrap-aware because the renderer's `write` cue wraps at 46 columns with rows
growing *down* from the anchor:

```ts
const WRITE_COLS = 46;   const WRITE_CH_PX = 10;   const WRITE_ROW_PX = 38;
```

The banner's `isCurrent` is `() => true` — a banner should survive turn churn,
and the next real turn's `startRecording` clears it if it must.

### 2.8 `runTextTurn`, `acceptSuggestion`, `refreshSuggestions`

All three converge on `runQueuedTask(agentId, task, source, label)` (line 1882)
— the shared shape behind scheduled routines, accepted suggestion cards and
typed chat messages. Two guards keep a queued task from hijacking a live
conversation: empty text is a no-op, and the task is skipped entirely while
`isRecording || pendingStart || voiceState !== 'idle'` (logged as
`<label> skipped: pipeline busy`). `routinesMuted` deliberately does **not**
gate the run — muting silences the announcement, not the work. A queued task is
a real turn, so it bumps `turnId` before `processUserText(trimmedTask, {source,
agentId})`.

- **`runTextTurn(agentId, text)`** (line 1921) — a panel chat message. Called
  from index.ts as `companion.runTextTurn(agentId ?? 'main', text ?? '')`.
  Because `source` is `'typed'`, `fromVoice` is false, so *none* of the
  voice-only branches run: no self-settings commands, no dictation, no agent
  trigger. A routine like "email me the agent roster" cannot dictate the word
  "agent" into the user's document or spawn a nested agent run.
- **`runRoutineTask(routine)`** (line 1906) — the `RoutineScheduler` `onFire`
  callback, `source: 'routine'`.
- **`acceptSuggestion(id)`** (line 1932) — finds the card via
  `suggestionStore.listAll()`, and on a miss reports
  `couldn't find that suggestion — it may already be gone`. On a hit it
  **dismisses first** (an accepted card never comes back, even if the run is
  then skipped for a busy pipeline), calls `emitSettings()`, and fires
  `runQueuedTask(card.agentId, card.task, 'suggestion', …)`.
- **`dismissSuggestion(id)`** (line 1948) — dismiss only, with a not-found
  error path.
- **`refreshSuggestions()`** (line 1965) — guarded by a
  `suggestionsRefreshing` boolean, because two racing refreshes would
  double-add cards. It collects every non-archived agent
  (`{id, name}`) and each one's recent `ChatEntry[]`, calls
  `generateSuggestions({agents, recentChats, complete})`, and `add`s each
  result. A refresh that finds nothing new still emits settings, so the panel
  learns the pile is up to date either way. `completeOnce(prompt, signal)`
  (line 2001) is the one-shot completion helper: it reuses `streamMind` so
  provider/model/base-URL selection stays in exactly one place, drops chunks
  (only the full reply matters), and folds a provider that throws before
  reaching its callbacks into the same `reject`.

`announceCompletion(agentId, summary, {silent})` (line 2026) shows a transient
banner and, unless muted, speaks `"<name> finished."` — skipped entirely when
`voiceState !== 'idle'`, because the user's own reply matters more than a
status ping. `maybeAnnounceAgentDone(status)` routes `phase: 'done'` from
`buildAgentDeps`'s `onStatus` here, skipping `'main'`.

### 2.9 Agent runtime deps and the voice-ownership rule

`buildAgentDeps(agentId)` (line 282) is what `AgentOrchestrator` calls to build
one runtime's collaborators, and it encodes the central multi-agent safety
rule:

```ts
const isMain = agentId === AGENT_ID_MAIN;
const turn = isMain ? { beginTurn, currentTurnId, setAbort, currentAbort,
                        setVoiceState, voiceState }   // bound to `this`
                   : new LocalTurnControl();          // private state
return { turn, ownsVoice: isMain, … };
```

`'main'` shares this instance's turn id, abort controller and voice state, which
is what keeps its run interruptible by PTT, a new VAD turn, and the mic-error
reset. **Any other agent gets private turn state and no voice control at all** —
a background agent must never flip the microphone's state or speak over the
user, nor wipe the foreground agent's ink.

The `streamMind` override adds agent memory: `agentWorkspace.readMemory(agentId)`
(the agent's `AGENTS.md`) is prefixed onto every step's prompt, so a fact the
model memo'd on step N is visible on step N+1. An empty read skips the section
entirely — never send a bare heading. On completion, `parseMemos(text)` turns
`[MEMO:...]` tags into dated notes; `parseMemos` strips FILE blocks first
(a memo inside a file the model just produced is data, not an instruction), and
`appendMemo` returning false is ignored so a rejected write cannot break the run.

### 2.10 Mind dispatch and TTS fallback

`streamMind(prompt, screenshots, history, mode, signal, callbacks)` (line 2094)
is the single place provider selection lives. `mindOptions` always carries
`reasoningDepth`, `replyTone`, `signal` and `mode`. Then:

- `mindProvider === 'openai'` — model is
  `customOpenAIModel || selectedOpenAIModel` (a custom id wins so users can point
  at model names the picker does not list), `baseUrl: openAIBaseUrl || undefined`.
- `mindProvider === 'ollama'` — takes the first **enabled**
  `localConnections` entry; with none, `callbacks.onError(new Error('No enabled
  local connection. Add one in Mind → Local.'))`. Model resolution is
  `activeModelId` → `modelIds[0]` → discovered `getModels(...)[0]` → `'llama3'`,
  prefixed with `conn.prefixId` when set. The bearer token is
  `keyStore.getApiKey('local_' + conn.id)`.
- otherwise Claude with `selectedModel`.

`synthesizeSpeech(text)` (line 2170) returns `Buffer | null`. It returns `null`
immediately when `!speakReplies`. When the selected provider has no key it
**never falls back to the other provider** — a Fish Audio user would get an
ElevenLabs voice they neither chose nor configured. Instead it warns once per
provider per session (`ttsMissingKeyWarned: Set<TtsProvider>`), surfaces an
actionable `onError`, and routes to `speakViaSystemVoice`. A thrown error (e.g.
Fish Audio's 402 "insufficient credit") does the same. Every "can't speak" path
goes through `speakViaSystemVoice` first, so callers just `if (audio)`.

`speakViaSystemVoice(text, rate)` re-strips `TAG_STRIP_REGEX` even though
callers pass clean text — a canned line must never leak a stray tag to SAPI —
emits `onSpeakText(spoken, rate)` so the overlay's `speechSynthesis` reads it,
and returns `null` so every caller's `if (audio)` skips its own playback. The
one-time `ttsFallbackAnnounced` cue fires on the lightest visible channel
(the panel/stream error line).

`playSpeech(buffer)` (line 2428) calls `stopSpeech()` **first**, explicitly: on
multi-display setups playback is single-target while the stop is broadcast, so
without it a second monitor's overlay could still be mid-sentence and the two
would talk over each other.

`speakLine(text, isCurrent)` (line 2257) is the canned-line helper: it emits
both `onAiResponseChunk` and `onAiResponseComplete` (so the stream does not
leave the turn stuck on "streaming"), synthesizes, re-checks `isCurrent`, plays
if there is audio, then `'idle'`.

---

## 3. `src/main/windows.ts` — the three window factories

**Source:** `src/main/windows.ts` (370 lines).
**Exported symbols:** `supportsAcrylic()`, `scheduleDisplaySync(fn)`,
`createPanelWindow()`, `overlayDisplayByWebContents`, `createOverlayWindow(display)`,
`applyOverlayVisibility(windows)`, `createStreamWindow(storedBounds)`.
Module-private: `PANEL_FALLBACK_BG`, `WIN11_MIN_BUILD`, `getPreloadPath()`,
`hardenWindow(win)`, `loadPage(win, page)`, `toDisplayInfo(display)`,
`registerPanelWindowIpc()`, `panelFor(webContentsId)`, `bestOverlapDisplay(rect)`,
`resolveStreamBounds(stored)`, `defaultStreamBounds()`.

`const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER === '1';` decides
both load strategy and the navigation allowlist.

### 3.1 `createPanelWindow()`

The main settings/status window. 960×640, `minWidth: 820`, `minHeight: 560`,
`show: false`, `frame: true`, `titleBarStyle: 'default'`, resizable/movable/
minimizable/maximizable, `fullscreenable: false`, `skipTaskbar: false`,
`title: 'ZAPI'`, `autoHideMenuBar: true` (Windows/Linux otherwise show
Electron's stock menu bar above the panel; Alt still reveals it).

**Transparency and blur are deliberately inverted here versus the overlay.**
`transparent: false`, plus either `backgroundMaterial: 'acrylic'` or
`backgroundColor: PANEL_FALLBACK_BG` (`'#0f0f11'`). Acrylic needs an *opaque*
window: the material is composited by the OS behind a transparent-background
surface, and a `transparent` window on Windows disables the blur and costs a lot
of paint time. The panel's own CSS supplies the translucency.

`supportsAcrylic()` returns true only on `win32` with
`os.release().split('.')[2] >= 22000` — the first Windows 11 build (21H2).
Below that, asking for `backgroundMaterial` yields an opaque window with a
broken transparent region, which is worse than the plain solid background.
Anything unparseable takes the safe branch.

`webPreferences`: the shared preload, `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: false` with the reason recorded:
`sandbox: true` caused blank-screen renderers, likely a require-resolution
issue with the relative preload path; flipping it safely needs the preload
bundled as one self-contained esbuild file first.

The factory stores itself in `panelWindowRef`, clears it on `closed`, and
self-registers `registerPanelWindowIpc()` — deliberately from the factory
rather than from index.ts, since the handlers are two lines that only make
sense next to the window they act on. `registerPanelWindowIpc` is idempotent
(`panelIpcRegistered`) and both handlers resolve the window from the sender's
`webContents` via `panelFor(event.sender.id)`, then compare it against the
panel ref — an overlay or the stream window asking to be minimized is ignored
rather than obeyed. `PANEL_MAXIMIZE` **returns the new maximized state** so
the renderer can flip its traffic-light glyph without polling `isMaximized()`.

### 3.2 `createOverlayWindow(display)`

A transparent, click-through overlay covering one display. Position and size
come straight from `display.bounds`; `show: true`, `frame: false`,
`resizable`/`movable`/`minimizable`/`maximizable`/`fullscreenable` all false,
`skipTaskbar: true`, `transparent: true`, `alwaysOnTop: true`, `hasShadow:
false`, `focusable: false`.

Post-construction calls, each with a stated reason:

- `win.setIgnoreMouseEvents(true, { forward: true })` — click-through, so mouse
  events reach the windows underneath.
- `win.setContentProtection(true)` — keep the overlay out of screenshots
  entirely; otherwise `desktopCapturer` and user screen-shares would see the
  ink/pill over the desktop, and **the agent's own capture loop would read its
  own scribbles back as screen state**.
- `win.setAlwaysOnTop(true, 'screen-saver')`.
- `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.

`webPreferences` adds `backgroundThrottling: false` — the overlay animates
scenes and the cursor off rAF, and a throttled render loop under occlusion
would freeze ink mid-stroke.

**The numeric-only display-info contract.** The overlay's coordinate space is
handed over up front:

```ts
additionalArguments: [DISPLAY_INFO_ARG_PREFIX + JSON.stringify(displayInfo)]
```

where `toDisplayInfo` produces only `{id, bounds, scaleFactor}` — every field
numeric. The reason it can be plain JSON is stated twice: **Windows splits
`additionalArguments` on spaces**, so the serialized value must never contain
one. This is safe only because every `DisplayInfo` field is numeric; if the type
ever grows a string field (a display label, say) it must be base64'd first.
The IPC push below can land before React has attached its listener, so the
renderer needs a value readable synchronously on mount.

`overlayDisplayByWebContents.set(wcId, display)` — `wcId` is captured *up front*
because by the time `closed` fires the `webContents` is destroyed and
accessing `.id` throws — and deleted on `closed`. This map is what lets
`ipcMain.handle('get-display-info')` in main answer based on which window the
IPC came from, and it is the basis of every routing rule in §1.6.

A `did-finish-load` handler re-sends `'display-info'` on the raw channel. That
send is explicitly *redundant, not an update path*: the preload already reads
the same snapshot out of `argv` on every load including reloads, and it stays
as a cheap safety net in case the argv read fails. Bounds changes do **not**
arrive here — the window is destroyed and recreated by `rebuildOverlays`.

`applyOverlayVisibility(windows)` calls `showInactive()` on every live window.
Overlays are **always** shown: they double as the drawing canvas for scene ink,
point cues and agent-action echoes, so hiding them when the user disables the
companion cursor would blank that whole surface. With the toggle off the
*renderer* hides the cursor itself, because main stops forwarding
`CURSOR_POSITION` and sends one `off` pulse instead.

### 3.3 `createStreamWindow(storedBounds)`

The transparent, draggable live Q/A mirror. `minWidth: 280`, `minHeight: 180`,
`show: false`, `frame: false`, resizable/movable, `minimizable`/`maximizable`/
`fullscreenable` false, `skipTaskbar: true`, `transparent: true`,
`alwaysOnTop: true`, `hasShadow: false`, **`focusable: true`** (mouse events
enabled so scrolling and text selection work), `title: 'Zapi Stream'`.
`setAlwaysOnTop(true, 'floating')` — a lower level than the overlay's
`'screen-saver'` — and `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`.

`resolveStreamBounds(stored)` is the placement logic. A null stored rect, or
one with zero overlap against every display, falls back to
`defaultStreamBounds()`. Otherwise the display with the **largest overlap area**
(`bestOverlapDisplay`) is chosen, size is clamped to its `workArea`, and
position is clamped inside it. The reason: stored bounds may point at a display
that has since been removed or shrunk (laptop undocked, resolution changed),
and the window is frameless + `skipTaskbar`, so an off-screen window is both
invisible and unreachable. `defaultStreamBounds()` is 380×320 anchored to the
bottom-right of the primary work area with a 24 px gutter.

### 3.4 `hardenWindow` and `loadPage`

`hardenWindow(win)` is applied to all three factories:

- `setWindowOpenHandler(() => ({ action: 'deny' }))` — renderers are single
  local pages and nothing legitimately calls `window.open`.
- a `will-navigate` guard allowing only `http://localhost:5173/` in dev or
  `file://` packaged, so a compromised renderer cannot pull remote content into
  a privileged preload context. `loadURL`/`loadFile` do not fire
  `will-navigate`, so page loads and reloads are unaffected.

CSP is deliberately **not** set here: all pages are local behind
`contextIsolation` + no `nodeIntegration`, and a response-header CSP buys little
over the navigation guards. A per-page `<meta>` CSP in the HTML is the cleaner
lever if one is ever needed.

`loadPage(win, page)` loads `http://localhost:5173/<page>.html` in dev or
`<__dirname>/../../renderer/<page>.html` packaged, logging which. All three
factories load `panel`, `overlay` and `stream` respectively.

### 3.5 `scheduleDisplaySync` and `supportsAcrylic`

`scheduleDisplaySync(fn)` is a 300 ms coalescing debounce over a single module
timer. Docking stations, resolution toggles and GPU resets fire
`display-added`/`removed`/`metrics-changed` in rapid bursts, and every sync that
observes a changed topology destroys and recreates the affected overlays — a
full renderer reload each. index.ts wires it to the add/remove events; the
crash-driven rebuild path has its own separate debounce there.

`supportsAcrylic()` is described in §3.1; it is exported so it can be tested
against the same `WIN11_MIN_BUILD` constant the factory uses.

---

## 4. `src/main/services/audio-capture.ts` — the audio IPC names

**Source:** `src/main/services/audio-capture.ts` (21 lines).
**Exported symbol:** `const AUDIO_IPC` — the only content of the file.

```ts
export const AUDIO_IPC = {
  AUDIO_CHUNK: 'audio-chunk',           // Renderer → Main: raw PCM16 (ArrayBuffer)
  START_CAPTURE: 'start-audio-capture', // Main → Renderer: open the mic gate
  STOP_CAPTURE: 'stop-audio-capture',   // Main → Renderer: close the mic gate
} as const;
```

The module is a protocol declaration only — it contains no Electron import and
no runtime logic. Its doc comment records the architectural reason it exists
at all: actual capture happens in the **renderer** (the overlay) because the Web
Audio API requires a browser context. The renderer uses
`navigator.mediaDevices.getUserMedia()`, pipes through an AudioWorklet to
produce PCM16 @ 16 kHz mono, and sends buffers over these three channels.

These three names are deliberately **not** in the frozen `shared/types.ts` `IPC`
const, and neither are `play-audio` / `stop-audio`. The comment in index.ts
explains: the audio pipe predates the shared const (inherited from
heyclicky), preload listens on the same raw literals, and
`scripts/preload-check.mts` allow-lists them. Moving them into the shared
contract would require a coordinated preload + types rename, so they stay raw.

---

## 5. `src/shared/types.ts` — the single contract

**Source:** `src/shared/types.ts` (648 lines, 726 with the read tool's
numbering). **Exported symbols** include `VoiceState`,
`BuddyNavigationMode`, `TranscriptionProviderType`, `GroqTranscriptionModel`,
`TranscriptionResult`, `CaptureMode`, `DisplayInfo`, `DISPLAY_INFO_ARG_PREFIX`,
`ScreenCapture`, `ClaudeModel`, `OpenAIModel`, `MindProvider`, `ReasoningDepth`,
`ReplyTone`, `PttMode`, `ConversationTurn`, `SceneCueKind`, `SceneCue`, `Scene`,
`AgentActionKind`, `AgentAction`, `AgentProfile`, `AgentPhase`, `Routine`,
`Artifact`, `Suggestion`, `AgentStatus`, `TypeRequest`, `OllamaModelInfo`,
`OllamaPullProgress`, `LocalConnection`, `ApiKeyName`, `ApiKeyStatus`,
`ApiKeyValidation`, `PermissionStatus`, `TtsProvider`, `FishTtsModel`,
`VoicePreset`, `VOICE_PRESETS`, `ChatEntry`, `UsageStats`, `MemoryStats`,
`StreamVisibility`, `StreamWindowBounds`, `FlickySettings`, `DEFAULT_SETTINGS`,
`IPC`.

**Why it is the single source of truth.** It has no Electron import and no
`node:` import — it is pure types plus two frozen constants. All three
processes import it:

- `src/main/index.ts` and `src/main/windows.ts` import `IPC`,
  `DISPLAY_INFO_ARG_PREFIX` and the payload types for `ipcMain` handlers.
- `src/main/companion-manager.ts` imports ~30 types for its callback signatures.
- `src/preload/index.ts` imports `IPC`, `DISPLAY_INFO_ARG_PREFIX` and 30+ types
  to type the `window.flicky` surface.
- Renderers type their listeners against the same `IPC` keys.

The file is therefore a **three-way contract**: a change to `IPC` is not
complete until `shared/types.ts`, the preload surface, and the `ipcMain`
handlers in main all move together. The same applies to the tag DSL, where
`types.ts` shapes, `element-detector.ts` regexes, and `prompts.ts` prompt text
must stay in lockstep.

### 5.1 `IPC` — the channel map

`export const IPC = { … } as const;` — a single frozen object, grouped into
comment-delimited sections. The `as const` is what makes the values usable as
literal types.

| Group | Representative keys |
|---|---|
| Main → Renderer (state) | `VOICE_STATE_CHANGED`, `TRANSCRIPT_UPDATE`, `AI_RESPONSE_CHUNK`, `AI_RESPONSE_COMPLETE` |
| Main → Renderer (scenes) | `SCENE` (full `{cues}` or `null`), `SCENE_CUE` (beat index or `null`) |
| Main → Renderer (agent) | `AGENT_STATUS`, `AGENT_ACTION`, `AGENT_STOP`, `PLAY_SFX`, `SPEAK_TEXT` |
| Overlay → Main (audio) | `VAD_UTTERANCE` (PCM16 mono 16 kHz), `MIC_LEVEL`, `MIC_ERROR` |
| Renderer → Main (settings) | `GET_SETTINGS`, `SET_MODEL`, `SET_OPENAI_MODEL`, `SET_MIND_PROVIDER`, `SET_REASONING_DEPTH`, `SET_REPLY_TONE`, `SET_VOICE_ID`, `SET_VOICE_SPEED`, `SET_VOICE_STABILITY`, `SET_SPEAK_REPLIES`, `SET_GROQ_MODEL` |
| Renderer → Main (general) | `TOGGLE_CURSOR`, `SET_LAUNCH_AT_LOGIN`, `SET_PUSH_TO_TALK_SHORTCUT`, `SET_AGENT_PTT_SHORTCUT`, `SET_PTT_MODE`, `SET_AUTO_TYPE_ENABLED`, `SET_STREAM_VISIBILITY`, `SET_STREAM_WINDOW_BOUNDS` |
| Renderer → Main (TTS) | `SET_TTS_PROVIDER`, `SET_FISH_VOICE_ID`, `SET_FISH_TTS_MODEL`, `PLAY_VOICE_PREVIEW` |
| Panel chrome | `PANEL_MINIMIZE` (invoke → void), `PANEL_MAXIMIZE` (invoke → boolean) |
| Mode switches | `SET_ALWAYS_ON`, `SET_DICTATION`, `SET_DICTATION_SHORTCUT`, `SET_AGENT_ENABLED`, `SET_AGENT_MAX_STEPS`, `SET_CUSTOM_OPENAI_MODEL`, `SET_OPENAI_BASE_URL` |
| Agents | `AGENT_LIST`, `AGENT_CREATE`, `AGENT_RENAME`, `AGENT_ARCHIVE` |
| Routines | `ROUTINE_LIST`, `ROUTINE_UPSERT`, `ROUTINE_DELETE`, `SET_ROUTINES_MUTED` |
| Artifacts | `ARTIFACT_LIST`, `ARTIFACT_OPEN`, `ARTIFACT_REVEAL`, `OPEN_AGENT_WORKSPACE` |
| Suggestions | `SUGGESTION_LIST`, `SUGGESTION_ACCEPT`, `SUGGESTION_DISMISS`, `SUGGESTION_REFRESH` |
| Chat / context | `CHAT_MARK_READ`, `TEXT_TURN`, `GET_CHAT_HISTORY`, `CLEAR_CHAT_HISTORY`, `CLEAR_CONTEXT`, `COMPACT_CONTEXT`, `GET_MEMORY_STATS`, `GET_USAGE_STATS` |
| Setup verification | `PTT_TEST_START`, `PTT_TEST_STOP`, `MIC_TEST_START`, `MIC_TEST_STOP`, `PTT_SHORTCUT_FIRED`, `GET_APP_VERSION` |
| API keys | `SET_API_KEY`, `DELETE_API_KEY`, `GET_API_KEY_STATUS`, `VALIDATE_API_KEY`, `VALIDATE_STORED_API_KEY` |
| Local connections | `GET/ADD/UPDATE/DELETE_LOCAL_CONNECTION`, `TEST_LOCAL_CONNECTION`, `SET/DELETE_LOCAL_CONNECTION_KEY` |
| Ollama models | `GET_OLLAMA_MODELS`, `PULL_OLLAMA_MODEL`, `OLLAMA_PULL_PROGRESS`, `OLLAMA_PULL_COMPLETE`, `OLLAMA_PULL_ERROR`, `DELETE_OLLAMA_MODEL`, `CREATE_OLLAMA_MODEL` |
| Lifecycle | `SUSPEND/RESUME_PUSH_TO_TALK_SHORTCUT`, `OPEN_EXTERNAL`, `QUIT_APP`, `REPLAY_ONBOARDING`, `COMPLETE_ONBOARDING` |
| Errors | `AI_ERROR` (a turn failed: bad key, network, provider) |

Every key carries a doc comment stating its payload and return shape, and the
`invoke`-vs-`send` distinction is documented where it matters (the panel
minimize/maximize pair). `LIST_REMOTE_MODELS` documents that it invokes
`{openAIBaseUrl||api.openai.com}/v1/models` and returns `string[]`.

Note what is *absent*: `start-audio-capture`, `stop-audio-capture`,
`audio-chunk`, `play-audio`, `stop-audio` and `display-info` are raw string
literals owned by `AUDIO_IPC` and `windows.ts` (see §4).

### 5.2 `FlickySettings` and `DEFAULT_SETTINGS`

`FlickySettings` is one flat interface, commented in six blocks: **Mind**,
**Voice (TTS)**, **Ear (transcription)**, **General**, **Modes**, plus
**Local model connections** and **Lifecycle**. Notable members:

- `mindProvider: MindProvider`, `selectedModel: ClaudeModel`,
  `selectedOpenAIModel: OpenAIModel`, `reasoningDepth`, `replyTone`.
- `voiceId`, `fishVoiceId` (`''` = provider default), `fishTtsModel`
  (`'s2.1-pro-free'` bills $0; without it the request defaults to paid
  `s2.1-pro` and 402s on a $0-credit account), `voiceSpeed` (0.7–1.2,
  ElevenLabs' accepted range), `voiceStability` (0–1), `speakReplies`.
- `pushToTalkShortcut`, `agentPttShortcut` (holding it *is* the takeover
  consent), `dictationShortcut`, and `pttMode: PttMode` with the hold/toggle
  semantics documented inline.
- `autoTypeEnabled` — needs Accessibility on macOS and the native auto-typer
  module; falls back to clipboard otherwise; off by default.
- `streamVisibility: StreamVisibility` and `streamWindowBounds:
  StreamWindowBounds | null` (`null` = auto-place).
- `alwaysOnEnabled`, `dictationEnabled`, `agentEnabled`, `agentMaxSteps`,
  `customOpenAIModel` (wins over `selectedOpenAIModel` when non-empty),
  `openAIBaseUrl` (normalized: trailing slash + `/v1` stripped).
- `agents: AgentProfile[]`, `routines: Routine[]`, `routinesMuted` (silences
  completions, never a run), `localConnections: LocalConnection[]`.
- `onboardingComplete`, `apiKeyStatus: ApiKeyStatus`, `encryptionAvailable`
  (`false` when OS `safeStorage` is unavailable, so keys are stored
  unencrypted — check this before promising encryption).

`DEFAULT_SETTINGS` is ClinePass-first: new installs land on
`mindProvider: 'openai'` with `selectedOpenAIModel: 'gpt-5'`, and the comment
notes it is kept in lockstep with `settings-store`'s own `DEFAULTS`. Notable
defaults: `ttsProvider: 'fishaudio'`, `fishTtsModel: 's2.1-pro-free'`,
`voiceSpeed: 1.0`, `voiceStability: 0.5`, `speakReplies: true`,
`pushToTalkShortcut: 'Ctrl+Alt+X'`, `agentPttShortcut: 'Ctrl+Shift+A'`,
`dictationShortcut: 'Ctrl+Alt+D'`, `pttMode: 'hold'`, `streamVisibility: 'off'`,
`alwaysOnEnabled: false`, `dictationEnabled: false`, `agentEnabled: true`,
`agentMaxSteps: 15`, and one agent — `{id: 'main', name: 'Zapi',
kaomoji: '(•‿•)', color: '#7b4dff'}`.

### 5.3 `Scene` and `SceneCue`

`SceneCueKind` is the closed set of cue kinds: `point` (cursor hops to x,y with
a caption bubble), `arrow`, `circle`, `box`, `hilite`, `path`, `write`, and
`clear` (wipe accumulated strokes mid-scene).

`SceneCue` carries `kind`, the display-space anchor `x`/`y`, secondary geometry
`x2`/`y2` (arrow tip), `w`/`h` (box/hilite size, circle radii), `points?`
(polyline vertices for `path`), `text?` (caption/label/written text),
`screenIndex` (which captured screenshot the cue was authored against), and
`step?`/`total?` (1-based, set for `point` cues so step UI works).
`Scene` is simply `{ cues: SceneCue[] }`.

The header comment is load-bearing: **all coordinates are display-space logical
pixels, already mapped out of screenshot space by the parser in main**. That
mapping is why `element-detector` exposes `shotToDisplay`, and why the win32
`scaleFactor` convention in `agent-driver` has to agree with it.

### 5.4 `AgentAction` and `AgentStatus`

`AgentActionKind`: `click`, `dclick`, `rclick`, `type`, `key`, `scroll`,
`drag`, `move`, `wait`, `open` (launch a URL via `shell.openExternal`, an app
name, or a file path), `done`, `fail`.

`AgentAction` fields: `kind`; `agentId?` (echo routing/attribution);
`x`/`y` (display-space logical, for pointer actions); `x2`/`y2` (drag
destination); `text?` (`type` → the text, `key` → a combo like `"ctrl+s"`,
`done`/`fail` → the message); `amount?` (`scroll` → wheel notches, `wait` →
ms); `direction?: 'up' | 'down' | 'left' | 'right'`; `screenIndex?`.

`AgentPhase` is `'idle' | 'thinking' | 'waiting' | 'acting' | 'done' |
'failed'`. `AgentStatus` is `{ agentId, phase, step, maxSteps, message? }` —
the per-agent status line, and the shape behind `IPC.AGENT_STATUS`.

`'waiting'` is not decorative: it is the phase an agent runtime reports while
blocked on the input lease (`input-lease.ts` is a module-level FIFO mutex around
nut-js, taken for a whole action batch), surfaced via the driver's
`onLeaseWait` hook.

`AgentProfile` is the multi-agent identity — `{ id (user-authored slug), name,
kaomoji, color, createdAt, archived }` — and its doc comment notes it lives
**inside the settings payload**, so it goes through `settings-store` +
`SETTINGS_CHANGED` like any other setting, never a separate file.

### 5.5 `CaptureMode`, `DisplayInfo`, `UsageStats`

**`CaptureMode = 'ptt' | 'vad'`** — documented on the type itself: `'ptt'`
forwards every PCM chunk to main live (a push-to-talk turn); `'vad'` runs the
local VAD, buffers voiced audio, and ships each finished utterance as one
`VAD_UTTERANCE` (always-on mode). This is the payload of
`AUDIO_IPC.START_CAPTURE` and the value main tracks in `audioCaptureMode`.

**`DisplayInfo = { id, bounds: {x,y,width,height}, scaleFactor }`** — plus
`DISPLAY_INFO_ARG_PREFIX = '--zapi-display-info='`, whose doc comment states
the reason: the prefix hands an overlay its display info through
`webPreferences.additionalArguments` so the renderer can read it *synchronously
at startup* instead of racing an IPC message. See §3.2 for the numeric-only
constraint that follows from it.

`ScreenCapture` is the richer capture shape (`dataBase64`, `displayId`,
`imageWidth`/`imageHeight`, `displayBounds`, `isCursorScreen`) produced by
`captureAllDisplays()`, cursor-display-first.

**`UsageStats`** is the monthly meter:

```ts
{ month: string /* 'YYYY-MM', rolls over monthly */,
  talkTurns: number, agentMessages: number, dictationUtterances: number,
  perAgent?: Record<string, { talkTurns, agentMessages, dictationUtterances }> }
```

`perAgent` is keyed by `AgentProfile.id`; the flat totals keep working
alongside it, which is what lets the pre-multi-agent UI keep reading
`talkTurns` directly.

Adjacent types the same contract owns: `MemoryStats` (`tokens`, `tokenBudget`,
`messageCount`, `summarizedCount`, `hasSummary`, `lastCompactedAt`),
`ChatEntry` (with `kind?: 'talk' | 'dictation' | 'agent'`, `agentId?`,
`read?` driving unread dots, `artifactIds?`), `Routine` (`kind: 'interval' |
'daily'`, `intervalMinutes?`, `timeOfDay?`, `task`, `enabled`, `lastRunAt?`),
`Artifact` (`kind: 'sheet' | 'doc' | 'image' | 'code' | 'other'`),
`Suggestion` (`dismissed` is permanent), `PermissionStatus` (with
`microphoneStatus` distinguishing "not asked yet" from "explicitly blocked"),
and `TranscriptionResult` (`{ text, isFinal }` — with the standing constraint
that no partial-transcript channel exists).

---

## 6. `src/preload/index.ts` — the `window.flicky` bridge

**Source:** `src/preload/index.ts` (403 lines, 457 with the read tool's
numbering). **Exported symbols:** `type FlickyAPI = typeof api` — the type only;
the object itself is exposed at the bottom by
`contextBridge.exposeInMainWorld('flicky', api)`.

The file is a single `const api = { … }` literal. Its shape follows one rule:
**one `window.flicky` method per `IPC` key, in both directions**, with the
`IPC` constant (never a string literal) naming the channel.

**Synchronous startup value.** `initialDisplayInfo` is an IIFE at module scope
that scans `process.argv` for `DISPLAY_INFO_ARG_PREFIX` and `JSON.parse`s the
rest, returning `null` for a non-overlay window. A parse failure logs
`'[Zapi] Could not parse display info from launch args:'` rather than failing
silently — a silent `null` would reproduce the exact bug the argument exists to
fix. `getDisplayInfo()` returns this value directly; it is the only synchronous
member besides `platform`.

`platform: process.platform as NodeJS.Platform` is resolved at runtime in main
rather than baked by Vite's compile-time `define`, so a CI build of a macOS dmg
on Linux cannot leak the build host's platform into the renderer.

**Invoke vs send.** Reads and anything needing a return value use
`ipcRenderer.invoke`: `getSettings`, `getPermissions`, `getAppVersion`,
`getMemoryStats`, `compactContext`, `getChatHistory`, `getUsageStats`,
`getAgents`, `getRoutines`, `getArtifacts`, `getSuggestions`,
`getApiKeyStatus`, `validateApiKey`, `validateStoredApiKey`, `listRemoteModels`,
`minimizePanel`, `toggleMaximizePanel`, and the entire local-connection /
Ollama-model surface. Mutations use `ipcRenderer.send`. The panel minimize and
maximize pair is `invoke` specifically so the maximize toggle can hand back the
new state — a renderer painting its own glyph from a stale guess shows the
wrong one after the second click.

**Listener shape.** Every `on*` member follows one template:

```ts
onAgentStatus: (cb: (status: AgentStatus) => void) => {
  const handler = (_e: Electron.IpcRendererEvent, s: AgentStatus) => cb(s);
  ipcRenderer.on(IPC.AGENT_STATUS, handler);
  return () => ipcRenderer.removeListener(IPC.AGENT_STATUS, handler);
},
```

Every one **returns its own unsubscribe closure**, so a React effect can detach
without the handler ever being registered twice. The `Electron.IpcRendererEvent`
first argument is dropped in the wrapper, so renderers never see the event
object.

Listener set: `onVoiceStateChanged`, `onTranscriptUpdate`, `onAiResponseChunk`,
`onAiResponseComplete`, `onScene`, `onSceneCue`, `onAgentStatus`,
`onAgentAction`, `onTypeFulfilled`, `onCursorPosition`, `onSettingsChanged`,
`onPermissionStatus`, `onMemoryStats`, `onChatEntryAdded`, `onPttShortcutFired`,
`onMicLevel`, `onMicError`, `onAiError`, `onDisplayInfo`, `onStartCapture`,
`onStopCapture`, `onPlayAudio`, `onStopAudio`, `onPlaySfx`, `onSpeakText`, and
the three Ollama pull events.

Two payload details worth naming:

- `onCursorPosition` types the payload as `{x, y, off?}` — the optional flag is
  part of the contract precisely so consumers do not need a cast to read the
  `{x:-9999, y:-9999, off:true}` pulse main sends when the cursor leaves a
  display.
- `onStartCapture` defaults a missing payload to `{mode: 'ptt'}` rather than
  forwarding `undefined`.
- `onPlayAudio` **copies** the `Buffer` into a fresh `ArrayBuffer`
  (`new Uint8Array(copy).set(new Uint8Array(data.buffer, data.byteOffset,
  data.byteLength))`) rather than handing the view across the bridge, and
  `sendAudioChunk` / `sendVadUtterance` wrap an incoming `ArrayBuffer` back
  into a `Buffer` — structured-clone conversion in both directions.

The raw-literal members (`onDisplayInfo` on `'display-info'`, `onStartCapture`
on `'start-audio-capture'`, `onStopCapture` on `'stop-audio-capture'`,
`sendAudioChunk` on `'audio-chunk'`, `onPlayAudio` on `'play-audio'`,
`onStopAudio` on `'stop-audio'`) mirror §4: these are the audio-pipe channels
that predate the shared `IPC` const. `sendVadUtterance` is the exception — it
uses `IPC.VAD_UTTERANCE`, because it is a newer channel that was added to the
contract properly.

`scripts/preload-check.mts` is the verification that keeps the
one-to-one correspondence honest: every `IPC.*` key must have a live sender, and
every preload channel must resolve in both directions, including matching
`ipcRenderer.on` pairs — with the raw audio literals allow-listed.

---

## 7. Cross-cutting invariants

Five rules cut across all five files. They are the ones a future change is
most likely to break.

1. **The `userData` claim is module-scope and load-bearing.** Every store
   resolves through `app.getPath('userData')`. Move `app.setPath` below
   `whenReady` and the stores split across two directories
   (`index.ts` lines 34–63).

2. **The tag DSL is a three-way contract.** `shared/types.ts` shapes,
   `element-detector.ts` regexes and mappers, and `prompts.ts` prompt text must
   move together. So must `IPC` in `types.ts` + the preload surface + the
   `ipcMain` handlers. `preload-check.mts` verifies the IPC half; the DSL half
   is covered by `parse-smoke.mts`.

3. **Every async UI mutation passes `isCurrent()`.** `turnId` is bumped and the
   in-flight `AbortController` aborted at every turn boundary, and each
   turn's callbacks test `isCurrent()` before touching shared state. The
   deliberate exception is the end-of-scene clear, documented in §2.3. The same
   gate applies per agent runtime.

4. **File bodies are data, not instructions.** `parseAgentActions` and
   `parseScene` / `parseTypeTags` must be fed `stripFileBlocks(text)`, never
   raw reply text — otherwise an `[ACT:key:enter]` inside a python file the
   model wrote executes against the user's machine. `parseMemos` follows the
   same rule.

5. **Model-supplied strings are untrusted at every boundary.** Artifact paths go
   through `artifact-store`'s sanitizer plus the `path.dirname` assertion in
   `writeArtifact`; agent names go through `escapeRegExp` before `RegExp`
   interpolation; `IPC.OPEN_EXTERNAL` is `/^(https?|mailto):/i`-gated; file
   bodies are stripped before tag parsing. Never `path.join(userData,
   modelString)` by hand.

Two conventions worth carrying into any edit:

- **Comments explain why, not what.** Nearly every non-obvious line in these
  five files carries the bug or motive that produced it. The hold-mode grace
  windows, the 300 ms display debounce, the `sandbox: false` note, the numeric
  `additionalArguments` rule — these are not decoration, and deleting them
  silently loses the only record of why the code looks the way it does.
- **Audio and TTS never broadcast.** Capture, playback and the type-fulfilled
  toast each target exactly one overlay (`sendToOneOverlay`, `startCaptureOn`).
  Only `stop-audio` and `SPEAK_TEXT` broadcast, because only the holding
  overlay can silence a buffer and only the cursor-bearing display should speak.
