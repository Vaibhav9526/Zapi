# Part C — The Renderer Layer (`src/renderer/`)

Everything the user actually sees in Zapi lives here: the per-display transparent overlay that
draws on top of the desktop, the settings panel, and the floating live-Q/A stream. None of it can
touch Node, the filesystem, or a provider directly — every capability arrives on the
`window.flicky` object that `src/preload/index.ts` installs via `contextBridge`. This document is a
read of the code as it exists; every claim below is anchored to a file and, where useful, a line.

## Table of contents

1. [Three entry points, three BrowserWindows](#1-three-entry-points-three-browserwindows)
2. [How the renderer talks to main: the `window.flicky` surface](#2-how-the-renderer-talks-to-main-the-windowflicky-surface)
3. [`types.d.ts` and the global window augmentation](#3-typesdts-and-the-global-window-augmentation)
4. [The overlay window: a per-display click-through canvas](#4-the-overlay-window-a-per-display-click-through-canvas)
5. [Mic capture and the VAD](#5-mic-capture-and-the-vad)
6. [`audio-capture-worklet.js`: PCM16 mono at 16 kHz](#6-audio-capture-workletjs-pcm16-mono-at-16-khz)
7. [TTS playback and the OS-voice fallback](#7-tts-playback-and-the-os-voice-fallback)
8. [`inkMath.ts`: pure geometry](#8-inkmathts-pure-geometry)
9. [`InkLayer.tsx`: the SVG that draws](#9-inklayertsx-the-svg-that-draws)
10. [The panel window](#10-the-panel-window)
11. [`HomeTab`: the multi-agent surface](#11-hometab-the-multi-agent-surface)
12. [`ChatsTab`: history and typed turns](#12-chatstab-history-and-typed-turns)
13. [`MindTab`, `VoiceTab`, `EarTab`: the provider tabs](#13-mindtab-voicetab-eartab-the-provider-tabs)
14. [`GeneralTab`: shortcuts, modes, memory, companion](#14-generaltab-shortcuts-modes-memory-companion)
15. [`Onboarding`: the verified ten-step wizard](#15-onboarding-the-verified-ten-step-wizard)
16. [Modal and small panel components](#16-modal-and-small-panel-components)
17. [The stream window](#17-the-stream-window)
18. [Styles, fonts, and assets](#18-styles-fonts-and-assets)
19. [Component inventory](#19-component-inventory)
20. [Cross-cutting invariants worth preserving](#20-cross-cutting-invariants-worth-preserving)
21. [Known gaps](#21-known-gaps)

---

## 1. Three entry points, three BrowserWindows

The renderer is not one app; it is three independent React roots, one per window kind. Vite's
`rollupOptions.input` names all three (`vite.config.ts:17-21`):

```ts
input: {
  panel:   path.resolve(__dirname, 'src/renderer/panel.html'),
  overlay: path.resolve(__dirname, 'src/renderer/overlay.html'),
  stream:  path.resolve(__dirname, 'src/renderer/stream.html'),
},
```

| Entry | HTML | TSX root | Window created by | Purpose |
|---|---|---|---|---|
| `overlay` | `overlay.html` (15 lines) | `overlay.tsx` → `<OverlayApp/>` | `createOverlayWindow(display)` in `src/main/windows.ts:205` | One **per display**: companion cursor, ink strokes, agent echoes, mic capture, VAD, TTS playback |
| `panel` | `panel.html` (12 lines) | `panel.tsx` → `<PanelApp/>` | `createPanelWindow()` in `src/main/windows.ts:91` | Settings, chat history, agent management, onboarding |
| `stream` | `stream.html` (15 lines) | `stream.tsx` → `<StreamApp/>` | `createStreamWindow()` in `src/main/windows.ts:312` | Transparent, draggable, scrollable live Q/A rail |

Each `.tsx` entry is a five-line shim: import React, import the root component, import the CSS
bundle, `ReactDOM.createRoot(document.getElementById('root')!)` wrapped in `React.StrictMode`
(`overlay.tsx:8-12`, `panel.tsx:9-13`, `stream.tsx:7-11`). The CSS import order matters —
`design-system.css` first (tokens + reset), then the window-specific sheets.

`overlay.html` and `stream.html` both inline `html, body { background: transparent !important; }`
in a `<style>` block so the page paints nothing before the CSS bundle loads; `stream.html` also
forces `margin: 0; height: 100%; overflow: hidden` (`stream.html:8`). `panel.html` does not —
the panel is an opaque acrylic window.

`loadPage` (`src/main/windows.ts:60-70`) picks `http://localhost:5173/<page>.html` in dev and
`dist/renderer/<page>.html` in a packaged build. All three entries share a `react` manual chunk
(`vite.config.ts:28-30`) so React is shipped once, not three times.

The panel is the only window with a real frame (`frame: true`, `titleBarStyle: 'default'`,
`transparent: false` + acrylic `backgroundMaterial` on Windows 11 — `windows.ts:96-117`). Overlay
and stream are frameless and `transparent: true`.

## 2. How the renderer talks to main: the `window.flicky` surface

`src/preload/index.ts` builds a single `api` object and calls
`contextBridge.exposeInMainWorld('flicky', api)` (line 457), exporting the type as
`FlickyAPI = typeof api` (line 455). It is one-to-one with the IPC channel map in
`src/shared/types.ts`. Three shapes exist:

- **Fire-and-forget setters** — `setSpeakReplies(enabled)` is `ipcRenderer.send(IPC.SET_SPEAK_REPLIES, …)`
  (line 72). The renderer never awaits a confirmation; it waits for the `SETTINGS_CHANGED` push
  instead, which is why every tab renders from `settings` and never from local optimism.
- **Request/response** — `getSettings()`, `getChatHistory(agentId?)`, `getArtifacts(agentId?)`,
  `compactContext()`, `validateApiKey(name, value)` are `ipcRenderer.invoke(...)` and return promises.
- **Push subscriptions** — 28 `on*` members, each returning an unsubscribe closure, e.g.
  `onSceneCue` registers on `'scene-cue'` and returns `() => ipcRenderer.removeListener(...)`
  (lines 370-372).

Which surface each window uses:

- **Overlay**: `onVoiceStateChanged`, `onCursorPosition`, `onScene`, `onSceneCue`, `onAgentStatus`,
  `onAgentAction`, `onTypeFulfilled`, `onDisplayInfo`/`getDisplayInfo`, `onStartCapture`/
  `onStopCapture`, `sendAudioChunk`, `sendVadUtterance`, `reportMicLevel`, `reportMicError`,
  `onPlayAudio`, `onStopAudio`, `onPlaySfx`, `onSpeakText`, `onSettingsChanged`, `getSettings`.
- **Panel**: essentially the whole settings/agent/routine/artifact/suggestion surface plus
  onboarding helpers (`startPttTest`, `onPttShortcutFired`, `startMicTest`, `onMicLevel`,
  `onMicError`, `replayOnboarding`, `completeOnboarding`), and `platform` for OS branching.
- **Stream**: the read-mostly mirror — `getChatHistory`, `onTranscriptUpdate`, `onAiResponseChunk`,
  `onAiResponseComplete`, `onChatEntryAdded`, `onScene`/`onSceneCue`, `onAgentStatus`/`onAgentAction`,
  `onAiError`, `onTypeFulfilled`, `getArtifacts`, `openArtifact`, `agentStop`, `getSuggestions`,
  `refreshSuggestions`, `acceptSuggestion`, `dismissSuggestion`.

Two renderer conveniences are worth knowing:

- `platform: process.platform` is resolved **at runtime in the preload**, not inlined by Vite
  (`preload/index.ts:59-63`, and the comment in `vite.config.ts:39-43`). The renderer reads it as
  `window.flicky.platform === 'darwin'` (`PanelApp` is not the only user — `GeneralTab.tsx:118`,
  `PermissionsBanner.tsx:39`, `Onboarding.tsx:38` all branch on it). A cross-compiled macOS build
  made on Linux would otherwise ship `linux` to the renderer.
- `getDisplayInfo()` returns the `DisplayInfo` the overlay was **launched** with, read
  synchronously from `process.argv` at preload time (lines 45-56, 403). `OverlayApp` calls it
  during the first render (`OverlayApp.tsx:317`) so the very first `CURSOR_POSITION` message has a
  coordinate space to map into, rather than waiting a tick for the IPC push.

## 3. `types.d.ts` and the global window augmentation

`src/renderer/types.d.ts` is six lines and exists for exactly one reason:

```ts
import type { FlickyAPI } from '../preload/index';
declare global {
  interface Window {
    flicky: FlickyAPI;
  }
}
```

It is the compile-time half of the preload contract. Every `window.flicky.*` call in the renderer is
typed against `FlickyAPI`; if a channel is added to the preload without updating this file, nothing
breaks, but if the preload method is renamed every renderer call site becomes a type error.

## 4. The overlay window: a per-display click-through canvas

`createOverlayWindow` (`windows.ts:205-286`) builds a `BrowserWindow` that fills
`display.bounds` exactly. Its load-bearing options:

- `transparent: true`, `frame: false`, `alwaysOnTop: true`, `hasShadow: false`, `focusable: false`,
  `skipTaskbar: true`.
- `win.setIgnoreMouseEvents(true, { forward: true })` (line 248) — click-through. `forward: true`
  still lets move events reach the renderer, which is what the companion cursor follows.
- `win.setContentProtection(true)` (line 255) — the overlay is **excluded from screen capture**.
  Without it, `desktopCapturer` and the agent's own capture loop would read Zapi's ink back as
  screen state.
- `win.setAlwaysOnTop(true, 'screen-saver')` and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.
- `backgroundThrottling: false` (line 234) — the overlay animates off `requestAnimationFrame`; a
  throttled loop would freeze ink mid-stroke when a fullscreen app covers it.
- `additionalArguments: [DISPLAY_INFO_ARG_PREFIX + JSON.stringify(displayInfo)]` (line 243). Safe as
  plain JSON only because every `DisplayInfo` field is numeric — Windows splits
  `additionalArguments` on spaces, so a future string field would break this.
- `overlayDisplayByWebContents.set(wcId, display)` (line 271) so main can answer
  `get-display-info` per window and route cursor/scene events to the right overlay.

Overlays are **always shown** — `applyOverlayVisibility` (lines 300-304) calls `showInactive()` on
every overlay regardless of the cursor toggle, because these windows are also the drawing canvas.
Hiding them would blank ink, not just the cursor. With the cursor off, main stops forwarding
`CURSOR_POSITION` and sends an `{ off: true }` pulse (`OverlayApp.tsx:978-987`), and the renderer
hides only the chrome (`display: cursorEnabled ? undefined : 'none'` on the triangle,
`OverlayApp.tsx:1387`).

`OverlayApp` (1,593 lines) is the biggest file in the renderer. Its state groups:

- **Cursor**: `voiceState`, `cursorPos`, `cursorMode` (`following | navigating | holding |
  returning`), `companionPos`, `isCursorOnThisDisplay`.
- **Scene**: `sceneCues`, `sceneBeat`, `inkFading`, `scenePoint`.
- **Agent**: `agentStatuses` (a `Map<agentId, TrackedStatus>` so several agents can be live),
  `agentEchoes`, `outcomeVisible`, `chipHolds`.
- **Mic/VAD**: `vadGateOpen`, `heardTick`/`heardVisible`, `pttGateOpen`, plus ~12 refs for the
  audio graph and VAD state.
- **Hints**: `cursorEnabled`, `alwaysOnEnabled`, `dictationEnabled`, `idleHintVisible`.

The companion cursor trails the real mouse by `FOLLOW_OFFSET_X = 14`, `FOLLOW_OFFSET_Y = 8`
(`OverlayApp.tsx:36-37`) so the tip does not sit directly on the real pointer. When a `point` scene
cue arrives, `hopToScenePoint` moves the companion to `cue.x - bounds.x`, sets mode `navigating`,
and flips to `holding` after 650 ms (lines 890-903). `startReturnAnimation` is the only `rAF` loop
in the file — it eases home at 8 % per frame and terminates on arrival (dist < 2) **or** a hard
120-frame cap, so multi-monitor jitter can't leave it running forever (lines 854-877). Reduced
motion snaps instead of gliding.

Scene cues arrive as a list once (`SCENE`) and then as beat indexes (`SCENE_CUE`) that reveal
`cues[0..beat]` cumulatively. A 15 s beat watchdog (`SCENE_WATCHDOG_MS`, line 937) runs
`finishScene` when cues are loaded but no beat has landed — a lost end-of-scene emit would
otherwise leave the cursor stranded on `navigating` with a stale caption. `finishScene` is shared
by the `SCENE(null)` path and the watchdog precisely so the fade + return flight cannot diverge.
The fade drops ink state after 600 ms; the return flight starts at 1,500 ms (lines 924-933).

Agent echoes come in two flavours, decided by `SPATIAL_ECHO_KINDS` (`OverlayApp.tsx:94-96`):
`move, click, dclick, rclick, drag`. Those draw a marker at the acted point
(`AgentEchoView`, lines 203-263 — double-click gets two rings, right-click/drag a dashed ring, move
a bare dot). Everything else (`type`, `key`, `scroll`, `wait`, `done`, `fail`) is coord-less — the
driver fills `x: action.x ?? 0` — so it renders as a glyph in the single shared chip stack
(`AgentEchoGlyph`, lines 273-302) rather than claiming a coordinate the driver never had. Belt and
braces: spatial echoes are additionally dropped if they fall outside this overlay's viewport
(lines 1128-1132).

The status pill is one slot for potentially many agents. `PHASE_PRIORITY = { acting: 3, waiting: 2,
thinking: 1 }` (line 135) means whoever actually drives the mouse outranks one thinking about it,
which outranks one parked on the input lease; ties fall back to most-recent emit (lines 1288-1296).
`pillAccent` deliberately returns `undefined` for `'main'` so the default agent keeps house amber
(lines 155-158). Terminal `done`/`failed` flashes a tinted pill for 3 s, taking over the slot
rather than stacking (lines 1072-1078, 1312-1326). Background agents get a top-right corner chip
(max 4, then a `+N`), held ~2.4 s after finishing so the terminal dot reads before unmount
(lines 1086-1117, 1628-1648).

There is also a **stale-status guard** in both the overlay (lines 1060-1064) and the stream
(`StreamApp.tsx:418-421`): an `idle` whose `step` is lower than the previous non-idle step for the
same agent is dropped rather than blanking a live pill.

## 5. Mic capture and the VAD

### One overlay, never broadcast

Main picks a single overlay and remembers which: `startCaptureOn(mode)`
(`src/main/index.ts:310-316`) takes `overlayWindows.find(w => !w.isDestroyed())`, stores
`audioCaptureWcId`, and sends `AUDIO_IPC.START_CAPTURE` **to that window only**. `stopCapture`
(lines 318-326) aims at the tracked id, falling back to first-alive. This is deliberate — a
broadcast would run `getUserMedia` on every display's overlay and feed duplicate audio into
transcription. The renderer side of the contract is `onStartCapture` / `onStopCapture`
(`OverlayApp.tsx:763-764`), which is why only the receiving overlay's `captureModeRef` matters.

The same one-surface rule governs two other broadcasts the renderer defends against:

- **SFX** — `onPlaySfx` only fires `playSfx` when `cursorOnDisplayRef.current` is true
  (`OverlayApp.tsx:1172-1174`). Without that guard a broadcast chime would echo once per display.
- **OS voice** — `onSpeakText` has the identical guard (lines 1178-1180). One voice per setup.

The **type toast** uses the same rule (`typeToast && isCursorOnThisDisplay`, line 1650), and
`cursorOnDisplayRef` exists specifically because IPC callbacks can't read render state (line 311).

### The audio graph, built once

`ensureGraph()` (`OverlayApp.tsx:648-723`) runs on the first PTT press and is then reused:

```ts
navigator.mediaDevices.getUserMedia({
  audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
});
const ctx = new AudioContext({ sampleRate: 16000 });
await ctx.audioWorklet.addModule(captureWorkletUrl);
const source = ctx.createMediaStreamSource(stream);
const node = new AudioWorkletNode(ctx, 'capture-processor');
source.connect(node);
node.connect(ctx.destination);   // pull-graph; the worklet's outputs stay zeroed
```

`captureWorkletUrl` is `new URL('../audio-capture-worklet.js', import.meta.url).href` (line 21),
which lets Vite emit the hand-written worklet as a static asset. The graph stays connected across
turns — start/stop just posts `'start'`/`'stop'` into the worklet port, so no `getUserMedia` or
`AudioContext` startup latency on each press. `stopMic` (lines 750-761) sets
`micStopRequestedRef` so an in-flight `ensureGraph` bails before opening the gate, then mutes the
worklet rather than tearing down. Real teardown happens only in the effect's cleanup
(lines 800-827): worklet disconnected, tracks stopped, `AudioContext` closed.

Every chunk is measured for RMS (lines 668-687). The peak is reported to main via
`reportMicLevel(min(1, peak * 4))` at ~20 Hz (throttled by a 50 ms gate), which is what
`Onboarding`'s mic-check meter renders. If `captureModeRef.current === 'vad'` the chunk goes to
`handleVadChunk`; otherwise it is forwarded live via `sendAudioChunk` — the PTT path is byte-for-byte
unchanged.

Failures are translated rather than swallowed. `NotAllowedError`/`SecurityError` →
"microphone access is blocked for Zapi…", `NotFoundError`/`OverconstrainedError` → "no microphone was
found…", `NotReadableError` → "the microphone is busy or unreadable…", else the raw name/message
(lines 709-718), then `reportMicError(friendly)`. Nobody reads a packaged app's devtools console, so
the overlay hands the message to main, which shows it in the panel.

### The VAD itself

Constants (lines 61-74) — the worklet posts one 128-sample quantum per message, so thresholds are
RMS amplitudes and durations are wall-clock ms:

| Constant | Value | Meaning |
|---|---|---|
| `VAD_FLOOR` | `0.02` | Threshold floor for quiet rooms |
| `VAD_AMBIENT_MULT` | `2.5` | Multiplier on the room-tone p90 |
| `VAD_CALIB_MS` | `1500` | Room-tone measurement window |
| `VAD_VOICED_RUN` | `3` | Consecutive voiced quanta required to open |
| `VAD_THRESHOLD_CAP` | `0.12` | Hard cap so speech peaks always clear it |
| `VAD_CALIB_LOUD` | `0.08` | Above this the calibration window is contaminated |
| `VAD_CALIB_RETRIES` | `2` | Retries of a contaminated window |
| `VAD_SILENCE_END_MS` | `800` | Trailing silence that ends an utterance |
| `VAD_MIN_MS` | `350` | Shorter than this is a click, dropped |
| `VAD_MAX_MS` | `20_000` | Runaway cap (a TV left on) |

`maybeFinalizeVadCalib` (lines 540-564) sorts the calibration samples, takes the 90th percentile,
and sets the threshold to `min(VAD_THRESHOLD_CAP, max(VAD_FLOOR, 2.5 * p90))`. If the candidate
exceeds `VAD_CALIB_LOUD` it **retries the window** rather than accepting it — always-on captures
stay open indefinitely, so a threshold derived from a speech-contaminated window would deafen the
mic until the next capture.

`handleVadChunk` (lines 594-646) has three more guards worth naming:

- **Self-hearing** — if `voiceState` is `processing`, `responding`, or `acting`, the VAD resets and
  drops the chunk, so TTS playback and agent chatter can never loop back as new turns.
- **Run-up gate** — the first quanta are held in `vadPendingRef` (capped at 8) and only adopted
  into the utterance once 3 consecutive voiced quanta arrive, so a lone click dies here rather than
  becoming a 350 ms turn.
- **Trailing silence is kept** — silence quanta are pushed into the same buffer, so word endings
  aren't clipped, and the utterance ends after `VAD_SILENCE_END_MS` of quiet.

On flush (lines 566-592) chunks shorter than `VAD_MIN_MS` are dropped, the rest are merged into one
`Int16Array`, and `window.flicky.sendVadUtterance(merged.buffer)` ships a single PCM16 mono 16 kHz
buffer to main. A `heardTick` bump plus a 900 ms `heardVisible` window drives the "✓ heard you" flash,
restarting on rapid back-to-back turns.

### Idle guidance

After 12 s of quiet hands-free idleness — always-on on, `vadGateOpen`, `voiceState === 'idle'`, no
scene, no busy agent — the overlay whispers `listening — say "hey zapi"` (lines 1235-1252). Any
state change disarms it. `sceneActive` counts a fading scene as active (line 1223) so the whisper
never lands on an explanation that just ended; `agentBusy` covers the case where a background agent
is mid-run but never flipped `voiceState` (lines 1228-1230).

## 6. `audio-capture-worklet.js`: PCM16 mono at 16 kHz

Forty lines of plain JavaScript (worklets must not be TypeScript — the file is outside the TS
compilation unit; only its URL is needed). `CaptureProcessor extends AudioWorkletProcessor`:

- The constructor installs `this.port.onmessage` and toggles `this._enabled` on `'start'`/`'stop'`.
- `process(inputs)` returns immediately while disabled, so the audio thread stays cheap — the graph
  itself is never torn down.
- When enabled it takes `inputs[0][0]` (Float32), allocates `new Int16Array(float32.length)`, clamps
  each sample to `[-1, 1]`, and scales: `s < 0 ? s * 0x8000 : s * 0x7fff` — asymmetric scaling, which
  is what keeps the full negative range representable.
- It then `this.port.postMessage(pcm16.buffer, [pcm16.buffer])` — **transferring** the buffer rather
  than copying, because the renderer's `onmessage` ships it straight to main over IPC and never
  touches it again.
- `registerProcessor('capture-processor', CaptureProcessor)` at module scope.

The header comment names the reason it is an `AudioWorkletProcessor` at all: the deprecated
`ScriptProcessorNode` it replaces ran on the UI thread and was a documented source of crackle,
dropouts, and stutter under load.

The sample rate is pinned twice — `getUserMedia({ sampleRate: 16000 })` and
`new AudioContext({ sampleRate: 16000 })` — so the quanta arriving in `process()` are already 16 kHz
and no resampling is needed anywhere.

## 7. TTS playback and the OS-voice fallback

`onPlayAudio` (lines 768-789) wraps the `ArrayBuffer` in an `audio/mpeg` Blob, makes an object URL,
and plays it. `stopCurrentTts` (lines 471-485) bumps `ttsEpochRef`, clears `onended` **first**
(clearing `src` can fire it, and a stale handler would revoke a URL a later buffer may have
recycled), pauses, resets, drops the URL and revokes it.

The epoch is the interruption idiom: a `play()` still in flight compares the epoch it captured
against the current one, so an interrupt reads as an interrupt instead of a playback failure
(lines 782-787). `onStopAudio` (lines 795-798) calls both `stopCurrentTts` and `stopOsVoice` —
main broadcasts it at every cancel boundary (new turn, agent step, app quit), and a buffer already
handed to the overlay would otherwise keep playing under the interruption.

`speakText` (lines 497-515) is the fallback for when no TTS provider is configured: it uses
`speechSynthesis`, cancels any current utterance first (a stale paragraph must never talk over a
newer reply), clamps `rate` into `[0.1, 10]` so a malformed value can't throw, and prefers a
natural Microsoft `en-*` voice (zira/aria/guy) before falling back to any `en-*` then the platform
default. `getVoices()` can return `[]` until `voiceschanged` fires, which is fine — nothing blocks.

SFX (`playSfx`, lines 448-466) is a map of lazily-created `HTMLAudioElement`s keyed by the
`IPC.PLAY_SFX` name, each at `volume = 0.35`. A same-name burst guard (400 ms) exists because a
launch→done beat can fire within a frame of each other on fast runs and a double-struck chime
reads as a glitch rather than an echo. `play()` rejections are swallowed — a missed chime must never
take the overlay down.

## 8. `inkMath.ts`: pure geometry

245 lines with no React and no DOM, deliberately split out so `scripts/ink-check.mts` can exercise
the *exact* math the overlay ships rather than a duplicated copy that can silently drift (header
comment, lines 3-7). Cue coordinates are display-space logical pixels, already mapped out of
screenshot space by main.

### Stroke budget

`STROKE_BUDGET = 48` (line 13) — one SVG node per stroke × 3 passes (under / ink / echo), so long
scenes cap live DOM at the newest ~48 and retire the rest. `sliceLive` returns the newest window;
`sliceExcess` returns the strokes that just left it and therefore get the fade-out. Point cues never
count: they drive the cursor, they don't draw.

### Smoothing

`wobble(i)` (lines 27-29) is a deterministic per-stroke offset — `((i * 37) % 5 - 2) * 0.75` and
`((i * 53 + 1) % 5 - 2) * 0.75` — so parallel strokes don't look copy-pasted without any randomness
that would shimmer on re-render.

`smoothPath(pts)` (lines 34-53) is Catmull-Rom → cubic Bézier. Control points sit at
`(p1 + (p2 - p0)/6)` and `(p2 - (p3 - p1)/6)`, with the ends clamped by duplication so the curve
passes through the first and last vertices instead of overshooting. Unlike chained line joins this
stays smooth at every vertex, which is what sells a freehand marker stroke instead of
connect-the-dots. Degenerate cases: 0 points → `''`, 1 point → a 0.1-offset line, 2 points → a
straight `L`.

### Write-wrap

`WRITE_MAX_CH = 46` (line 58) caps a handwritten label so a long model string can't sprawl across
the whole display; overflow wraps instead, and the anchor stays at the cue's `x, y` (first-line
origin) — only rows grow downward. `wrapWriteLine` (lines 60-83) hard-breaks a single token longer
than the cap (a URL, a path) mid-word rather than letting one word own a row.
`wrapWriteLines` splits on explicit `\n` first so the model controls verses, then wraps each
paragraph; empty paragraphs survive as blank rows so stanza breaks keep their spacing.

### Arrow geometry

`arrowHead(x, y, x2, y2)` (lines 120-135) returns `null` for a shaft shorter than
`ARROW_DEGENERATE_LEN = 2`. Otherwise the head length is
`min(ARROW_HEAD_MAX = 14, max(ARROW_HEAD_MIN = 6, len * ARROW_HEAD_FRACTION = 0.4))` — it shrinks
with shaft length so short arrows aren't all head — and the two barbs sit at `angle ±
ARROW_BARB_RADIANS` where `ARROW_BARB_RADIANS = Math.PI * 0.82` (±147.6°). The tip is always the
cue's `x2, y2`.

This lives in numbers rather than parsing path strings back out, so the draw path and the headless
check agree on where the barbs land — parsing would test formatting, not aim (comment, lines
94-97). `arrowPath` (lines 137-148) emits **one** path containing both the shaft and the head
subpaths so the draw-on dash animation runs continuously from tail to tip instead of restarting per
segment; the degenerate case becomes a round-capped dot rather than a floating arrowhead.

### Per-display culling, including straddles

`cueBox(cue, ox, oy)` (lines 162-243) returns the local-space bbox of one draw cue, padded for
stroke width, wobble, and arrowhead overhang — `24` for arrows, `14` for circles, `12` for
box/hilite/path, `8`/`32` on the sides for write. It returns `null` when the cue paints nothing
viewable (empty path points, all-blank write text), so such a cue never reaches the DOM at all.
The write box is a deliberate **over**estimate — "culling must never eat a visible stroke, only skip
what is clearly off-window".

`boxIntersects(box, vw, vh)` is a plain AABB test. `cueVisibleOnDisplay(cue, bounds)` (lines
256-264) returns `true` when `bounds` is null (display info not yet arrived — draw everything, the
window still clips to its own screen), and otherwise intersects the cue box against
`bounds.width × bounds.height` in window-local space.

The straddle case is the interesting one and is called out in the doc comment: a cue spanning two
displays returns `true` on **both** overlays, and each window clips to its half, so nothing is
double-drawn and nothing is lost.

## 9. `InkLayer.tsx`: the SVG that draws

275 lines. Props are the full cue list, the latest beat index (or `null`), a `fading` flag for the
~600 ms fade-out, and this overlay's display bounds.

Two deliberate decisions:

- **No `viewBox`** (lines 70-73). Bare SVG user units are CSS px, which match the display-space
  logical pixels main authors cues in at any devicePixelRatio. A viewBox scale would blur or offset
  strokes on HiDPI.
- **Window-local = display-space minus this overlay's origin**, via `lx = x - ox` / `ly = y - oy`.

The reveal pass (lines 83-104) is a `useMemo` over `[cues, beat, bounds]`:

1. `beat === null || beat < 0` → nothing.
2. A `clear` cue truncates the accumulated list to zero and continues — it's board-global, applied
   even when this overlay has culled everything else, so all screens reset.
3. `point` cues are skipped (they drive the cursor).
4. `!cueVisibleOnDisplay(cue, bounds)` → skipped.

Retirement (lines 106-160) is the subtle part. `live = sliceLive(full)`; strokes that just left the
window move into a `retired` state and fade. A `RETIRE_MS = 500` timer drops them just after the
CSS 0.45 s fade, so the fade always completes even under rapid beats. Three effects guard it: a
`cues`-keyed effect drops mid-fade retirees from a replaced scene (so rapid `SCENE` swaps can't leak
pending timers or ghost strokes); the main effect prunes first, so a `clear` beat wipes promptly
instead of showing fading ghosts over a cleared canvas; and an unmount effect clears the timer.
Retirees paint **under** live ink (`.ink-retiring` group first in the returned SVG) so a fading old
stroke never covers a fresh one.

`strokeContent` (lines 187-288) is shared by the live and retiring renders so both show identical
ink. Every stroke is drawn as three passes: `ink-under` (a dark halo ~2.5 px wider, via
`UNDER_EXTRA = 2.5`, so ink stays legible on light and dark apps underneath the transparent
overlay), `ink-draw` (the amber/red stroke, `pathLength={1}` for the CSS draw-on animation), and
`ink-echo` (the same path offset by `translate(1.2 1.2)` at low opacity — the hand-drawn wobble that
doubles as marker bleed). Palette: `INK_AMBER = '#ff9d0a'` for most strokes, `INK_RED = '#ff4d3d'`
reserved for circles that mean "look here", `HILITE_FILL = 'rgba(255,196,0,.30)'`.

Per cue kind: `arrow` additionally renders an `ink-land` pulse circle at the tip (r=7) — skipped
entirely under reduced motion, because CSS alone would still flash it for one frame before hiding
it. `circle` uses an ellipse with radii from `w`/`h` (default 40, floored at 4). `box` is a
round-capped `<rect rx={10}>` (default 80×48). `hilite` pops with a quick fade rather than a
draw-on, since a marker swipe has no single pen path to animate. `path` maps its points through
`lx/ly` plus the wobble and feeds `smoothPath`. `write` emits a `<text>` with one `<tspan>` per
wrapped row, `dy="1.25em"` for rows after the first.

`usePrefersReducedMotion` is exported from this module (lines 31-46) because `OverlayApp` needs it
for things CSS can't reach — skipping the land-pulse node and snapping the cursor glide. It mirrors
the OS setting live via `matchMedia` and unsubscribes its `change` listener.

## 10. The panel window

`PanelApp.tsx` (186 lines) is a shell: macOS-style traffic lights (close is **disabled** because
there is no hide/close IPC channel — quit lives in the tray), brand block, a six-item nav, and the
active tab. Min/max are wired to `minimizePanel()` / `toggleMaximizePanel()`; the maximize toggle
returns the new state so the glyph can flip between `+` and `⧉` without polling `isMaximized()`
(`PanelApp.tsx:105-113`, `windows.ts:169-175`).

Nav is grouped: `Home`, `Chats`; then **Providers** — `Mind`, `Voice`, `Ear`; then **System** —
`General`. Each can carry a warn dot computed from `settings.apiKeyStatus` (lines 62-65, 127-133):
Mind warns when its key is missing, Voice only when `speakReplies` is on *and* the selected TTS
provider's key is missing, Ear when the Groq key is missing.

`PanelApp` returns `null` until settings have loaded (line 55) and renders `<Onboarding>` instead
of the whole app while `settings.onboardingComplete` is false (lines 57-59) — which is why
GeneralTab's "replay onboarding" button needs no reload: main flips the flag and emits settings,
and `PanelApp` re-renders into `<Onboarding>` by itself.

Two banners sit above every tab: `PermissionsBanner`, and an unencrypted-keys banner when
`settings.encryptionAvailable` is false (lines 158-168). An `error-strip` surfaces `onAiError` for
12 s so a bad key doesn't read as "nothing happened" (lines 43-47, 152-157).

The tab wrapper is keyed on `tab` (line 183) purely so the `tabPanelIn` transition replays on every
switch — presentation only, no behaviour change. `Home` sits **outside** that wrapper because it
needs to outlive a tab switch long enough to hand off `onOpenAgentChat`.

`PermissionsBanner` (90 lines) only renders on `darwin`/`win32`. Its `ROWS` table declares which
platforms actually gate each permission, and `visibleWhen` predicates suppress the Accessibility
row unless `autoTypeEnabled` — the banner stays quiet for users who never turn on auto-typing
(lines 28-36, 61-66). It polls `getPermissions()` on mount and follows `onPermissionStatus`, then
renders one row per missing permission with a `requestPermission(kind)` button labelled "Open
settings" on Windows.

## 11. `HomeTab`: the multi-agent surface

741 lines, and the densest single view in the app. It's a dashboard: a hero (waveform + hold-to-talk
hint + rotating tip), a status column, three stat cards, and a connected-providers summary.

Four independent data sources feed it:

- **Live run state** — `onAgentStatus` into `statuses: Record<agentId, AgentStatus>`, plus
  `onAgentAction` into `lastActions` keyed by agent (lines 36-55). `AGENT_ACTION` carries no
  `agentId` on the wire, so an echo is attributed to whichever agent currently holds a
  thinking/acting phase. An `idle` clears that agent's last-action label.
- **History** — one merged `getChatHistory()` derives both "last activity" and "has unread" per
  agent, because the entries are the same payload and deriving twice would double IPC
  (lines 77-92). `read === false` is the unread signal.
- **Artifacts** — one merged `getArtifacts()`, newest-first, sliced to 3 per agent client-side
  (lines 95-107). Comment: keeps each card's three freshest files without N invokes.
- **Suggestions** — `getSuggestions()`, refreshed by a manual ↻.

The refresh wiring (lines 118-134): `onChatEntryAdded` updates last activity, sets the unread dot,
refetches piles if the entry carried `artifactIds`, and refetches usage. A `SETTINGS_CHANGED`
subscription piggybacks `loadChats()` — "chat reads/piles aren't settings, but a settings emit is the
only broadcast that guarantees a repaint-worthy state change landed", so piggybacking there beats
missing a mark-read. `refreshSuggestionCards` polls **twice** (3 s and 9 s) because generation runs a
Mind completion per agent with no completion event on the wire (lines 136-154).

Readiness is computed from `apiKeyStatus` rather than stored flags (lines 157-167): `required` is
`[mindReady, groqReady, ...(voiceRequired ? [voiceReady] : [])]` — voice only counts when the user
wants spoken replies — and the hero says "N of M providers connected" until they all match.

### `AgentCard` (lines 570-723)

One card per non-archived profile. It carries:

- kaomoji face tinted with the profile `color`, a coloured dot, and the name;
- a **sub-line** whose content depends on phase: running → `step n/max · <last action or message>`;
  settled → `<phase> · <detail>`; idle → a 42-char truncation of the last chat entry, or `idle`;
- a **stop button + spinner** while the agent holds the input lease
  (`thinking | acting | waiting`), hidden for archived cards;
- an **unread dot** — `aria-hidden`, with "unread messages" folded into the card's `aria-label` so a
  screen reader hears it once (lines 611-614);
- an **artifact pile** of up to three files: click to `openArtifact`, a `↗` button or right-click
  to `revealArtifact`. The wrapper is a `<div>` because the chip is one open target plus a reveal
  button — sibling buttons, since nested interactives are invalid. An agent with run activity but
  no files yet gets a dim "no files yet" row; idle cards get no row at all;
- a **follow-up input** that appears only once the run has settled (`done`/`failed`),
  `sendTextTurn(agent.id, text)` on Enter or the arrow button;
- a 📁 button for `openAgentWorkspace(agent.id)`.

Clicking the card body calls `onOpen`, which clears the unread dot locally (so the dot dies with the
click rather than waiting on a history refetch) and deep-links to Chats filtered to that agent.
Archived agents live behind a `▸ N archived` disclosure and render without `onOpen` or the follow-up
box.

### Routines block

`RoutineRow` (lines 510-536) shows name, owner kaomoji+name, a schedule label from
`routineScheduleLabel` (`daily at HH:MM`, or `every Nm` / `every Nh` when the interval divides
into hours), an enable toggle that upserts the **full** routine with `enabled` flipped, and a delete
button. `routinesMuted` silences only the completion announcement, never the run.

### Suggestions block

`SuggestionCard` (lines 737-771) shows the title, the engine's reason, and the owning agent chip,
plus **do it** (`acceptSuggestion`) and **×** (`dismissSuggestion` — permanent; `list()` hides it but
the file keeps it). Both buttons disable while the owning agent's phase is
`thinking | acting | waiting`, matching routine semantics: a busy agent skips work rather than
queueing it.

Also on Home: a "zapi is drawing on your screen" chip while `onScene` is non-null, an always-on chip
when `alwaysOnEnabled`, a monthly usage strip (`talkTurns` / `agentMessages` /
`dictationUtterances`), and `<Tour>` — a static four-item explainer.

## 12. `ChatsTab`: history and typed turns

312 lines. Two orthogonal filters:

- **Agent** — chips for `All` plus every non-archived profile. History is filtered **server-side**:
  `getChatHistory(agentFilter ?? undefined)` re-runs on selection change, with `undefined` giving
  the merged feed (lines 58-64).
- **Kind** — `All` / `Talk` / `Dictated` / `Agent runs`, applied client-side (lines 25-30, 157-159).

Opening a chat marks it read: the effect fires `markChatRead` for the selected agent, or for **every**
known profile in the merged All view (lines 70-73) — agents with nothing unread are a harmless
no-op in main. A new entry that arrives while you watch also marks itself read, so the Home unread
dot never lights for a message the user watched arrive (line 87).

The composer targets `selectedAgentId = agentFilter ?? 'main'` and is **locked** while that agent is
mid-run (`thinking | acting | waiting`) or when no Mind key is configured — "a typed message can't
jump the queue" (lines 131-142). The lock reason lives in the row's `title`, not the field: disabled
inputs swallow pointer events, so a tooltip on the field itself would never surface (comment,
lines 263-264). Streaming state (transcript + chunks) is shown as a `live` `ChatPair` with a caret,
and is cleared on `voiceState === 'listening'` so a turn that ended without producing an entry
(transcription empty, LLM errored) doesn't leave orphan scaffolding (lines 98-107). A live turn can
only be attributed to a named agent once its entry lands, so it shows under All or `main` only.

`formatTime` renders `Today · 3:04pm`, `Yesterday · …`, or `Mon 12 · …`.

## 13. `MindTab`, `VoiceTab`, `EarTab`: the provider tabs

### `MindTab` (357 lines)

Provider picker (`Anthropic` vs `ClinePass · OpenAI-compatible`, collapsible into a `.voice-list`),
then a `ProviderKey` row for the active provider, then the model, reasoning depth, and reply tone.

Anthropic's model list is a static `CLAUDE_MODELS` (Sonnet 4.6 tagged *recommended*, Opus 4.6).
OpenAI's is **discovered at runtime**: `listRemoteModels()` hits `GET {base}/v1/models` in main, and
the endpoint-returned ids win over the static picker (lines 105-131). `null` means still fetching,
`[]` means the endpoint returned nothing → fall back to `OPENAI_MODELS` with a visible
"endpoint didn't return a list — showing built-in picks" note. Endpoint ids are cast to `OpenAIModel`,
which the file argues is safe because main forwards the selected id verbatim (`openai/gpt-5`
round-trips fine) — the static union only type-checks the hardcoded entries.

The list is searchable (substring, case-insensitive) and **the current selection always pins to the
top**, even if the endpoint dropped it or the filter excludes it, so the active id never scrolls away
(lines 136-146, 269-283). A custom model id field overrides the picker entirely. `BaseUrlInput` is a
commit-on-blur field — Enter applies, Escape reverts — because typing shouldn't fire a settings write
per keystroke (lines 16-42).

Reasoning depth (`off | medium | deep`) and reply tone (`concise | friendly | detailed`) are
three-button segmented controls writing straight through `setReasoningDepth` / `setReplyTone`.

### `VoiceTab` (187 lines)

Fish Audio vs ElevenLabs as a segment, then a `ProviderKey` row for the chosen one. The two providers
have genuinely different UIs:

- **Fish** takes a free-text `reference_id` (from the voice page URL) plus a model segment. The
  model list leads with `s2.1-pro-free` because that is the tier a $0 dev account can actually call —
  `s2.1-pro` returns 402 "insufficient API credit" there, which reads as a broken key rather than a
  tier (comment, lines 17-22). `FISH_MODEL_LABELS` is `Record`-typed over the union so a new model
  without a label fails the build.
- **ElevenLabs** gets a preview row with a ▶ button (`playVoicePreview`) and a `VOICE_PRESETS` picker
  from `shared/types.ts`.

Speed (0.7-1.2) and stability (0-1) sliders are Fish-hidden — the ElevenLabs-only parameters. The
**Speak replies aloud** toggle is always shown.

### `EarTab` (80 lines)

The smallest provider tab: a Groq `ProviderKey`, an "active" readout of
`{transcriptionProvider} · {model}`, a two-entry model list (`whisper-large-v3`,
`whisper-large-v3-turbo` tagged *default*), and one warning: ClinePass-style endpoints have no
`/audio/transcriptions`, so an OpenAI dictation provider pointed at a custom base URL will `411` on
every utterance — surfaced before users file a bug (lines 53-60).

## 14. `GeneralTab`: shortcuts, modes, memory, companion

416 lines and five sections.

**Shortcut.** Shows the PTT accelerator as `<kbd>` chips with an inline `edit` affordance that swaps
in `<ShortcutCapture>`. `normalizeShortcut` (lines 22-34) folds spelling variants so two different
chords compare equal: lowercased, trimmed parts, `Control→ctrl`, `Command`/`Cmd`→`meta`, parts
**sorted** — so `Ctrl+Alt+D` and `Alt+Ctrl+D` are the same shortcut. Since two global hotkeys now
share this page, a collision shows a warn line on both. It warns rather than blocks: main owns
registration and may reject the new binding anyway, so the setter still fires (lines 120-129).

Trigger style is a two-tab `role="tablist"` (Hold / Toggle), with **Hold disabled on macOS** —
`globalShortcut` has no key-up event there, so hold-to-talk can't work.

**Modes.** Six rows: always-on listening, dictation mode, the push-to-dictate hotkey, agent mode,
max agent steps, and mute routine announcements. `StepsInput` (lines 52-78) keeps a local draft while
typing because clamping mid-keystroke makes `30` unreachable (typing `3` would pin to 3), then
commits clamped to `[3, 30]` on blur or Enter; Escape reverts. The auto-typing row's description is
deliberately long because it explains the default: off means Zapi copies to the clipboard and you
press paste.

**Setup.** A single "show onboarding again" button.

**Memory.** A token bar (`tokens / budget`, default budget 250 k) with a three-band health label
(`healthy` < 60 %, `getting full` < 85 %, `near cap`), a footer with message count / summarized count
and `formatRelative(lastCompactedAt)`, plus **Compact now** (awaiting `compactContext()` and
reporting its own error) and **Clear memory**. The compaction result is flashed for 4 s.

**Companion.** Show cursor, allow Zapi to type, launch at login, "Run setup again", and the stream
window visibility segment (`off | responses | always`).

## 15. `Onboarding`: the verified ten-step wizard

842 lines — the second-biggest renderer file. The premise is in the header comment (lines 13-19):
each step *verifies the thing it configures*, so a user who reaches "Done" has a working Zapi rather
than a filled-in form.

Steps: `welcome`, `permissions`, `mind`, `ear`, `voice`, `modes`, `shortcut`, `mic`, `try`, `done`.
The `permissions` step is filtered out on Linux, which has no queryable OS-level mic/screen gate
(line 56). A left rail shows ✓ / number / title per step with a Skip-setup escape hatch.

Shared building blocks: `Keys` (splits an accelerator into `<kbd>` chips with `+` separators),
`Footer` (Back / hint / secondary / Continue, with a `nextDisabled` gate), `Status` (ok / warn / err /
wait, the wait variant spinning), and `SavedKey` — a key already in the store, **re-validated live on
mount** via `validateStoredApiKey`, so a key saved last month that has since been revoked is caught
here rather than on the first real question (lines 169-201).

Notable steps:

- **Permissions** polls `getPermissions()` every 1,500 ms while you're on it — the user is flipping
  toggles in an OS settings window and the row should go green the moment it takes without them
  clicking anything here (lines 244-253). Windows gets the exact
  "Settings → Privacy & security → Microphone" path and a `microphoneStatus` of
  `denied`/`restricted` renders as an error rather than a warning.
- **Mind / Ear / Voice** each show a provider choice (Mind), a `KeyEntry`, and a link out to the
  provider's console via `openExternal`. Voice is genuinely optional: it offers **Skip — text only**,
  which calls `setSpeakReplies(false)` and advances.
- **Shortcut** is the interesting one. While mounted it calls `startPttTest()` / `stopPttTest()`, so
  the accelerator *reports itself* instead of opening the mic and the user can mash it freely.
  `onPttShortcutFired` lights the card and Continue is disabled until it actually fires. Binding
  failure is inferred: `onSave` stores the wanted accelerator in `pendingRef` and sets a 600 ms
  timer; if settings haven't echoed the change back by then, main's `register` call failed (usually
  another app owns it) and a "Couldn't bind X — another app probably owns it" error appears
  (lines 625-650).
- **Mic check** starts `startMicTest()`, listens to `onMicLevel` and `onMicError`, and drives a
  24-bar meter. The level is smoothed with a per-frame `* 0.85` decay on `requestAnimationFrame` so
  the meter doesn't stutter between the ~20 Hz reports. `heard` latches at level > 0.2 (≈RMS 0.05 —
  clearly above room noise); a peak above zero without `heard` renders the "very quiet — move
  closer or raise your input volume" hint. On Windows a mic error adds buttons to open the
  microphone settings and to retry.
- **Try it** runs a real end-to-end turn: `onTranscriptUpdate` + `onAiResponseChunk` +
  `onAiResponseComplete` + `onAiError` render live, Continue is disabled until `completed`, and the
  verb adapts to `pttMode` (Tap vs Hold).
- **Done** summarises Mind / Ear / Voice / Shortcut with the actual resolved values and finishes with
  `completeOnboarding()`.

## 16. Modal and small panel components

| Component | Lines | What it does |
|---|---|---|
| `NewAgentModal` | 88 | Name (required, autofocus, Enter submits) + optional kaomoji (six `KAOMOJI_PRESETS` or free text — **free text wins when both are set**) + a `COLOR_PRESETS` swatch row. Calls `createAgent({ name, kaomoji, color })` — no id, so main mints the slug. |
| `RoutineModal` | 128 | Name, owning agent (chip row seeded with `agents[0].id ?? 'main'`), schedule as a `interval`/`daily` segment, task textarea, enabled checkbox. Validation: name and task non-empty, plus `Number.isFinite(mins) && mins >= 1` for intervals or `TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/` for daily. Upserts with **no id** so main creates a fresh routine. |
| `ProviderKey` | 71 | Provider pill (optionally hidden by the caller) + API key row with three states: unset ("not configured" + **+ Add key** + a *Needed* pill), set (a masked `••••` line + Replace / Remove + a *Connected* pill), and editing (`<KeyEntry>`). |
| `KeyEntry` | 102 | Password field + **Test & save**. `validateApiKey` round-trips the key against the provider before persisting, so a mistyped key is caught here instead of surfacing as a silent failure on the first push-to-talk. On failure it shows the error plus a **Save anyway** escape (offline, proxy). Enter tests, Escape cancels. Phase is a discriminated union `idle | testing | failed`. |
| `ShortcutCapture` | 100 | Live key-combo recorder. Suspends the global shortcut on mount (`suspendPushToTalkShortcut`) and resumes on unmount, otherwise the registered accelerator swallows the keys being captured. `normalizeKey` prefers `event.code` over `event.key` for letters/digits — with Shift held, `key` becomes the shifted glyph (`!` for 1) which Electron's accelerator parser rejects, so the shortcut silently failed to save on non-US layouts. Save requires at least one modifier. |
| `Slider` | 44 | Custom pointer-drag slider — no `<input type=range>`. `onMouseDown` picks from `getBoundingClientRect`, then window-level `mousemove`/`mouseup` keep tracking; values snap to `step` and are `toFixed(4)` before hitting `onChange`. |
| `Tour` | 69 | Static four-item "How zapi works" explainer on Home: hold-and-ask, screen awareness, the blue cursor, everything stays local (with a link into Chats). Reads the shortcut from props so a rebound hotkey updates the copy. |
| `Hero` | 58 | **Not imported anywhere.** An earlier top-of-panel hero (logo + state chip + waveform + hardcoded `Ctrl Alt X` hint) superseded by `HomeTab`'s own hero block. Left in the tree; dead code. |

## 17. The stream window

`StreamApp.tsx` (888 lines) is a transparent, frameless, **focusable** window — focusable is the
whole point, because it's the one surface where the user can actually click (scroll, select, copy,
hit the stop button) while the overlay is click-through. Size/position/drag are main's problem
(`windows.ts:312-351`); `StreamApp` says so explicitly and only draws what's inside.

Structure, top to bottom: head (title + `statusLabel`, copy transcript / copy md / clear), suggestion
strip, agent status bar with the stop switch, transient error line, dictation chip, agent action feed,
then the scrollable body (scene card + turns).

**Turn assembly** is the subtlest part (lines 276-359). A final transcript seeds a turn with the user
text and an empty AI body; chunks append to the turn held in `currentIdRef`; `onAiResponseComplete`
swaps in the full text and clears the flag. But `CHAT_ENTRY_ADDED` is the **only** event carrying
`artifactIds`/`agentId`, so it must be attached to the turn it sealed:

1. Entries already known are skipped.
2. Scan backwards for a turn with no `entryId` whose `user` matches `entry.userText` verbatim — that
   holds for talk/dictation turns.
3. Voice-triggered **agent** runs store the parsed task instead, so text can't match; those fall back
   to the still-open streaming turn (the run's summary chunks haven't started, so `ai` is still
   empty).
4. An entry with no seeded turn at all (typed or routine turns never emit a transcript, so their
   chunks were dropped for want of an open turn) becomes a complete row of its own.

**Scroll pinning** uses an 80 px threshold tracked on `scroll` events rather than measured after
render — a single chunk taller than 80 px would otherwise push a still-pinned user past the threshold
and stall the follow for the rest of the turn (lines 562-576). Snapping is deferred to
`requestAnimationFrame` so a long token stream doesn't force synchronous layout on every chunk.

**Scene cue rail** (lines 841-886): the `SceneCard` lists every cue with cue order == beat order —
index < `activeCue` is `done` (dim + strike, ✓ for points), `=== activeCue` is highlighted, `>` stays
faint. `point` cues get a numbered badge; every other kind gets a `CUE_GLYPH` (↗ ◯ ▢ ▨ 〜 ✎ ✕) because
it's a stroke the overlay is drawing, not a step.

**Agent status bar + stop** (lines 788-805): `primaryStatus` is the most recent non-idle agent;
`otherAgentCount` renders as `+N more agent(s)`. The stop button calls
`window.flicky.agentStop(primaryStatus.agentId)`. This bar is why the stream window is focusable —
the overlay can't host a clickable button.

**Action feed**: `FEED_MAX = 12` rows, opened by a `thinking`/`acting` phase (which also resets it),
given a verdict row on `done`/`failed` ("done in N steps", or "failed — <message>"), and collapsed
`FEED_COLLAPSE_MS = 3000` after the run returns to idle. Echoes are only accepted while
`agentRunningRef` is true, so a stray echo after the loop stops can't reopen a collapsed feed.
`AgentAction` carries no `agentId`, so each row is attributed to whoever was acting when it landed.

**Artifacts** are resolved through a `getArtifacts()` map loaded once, then refetched whenever a turn
references an id the map doesn't have — artifacts land right around their turn's entry, so the first
pile render can race the store write (lines 497-536). Unresolved ids render nothing.

**Suggestions** load once on mount and only refresh on their own ↻, because the preload surface has
no `suggestions-changed` push event (lines 538-553). `refreshSuggestions` calls
`refreshSuggestions()` then re-reads **twice** — immediately for a synchronous rebuild and once after
900 ms for an async generation pass.

**Clipboard** (`writeClipboard`, lines 609-626) tries `navigator.clipboard.writeText` and falls back
to a hidden textarea + `document.execCommand('copy')`, because the async Clipboard API can be denied
on a frameless window in some contexts. Either way the clicked button flashes `copied` for 1.5 s so
the user knows the click landed. **Copy md** reformats as a markdown list with `HH:MM` timestamps.

**`clearStream`** wipes every piece of renderer-side state — turns, scene, actions, statuses, error,
type note — cancels all pending notice timers, and re-pins the scroll. It is explicitly a *display*
reset, not a stop: the preload exposes no `clearStream` IPC, chat history on disk is untouched, and a
live agent run keeps running (comment, lines 690-696).

## 18. Styles, fonts, and assets

Six stylesheets, imported per entry rather than globally:

| File | Lines | Used by | Contents |
|---|---|---|---|
| `design-system.css` | 73 | all three | Tokens (`--bg-*`, `--accent` Tailwind Blue, `--success/warning/destructive`, spacing, radii, `--cursor-blue`) plus the reset and base `body`. Comment: ported from `DesignSystem.swift`. |
| `waveform.css` | 54 | overlay + panel | The shared `<Waveform>`, keyed off `--wf-height`, `--wf-bars`, `--wf-idx` custom properties. |
| `overlay.css` | 951 | overlay | `@font-face` for Caveat; `.overlay-container` (`position: fixed; inset: 0; pointer-events: none; overflow: hidden` — the click-through root); cursor triangle; pointing bubble; target halo; type toast; the whole ink block (`.ink-layer`, `.ink-stroke`, `.ink-under`, `.ink-draw`, `.ink-echo`, `.ink-retiring`, `.ink-hilite`, `.ink-write`, `.ink-write-reveal`, `.ink-land`); agent echoes, pill, corner chips; VAD indicators; buddy face; and a reduced-motion block. |
| `panel.css` | 1,885 | panel | The largest stylesheet. `--fl-*` macOS-dark-Finder tokens (translucent surfaces so Win11 acrylic shows through) plus `--fl-glass-*` tier A/B material tokens. The one `@import` in the renderer pulls Geist + Geist Mono from Google Fonts (line 3) — the overlay deliberately does *not*, so it never depends on the network mid-presentation. |
| `onboarding.css` | 182 | panel | Key-entry error strip, `.link`, and the `.ob-*` wizard surface. |
| `stream.css` | 558 | stream | `.stream-root` glass card (`backdrop-filter: blur(32px) saturate(140%)`, 14 px radius, deep shadow). `.stream-head` carries `-webkit-app-region: drag` (frameless window drag) with `.btn` children marked `no-drag`. |

`src/renderer/fonts/Caveat-SemiBold.woff2` (51 KB) is the bundled handwriting face for `write` ink
cues, loaded from `overlay.css:6-12` with `font-display: swap` and an OS fallback stack
(`'Segoe Print', 'Comic Sans MS', cursive`).

`src/renderer/assets/sfx/` holds four WAVs synthesized by `scripts/gen-sfx.mts`:
`agent-launch.wav` (62 KB), `agent-done.wav` (75 KB), `agent-needs-you.wav` (53 KB), `heard.wav`
(27 KB). `OverlayApp` resolves them with `new URL(..., import.meta.url).href` so Vite emits them as
bundled assets the packaged app can find — the same convention as the worklet (lines 27-32).

## 19. Component inventory

| Component | File | Lines | Responsibility |
|---|---|---|---|
| `OverlayApp` | `components/OverlayApp.tsx` | 1,593 | Overlay root: companion cursor, kaomoji buddy, waveform, spinner, pointing bubble, VAD + idle indicators, agent echoes/pill/chips, type toast; owns the audio graph, the VAD, TTS playback, OS voice, and SFX |
| `StreamApp` | `components/StreamApp.tsx` | 888 | Stream root: live Q/A turns, scene cue rail, agent status bar + stop, action feed, artifact piles, suggestion strip, copy/clear |
| `PanelApp` | `components/PanelApp.tsx` | 186 | Panel shell: traffic lights, brand, six-item nav with warn dots, permission/encryption/error banners, tab routing, onboarding gate |
| `Onboarding` (+ 9 step components, `Keys`, `Footer`, `Status`, `SavedKey`) | `components/panel/Onboarding.tsx` | 842 | Ten-step first-run wizard that verifies each step (permissions, keys, shortcut fire, mic level, a real turn) |
| `HomeTab` (+ `AgentCard`, `RoutineRow`, `SuggestionCard`, `routineScheduleLabel`, `truncate`) | `components/panel/HomeTab.tsx` | 741 | Multi-agent dashboard: agent cards with status/unread dot/artifact pile, routines block, suggestions block, hero, stat cards, providers summary |
| `InkLayer` (+ `usePrefersReducedMotion`) | `components/InkLayer.tsx` | 275 | SVG scene renderer: cumulative reveal, `clear` reset, per-display culling, stroke budget with fade-out retirement, three-pass ink, reduced-motion gate |
| `inkMath` (module) | `components/inkMath.ts` | 245 | Pure geometry: culling bboxes (straddle-safe), stroke budget slicing, Catmull-Rom smoothing, arrow heads/barbs, write wrapping, deterministic wobble |
| `ChatsTab` (+ `ChatPair`, `formatTime`) | `components/panel/ChatsTab.tsx` | 312 | Chat history with per-agent (server-side) and per-kind (client-side) filters, mark-read, live streaming pair, locked composer |
| `GeneralTab` (+ `StepsInput`, `normalizeShortcut`, `formatRelative`, `formatTokens`) | `components/panel/GeneralTab.tsx` | 416 | Shortcuts + trigger style, six mode toggles, onboarding replay, memory bar with compact/clear, companion toggles, stream visibility |
| `MindTab` (+ `BaseUrlInput`, model tables) | `components/panel/MindTab.tsx` | 357 | Provider switch, key, base URL, endpoint-discovered model picker with search, custom model id, reasoning depth, reply tone |
| `VoiceTab` | `components/panel/VoiceTab.tsx` | 187 | TTS provider switch + key, Fish reference_id/model vs ElevenLabs preview/picker, speed + stability sliders, speak-replies toggle |
| `EarTab` | `components/panel/EarTab.tsx` | 80 | Groq key, active transcription readout, Whisper model picker, custom-endpoint warning |
| `RoutineModal` | `components/panel/RoutineModal.tsx` | 128 | Create-a-routine dialog: name, agent, interval/daily schedule, task, enabled |
| `ShortcutCapture` (+ `normalizeKey`) | `components/panel/ShortcutCapture.tsx` | 100 | Live accelerator recorder; suspends the global shortcut; `event.code`-first key normalization |
| `KeyEntry` | `components/panel/KeyEntry.tsx` | 102 | Password field with validate-before-save and a force-save escape |
| `NewAgentModal` | `components/panel/NewAgentModal.tsx` | 88 | Create-an-agent dialog: name, kaomoji (preset or free), colour swatch |
| `ProviderKey` | `components/panel/ProviderKey.tsx` | 71 | Provider pill + key row in unset/set/editing states |
| `Tour` | `components/panel/Tour.tsx` | 69 | Static four-item "How zapi works" explainer |
| `PermissionsBanner` | `components/panel/PermissionsBanner.tsx` | 90 | Platform-gated missing-permission banner with request buttons |
| `Slider` | `components/panel/Slider.tsx` | 44 | Custom pointer-drag slider with step snapping |
| `Hero` | `components/panel/Hero.tsx` | 58 | Superseded panel hero — **unreferenced dead code** |
| `icons` (`Icon`) | `components/icons.tsx` | 135 | Seven hand-drawn 24×24 line icons (home, sliders, ear, mic, waveform, chat, sparkle), `currentColor`, `aria-hidden` by default |
| `CursorIcon` | `components/CursorIcon.tsx` | 52 | The companion cursor as a standalone SVG with a per-instance `useId` gradient |
| `Waveform` | `components/Waveform.tsx` | 35 | Shared CSS-animated bar waveform keyed off voice state |
| `audio-capture-worklet.js` | `audio-capture-worklet.js` | 40 | `AudioWorkletProcessor` → PCM16 mono 16 kHz, transferred (not copied) to the renderer |
| `overlay.tsx` / `panel.tsx` / `stream.tsx` | (entry shims) | 11 / 12 / 10 | `createRoot` + CSS bundle imports for each window |
| `overlay.html` / `panel.html` / `stream.html` | (entry pages) | 15 / 12 / 15 | `#root` + module script; overlay and stream force a transparent body |
| `types.d.ts` | `types.d.ts` | 6 | Global `Window.flicky: FlickyAPI` |
| CSS / assets | `styles/*.css`, `fonts/`, `assets/sfx/` | — | See §18 |

## 20. Cross-cutting invariants worth preserving

1. **The renderer never computes state main owns.** No local optimistics on settings; every write
   is a `send` and the UI re-renders from the `SETTINGS_CHANGED` push.
2. **One overlay speaks at a time.** Mic capture is single-targeted by main, and the renderer
   defends the same rule for SFX, OS voice, and the type toast via `cursorOnDisplayRef`.
3. **Overlay windows are never hidden** — they are the ink canvas. Only the cursor chrome hides.
4. **Culling must over-approximate, never under-approximate.** `cueBox` pads generously on purpose;
   a straddling cue renders on both overlays and each window clips its own half.
5. **Async callbacks gate on the current turn/agent.** Late `idle` statuses with a lower `step` are
   dropped rather than blanking a live pill; scene refs are pinned synchronously because the
   matching `SCENE_CUE` can arrive before React commits.
6. **Unsubscribes are symmetric.** Every `on*` subscription returns a closure and every effect's
   cleanup calls it, plus cancels its timers, disconnects rAF, silences TTS, and releases the mic.
7. **Transcription is whole-utterance.** There is no partial-transcript channel; the renderer never
   shows live captions because the channel doesn't exist.

## 21. Known gaps

- **Ollama / local-connection management is not wired into any tab.** The preload exposes
  `getLocalConnections`, `addLocalConnection`, `updateLocalConnection`, `deleteLocalConnection`,
  `testLocalConnection`, `getOllamaModels`, `pullOllamaModel`, `deleteOllamaModel`,
  `createOllamaModel`, `setLocalConnectionKey`, `deleteLocalConnectionKey`, and three
  `onOllamaPull*` events (`preload/index.ts:241-278`). `panel.css` still carries the matching
  `.manage-modal`, `.modal-section`, `.modal-section-toggle`, and `.conn-*` rules
  (`panel.css:1035-1074`). But **no component in `src/renderer` references any of them** — a
  repo-wide search for `getLocalConnections` finds exactly one hit, in the preload. The AGENTS.md
  layout note lists "Ollama management" as a panel feature; as the tree stands, the UI for it does
  not exist and only the API surface and CSS remain. I could not determine whether this is a
  deliberate removal or an unwired feature.
- **`Hero.tsx` is dead code** — exported, styled by nothing that imports it, superseded by
  `HomeTab`'s own hero block.
- **`setStreamWindowBounds` is on the preload but never called from the renderer** — stream window
  persistence is entirely main-side (the header's `-webkit-app-region: drag` handles moving it).
- **`stream.css` line 20 sets `user-select: none`** on the root with `user-select: text` restored
  for the copyable regions; worth knowing if text selection in the transcript ever misbehaves.
- `panel.css` depends on a **runtime network fetch** for Geist/Geist Mono (`@import` from Google
  Fonts), which will silently fall back to the system stack offline. The overlay's Caveat face is
  bundled specifically to avoid that failure mode; the panel has not been given the same treatment.