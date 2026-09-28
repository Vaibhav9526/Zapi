# REVIEW2 — main-entry review (src/main/index.ts + windows.ts)

Read end-to-end; report only, nothing changed. Line refs are against the
file at review time. Companion internals were consulted where they define
the contract (shortcut re-register, permission queries).

## [CRITICAL]

### 1. Unhandled promise rejections in main are fatal — multiple sites

Electron's main is a Node runtime; since Node 15 the default
unhandled-rejection mode throws, i.e. one rejected promise in main takes
the whole app down. Sites that can produce one:

- `startPermsPoll` tick: `await companion.getPermissions()` with no
  `.catch` — the `void tick()` at index.ts:68 and the interval body at
  :71. `getPermissions` has a try/catch only around the win32 mic probe
  (companion-manager.ts:513); a throw anywhere else in it crashes the app
  every 5 s while the panel is open.
- PTT/dictation start/stop: `.then(...)` with no `.catch` at index.ts
  :376, :381, :460, :465, and bare `void` calls at :396, :404, :480, :488.
  The code comments say the companion "silently flips isRecording" on
  failure — i.e. it resolves on handled failures — but any thrown
  exception inside (provider init, store write) escapes as a rejection.
- `shell.openExternal` results are dropped everywhere: `void` at
  companion-manager.ts:529 and bare calls at :542, :555, :575 plus
  index.ts:591 — a rejected `openExternal` (bad scheme, no handler) is
  unhandled.
- `PULL_OLLAMA_MODEL` callbacks do `event.sender.send(...)` at
  index.ts:677, :680, :683 with no `event.sender.isDestroyed()` check —
  if the panel is closed mid-pull, the send throws inside the promise
  chain → unhandled rejection.

One `.catch`/`isDestroyed` audit pass over these sites would close the
class.

## [MINOR]

### 2. Shortcut registration failure never reaches the user

`registerPttShortcut`/`registerDictationShortcut` return `false` on bad or
taken accelerators and roll back to the previous binding (index.ts:402–427,
483–507). Companion reverts the stored setting on failure and only logs
`console.warn` (companion-manager.ts:337–343, 368–369). Net UX: user
captures a new hotkey, the OS refuses it (e.g. claimed by another app,
or PTT + dictation set to the same combo), and the UI silently shows the
old binding with no error — reads as "capture didn't take." The initial
`registerPttShortcut(...)` at index.ts:429 also ignores the return, so a
corrupt stored shortcut leaves no working hotkey with zero signal.
Worth an `AI_ERROR`/toast to the panel.

### 3. Tray ghost icon on quit

`will-quit` unregisters shortcuts and flushes chat history
(index.ts:740–744) but never `tray.destroy()` — Windows keeps the icon
lingering ("ghost tray icon") until the user hovers it.

### 4. Cursor-position `setInterval` is never cleared and runs 30 fps forever

index.ts:711 — the poll early-returns when `isClickyCursorEnabled` is off,
but it still wakes ~30×/s for the app's whole lifetime, and nothing clears
it (by contrast `permsTimer` has start/stop at :61–75). Cheap per tick,
but it's a permanent wake source on battery and contradicts the comment's
own optimization framing.

### 5. `syncOverlaysToDisplays` touches `.webContents` before the `isDestroyed` guard

index.ts:864 evaluates `overlayDisplayByWebContents.get(win.webContents.id)`
inside the condition before `win.isDestroyed()` is checked — accessing
`.webContents` on a destroyed BrowserWindow throws, crashing the `screen`
event handler mid-sync. `syncOverlayBounds` (:892) uses the correct order.
Low reachability (the array rarely holds destroyed windows) but the guard
order should match.

### 6. Overlay renderer failures are silent and can take the mic down with them

Overlays get no `did-fail-load` or `render-process-gone` handling
(createOverlayWindow, windows.ts:79–148; the panel logs `did-fail-load`
at index.ts:820 but overlays log nothing). A failed overlay is a dead ink
surface *and* a candidate for `sendToOneOverlay` (index.ts:154–157), which
hosts mic capture and TTS playback — picking the broken one means silent
total audio failure with only a renderer-side MIC_ERROR path that also
lives in the dead window. Worth a load-health check before choosing the
audio overlay, or a retry/`render-process-gone` rebuild.

### 7. Display removal mid-capture truncates live audio silently

`display-removed`/`display-added` → `syncOverlaysToDisplays`
(index.ts:299–300) destroys the removed display's overlay — including the
one hosting active mic capture (PTT/dictation/always-on). The utterance
truncates with no error surfaced; the next capture quietly re-homes to
whatever `sendToOneOverlay` picks first. Docking/undocking mid-sentence is
a real laptop flow.

### 8. Stream-window close flips the persisted setting to 'off'

`ensureStreamWindow`'s `close` handler calls
`companion.setStreamVisibility('off')` (index.ts:914–919). One stray
Alt+F4/taskbar close permanently disables the stream until re-enabled in
settings — "close it once" and "never show it again" shouldn't be the
same gesture.

## [NOTE]

- **No `session.setPermissionRequestHandler` anywhere.** Electron's default
  grants all permission requests, which is why `getUserMedia` in the
  overlay works on Windows. Fine while every page is local with
  contextIsolation on — but a future `<webview>`/untrusted navigation
  would inherit auto-grant. Windows mic gating is handled OS-side and
  surfaced via `MIC_ERROR` → panel + the settings deeplink flow
  (companion-manager.ts:524–532).
- **`!gotLock` path** (index.ts:23–26): `app.quit()` is issued but module
  code still registers `second-instance` and the `whenReady` body is not
  gated on the lock (only `initGpuGuard` is, :46). On versions where
  `ready` still fires before quit, a duplicate instance can briefly build
  tray/overlays and attempt (failing) shortcut registrations.
- **`window-all-closed` never quits** (index.ts:747–749) — correct for a
  tray app on every platform; the comment says macOS but the behavior is
  load-bearing on Windows too.
- **`MIC_ERROR` is forwarded twice** — as `MIC_ERROR` and as `AI_ERROR`
  (index.ts:552–555). If the panel listens to both, one mic failure may
  surface twice.
- **`PTT_SHORTCUT_FIRED` fires on every hold-mode repeat** (index.ts:364) —
  the panel gets ~30 msg/s while a key is held; harmless but wasteful.
- **Sync `ipcMain.on` handlers that throw become uncaughtException** —
  e.g. `companion.handleAudioChunk` (:698), `handleVadUtterance` (:586).
  `ipcMain.handle` rejections correctly become rejected `invoke()`s in the
  renderer (callers there must catch — noted per scope, not fixed).
- **`OPEN_EXTERNAL` has no scheme allowlist** (index.ts:591) — renderer is
  trusted/local today; a `^https?:|^ms-settings:` check would harden it.
- **`rebuildTrayMenu` wholesale-replaces the menu on every settings change**
  (index.ts:760) — correct and cheap, but an already-open menu won't
  live-update; checkbox states refresh on next open.
- **Quit teardown is partial**: pending PTT/dictation debounce timers,
  the cursor interval, scene timers and the agent AbortController
  (companion-side) aren't shut down in `will-quit` — process exit reaps
  them, but a debounce firing mid-quit can call `stopPushToTalk` during
  teardown.
- **`sandbox: false` on all three windows** (windows.ts:53, :104, :185)
  with `contextIsolation: true` — documented trade-off for the preload;
  keep it in mind if remote content is ever loaded.
- **`sendToOneOverlay` picks the first non-destroyed overlay** — arbitrary
  display hosts the mic and TTS; correct for single-play, but combined
  with finding 6 it should also prefer a *healthy* renderer.

## Verified healthy

- Single-instance lock + `second-instance` → panel focus/restore
  (index.ts:23–40) with `!companion` guard.
- `before-quit`/`isAppQuitting` consistently gates the hide-instead-of-
  close handlers on panel + stream (index.ts:825–829, :914–920).
- `will-quit` does call `globalShortcut.unregisterAll()` +
  `chatHistory.flushSync()` (index.ts:740–744).
- Shortcut suspend/resume covers BOTH hotkeys during capture
  (index.ts:512–528) — no cross-fire while recording a new binding.
- Tray menu reads live settings per rebuild and is re-emitted on
  `onSettingsChanged` (index.ts:255–260, 292, 760–789).
- `will-quit`/`second-instance`/`getSettings` handlers are all wired
  after `whenReady`, no ordering hazards there.
- Scene broadcast routing is clean post-fix: every overlay gets SCENE +
  beats, renderer culls per display; agent echoes stay per-action
  targeted; stream copies intact.

## Resolution status (post-fix pass)

**RESOLVED** in `src/main/index.ts`:

- **CRITICAL 1** — every listed rejection site is now guarded: perms
  `tick` wraps the probe in try/catch; all PTT/dictation `.then()` chains
  and hold-path `void` calls carry `.catch`; `REQUEST_PERMISSION`,
  `PLAY_VOICE_PREVIEW`, and `handleLostCapture`'s `stopPushToTalk` are
  `.catch`'d; `OPEN_EXTERNAL` validates scheme + `.catch`; the Ollama
  pull sends through an `isDestroyed()`-guarded helper; the sync
  `VAD_UTTERANCE`/`AUDIO_CHUNK` handlers are try/catch'd.
- **MINOR 2** — both register functions emit `AI_ERROR` to the panel on
  failure, so a refused hotkey produces a visible toast (settings still
  revert to the last-good binding).
- **MINOR 3** — `will-quit` now destroys the tray, clears the cursor
  interval and the perms poll, and wraps `flushSync` in try/catch.
- **MINOR 4** — the cursor poll is a stored timer (`cursorPollTimer`),
  cleared on quit; body is exception-guarded.
- **MINOR 5** — `syncOverlaysToDisplays` checks `isDestroyed()` before
  touching `.webContents`, matching `syncOverlayBounds`.
- **MINOR 6** — `watchOverlayHealth` attaches `render-process-gone` +
  `did-fail-load` per overlay (via `spawnOverlay`); a lost renderer
  schedules a debounced (150 ms) + rate-limited (10 s) `rebuildOverlays`.
- **MINOR 7** — `audioCaptureWcId`/`audioCaptureMode` track the mic
  overlay; `handleLostCapture` finishes an in-flight turn via
  `stopPushToTalk` or re-arms VAD/mic-test capture on a surviving
  overlay after display removal or a crash rebuild.
- **MINOR 8** — the stream `close` handler only hides; `streamVisibility`
  now changes exclusively via the explicit panel toggle.
- **NOTE (permissions)** — `defaultSession.setPermissionRequestHandler`
  now allowlists `media`/`display-capture`/clipboard permissions.
- **NOTE (mic reset)** — `MIC_ERROR` calls the optional-chained
  `companion.resetFromMicError?.()` hook; see `AUDIT.md ## FOR-OWNER`
  for the companion-side requirements (method + companion's own
  `openExternal` rejections at ~:529–575).

**RESOLVED** in `src/main/windows.ts`:

- Stream-bounds restore existed but never validated the stored rect —
  `resolveStreamBounds` (windows.ts:241) now clamps into the
  most-overlapping display's work area, falling back to the default
  anchor on zero overlap. An undocked display can no longer strand the
  frameless, taskbar-less stream off-screen.

**VERIFIED (no change needed):**

- Stream write-back: `moved`/`resized` → `persistStreamBounds` →
  `companion.setStreamWindowBounds` → `settingsStore` ✓ wired end-to-end.
  Not debounced, but on Windows `moved`/`resized` fire once per completed
  gesture (continuous variants are `move`/`resize`), so cost is one
  atomic JSON write per finished drag — acceptable for a Windows-first
  app. If a port to macOS ever lands, `moved` is continuous there and
  this write path would need a debounce.
- Panel position: no memory by design — the panel is a standard framed
  window opened centered on the primary display; nothing anchors it to
  the tray and no code implies near-tray placement. Adding persistence
  is a possible follow-up but requires a new `StoredSettings` key +
  `moved`/`resized` wiring in index.ts — out of this pass's ownership.
- Quit cleanup: `before-quit` → `isAppQuitting` disarms both
  hide-instead-of-close handlers; Electron destroys all windows on quit
  (panel, stream, overlays — overlays have no `close` interception);
  `will-quit` reaps shortcuts, the cursor poll, the perms poll, the
  tray, and chat-history writes.

**RESIDUAL (needs index.ts/companion owner):**

- ~~`display-added`/`display-removed` call `syncOverlaysToDisplays`
  un-debounced~~ — RESOLVED: both subscriptions route through
  `scheduleDisplaySync` (windows.ts, 300 ms coalesce) via
  `syncDisplaysSoon`, with an `isAppQuitting` re-check inside the
  deferred body (index.ts:404–409). `display-metrics-changed` stays
  direct — bounds-only syncs are cheap.
- ~~`scheduleOverlayRebuild` checks `isAppQuitting` only at schedule
  time~~ — RESOLVED: the timer body now re-checks `isAppQuitting`
  (index.ts:1016), so a crash event <150 ms before quit can't spawn
  overlays mid-teardown.
- Pending PTT/dictation debounce timers and scene timers aren't cleared
  on quit; process exit reaps them, but a timer firing mid-quit could
  still call `stopPushToTalk` during teardown.
