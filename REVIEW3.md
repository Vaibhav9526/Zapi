# REVIEW3 — preload ↔ IPC contract, typings, security surface

Report-only. **Nothing was changed** by this pass — see
[Resolution](#resolution) at the end for the follow-up fixes that landed
against items #1 and #2 (both renderer-side).

Scope read end-to-end: `src/preload/index.ts`, `src/renderer/types.d.ts`,
`src/shared/types.ts` (IPC block), plus the main/renderer counterparts needed
to verify each claim (`src/main/index.ts`, `src/main/windows.ts`,
`src/main/companion-manager.ts`, `src/main/services/agent-driver.ts`,
`src/main/services/usage-store.ts`, and the three renderer entry components).

Taxonomy used below:
- **[CRITICAL]** — guaranteed, user-visible defect or a real contract hole.
- **[MINOR]** — latent risk, dead contract surface, or hardening gap.
- **[NOTE]** — verified-correct, or an informational trap for future edits.

---

## [CRITICAL] (1)

### 1. Non-pointer agent actions echo a click ripple at the display origin
- `src/main/services/agent-driver.ts:186` — `onAction` always fires with
  `x: action.x ?? 0, y: action.y ?? 0`. Only pointer actions carry coords, so
  `type`, `key`, and `scroll` report `(0, 0)`.
- `src/renderer/components/OverlayApp.tsx:814` skips the ripple for exactly
  three kinds — `wait`, `done`, `fail` — with the comment "carry no pointer
  meaning". `type` / `key` / `scroll` fall through that guard, so every typed
  character, every keypress, and every scroll notch draws a click ripple in
  the top-left corner of the display.
- `src/main/index.ts:250-264` — the echo is routed by
  `findOverlayContainingPoint({ x: a.x, y: a.y })`, so the bogus `(0, 0)` also
  decides *which* display shows it: always the one whose bounds contain the
  origin, not the display the action happened on.
- Cosmetic only (the driver still executes the action correctly), but
  guaranteed on every non-pointer action in agent mode. Two-line fix
  candidates: extend the `OverlayApp.tsx:814` skip list, or omit `x`/`y` for
  coord-less actions and have the renderer bail when they are absent.

---

## [MINOR] (6)

### 2. `onAgentAction` payload type drifts from what the driver actually sends
The declared shape (`{ x, y, label, kind }`) matches the driver exactly
(`agent-driver.ts:31-36` and `:186-191`, mirrored in
`companion-manager.ts:79` and `preload/index.ts:260`), but the renderer casts
for extras that are never sent:
- `src/renderer/components/OverlayApp.tsx:817` —
  `a as typeof a & { x2?, y2?, direction? }`, commented "Main may attach
  drag/scroll extras beyond the typed shape". Main never does.
- Consequence: the drag echo has no endpoint (`full.x2` is always `undefined`,
  so a drag renders as a bare dot plus an `→ x,y` caption), and scroll
  direction survives only through the label regex at
  `OverlayApp.tsx:828` (which does work — `describe()` emits
  `scroll up 3`, `agent-driver.ts:150`).
- The cast is a drift-hider, not a fix. Either widen the type (add optional
  `x2`/`y2`/`direction` in `agent-driver.ts` + `preload/index.ts` and actually
  populate them) or delete the extras from the renderer.

### 3. `shell.openExternal` accepts any protocol
- `src/main/index.ts:591` — `ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url) => shell.openExternal(url))`
  with no scheme allowlist.
- Every current call site is safe: hardcoded `https://` literals
  (`Onboarding.tsx:405,452,505,535`) or an `https://ollama.com/library/${slug}`
  template (`OllamaManageModal.tsx:213,283`), where the scheme is fixed by
  the prefix.
- Latent risk only: any future renderer-side caller — or an XSS in the panel
  that inherits the bridge — gets an arbitrary-protocol launcher. On Windows
  that includes `file://` and `smb://` (NTLM credential relay to a remote
  host). Recommend validating `new URL(url).protocol` against
  `http:`/`https:`/`mailto:` in the main handler.

### 4. No Content-Security-Policy on any renderer window
- `vite.config.ts:11-13` sets `html.cspNonce: undefined`; none of
  `panel.html` / `overlay.html` / `stream.html` carries a CSP meta tag, and
  no CSP response header is set in `windows.ts`.
- `contextIsolation: true` + `nodeIntegration: false` cap the blast radius,
  but an XSS in the panel would still hold the entire `window.flicky` surface:
  key writes (`setApiKey` / `deleteApiKey`), all settings, `quit`, and
  `openExternal`. Defense-in-depth gap, not a live vulnerability.

### 5. No `setWindowOpenHandler` / `will-navigate` guards
- `src/main/windows.ts` sets neither for any of the three window factories.
- Latent: nothing in the renderer uses `target="_blank"` or `window.open`
  today (verified by grep), so the default popup behavior is unreachable
  currently. Worth adding alongside the CSP in #4.

### 6. Three IPC channels are declared and referenced by nobody
Grep for each key and its wire string across all of `src/` returns only the
declaration in `src/shared/types.ts`:
- `PUSH_TO_TALK_START` (`:489`) and `PUSH_TO_TALK_STOP` (`:490`) — superseded
  by the `AUDIO_IPC` start/stop-capture pair; the PTT flow never uses them.
- `CLEAR_STREAM` (`:521`) — the stream window clears via `SCENE(null)` and
  voice-state transitions instead.
Dead in both directions: no sender, no handler, no listener. Safe to delete
from the const (or wire up deliberately).

### 7. `play-audio` is the one channel outside the shared contract
- `src/preload/index.ts:358-359` registers `'play-audio'` as a raw string and
  `src/main/index.ts:286` emits the same raw string.
- It works end-to-end (verified by `scripts/preload-check.mts`, which flags it
  as a contract bypass rather than a bug), but it is the single channel that
  escapes the `IPC` const — the renames/grep-checks that protect every other
  channel don't cover it. It belongs in the `IPC` block (or at minimum in
  `AUDIO_IPC` alongside its siblings).

---

## [NOTE] (7)

### 8. `window.flicky` cannot drift from the preload
`src/renderer/types.d.ts:1-6` is `FlickyAPI = typeof api` imported from
`../preload/index`. A method missing from the declaration is therefore not
expressible — it would be a typecheck failure, not a silent hole. Confirmed:
no `@ts-expect-error` or `@ts-ignore` anywhere in `src/`; the only two
`as unknown as` casts are nut-js key lookups in `agent-driver.ts:128,131`,
unrelated to IPC. No workaround shims to clean up.

### 9. All 25 listener subscriptions unsubscribe correctly
Mechanically verified: 25 `ipcRenderer.on(...)` registrations and 25
`ipcRenderer.removeListener(...)` calls, same channel expression and the same
`handler` reference in every pair, so the returned closure removes exactly
what it added. Every renderer consumer stores and invokes the returned
function (`OverlayApp.tsx:579-581,857-859`, `StreamApp.tsx:256-265`,
`PanelApp.tsx:43`, `OllamaManageModal.tsx:85`, `HomeTab.tsx:33,47`,
`ChatsTab.tsx:70`, `Onboarding.tsx:633,746-747,829`,
`PermissionsBanner.tsx:53`). No leaks found.

### 10. `CURSOR_POSITION` post-fix is consistent across all three hops
`src/main/index.ts:716,725` emit `{ x: -9999, y: -9999, off: true }` pulses to
the overlay that just lost the cursor (and the same pulse when the companion
cursor is toggled off); `:728` sends the bare `screen.getCursorScreenPoint()`
`{ x, y }` to the current owner at 30 fps. `preload/index.ts:281` types
`{ x: number; y: number; off?: boolean }`, and `OverlayApp.tsx:710` returns
on `pos.off` *before* reading the sentinel coordinates. No drift, and the
optional-flag decision means consumers need no cast.

### 11. `SCENE_CUE` is 0-based and null-terminated — don't conflate with `step`
`companion-manager.ts:777` emits the `forEach` index, `:787` (and the
cancellation paths at `:675,821,881`) emit `null` to end the beat stream;
`preload/index.ts:243` types `(index: number | null)`. Both consumers treat it
correctly as an array index: `OverlayApp.tsx:779` indexes `sceneCuesRef`, and
`StreamApp.tsx:493` renders `cue ${activeCue + 1} of ${n}` with
`i < activeCue`/`i === activeCue` progress logic at `:502-506`. Worth
remembering: point cues also carry a **1-based** `step`/`total`
(`element-detector.ts` scene numbering), so the two numbering schemes differ
in the same payload.

### 12. `UsageStats` has no drift
`getUsageStats` (`preload/index.ts:156`) → `ipcMain.handle(GET_USAGE_STATS)`
(`index.ts:613`) → `usageStore.getStats()`, which returns the shared
`UsageStats` shape verbatim. `HomeTab.tsx:43` guards with `s ?? null` and
swallows rejections, so a missing handler degrades to "no usage strip" rather
than an unhandled rejection. Covered end-to-end by
`scripts/store-smoke.mts` (month rollover) and `scripts/shape-check.mts`
(serialize roundtrip).

### 13. Security posture is sound on the axes that matter
- `contextIsolation: true` and `nodeIntegration: false` in all three
  `webPreferences` blocks (`windows.ts:47-48,102-103,201-202`).
- `sandbox: false` in all three — deliberate and documented at
  `windows.ts:49-53` (blank-screen breakage from the relative preload path).
- The preload imports only `contextBridge` and `ipcRenderer`; no
  `@electron/remote` anywhere in `src/`; the bridge exposes a typed method
  object, never a raw `ipcRenderer` handle. The only non-method value on the
  bridge is `platform: process.platform` (`preload/index.ts:58`), a string
  resolved at runtime specifically so a cross-compiled build can't leak the
  build host's OS into the renderer (`vite.config.ts:38-43`).

### 14. Cross-checks agree with this review
`scripts/preload-check.mts` (280 checks, 0 failures) independently confirms:
every preload channel resolves to an `IPC`/`AUDIO_IPC` value or an allow-listed
raw string; every `IPC.SET_*` key has a live sender; every `ipcMain` handler
resolves and has a matching preload `send`/`invoke` with a compatible handler
method (`invoke`→`handle`, `send`→`on`); and every listener has an emitter in
main. Its single finding is item #7 above.

---

## Summary

**[CRITICAL] 1 · [MINOR] 6 · [NOTE] 7**

The three-way contract (`shared/types.ts` ↔ preload ↔ main handlers) is in
good shape: no dead setters, no orphan handlers, no channel that resolves to
`undefined`, no missing typings, and a complete unsubscribe story. The one
real user-visible defect is the `(0, 0)` agent-echo ripple (#1); the rest are
hardening (CSP, `openExternal` scheme allowlist), contract hygiene (dead
channels, the `play-audio` raw string), and one drift-hiding cast (#2) that
makes a drag echo lossy.

---

## Resolution

**Fixed in the overlay (renderer-only, no contract change).**

### #1 [CRITICAL] — closed
`OverlayApp.tsx` now classifies echo kinds before drawing:

- `SPATIAL_ECHO_KINDS = { move, click, dclick, rclick, drag }` — these get the
  existing on-screen marker (dot / ripple / staggered double ring / dashed
  ring) at the acted point.
- Everything else — `type`, `key`, `scroll`, `wait`, `done`, `fail` — is
  **non-spatial**: no marker at all, just a glyph pulse (`⌨`, the key name,
  scroll chevrons, or the raw label) in one shared stack above the status
  pill. The driver's `0,0` filler is never read as a position.
- Extra hardening: spatial echoes are also rejected when the point falls
  outside this overlay's own bounds, so a stray `0,0` or off-screen action
  can never put a marker on the wrong display either.

Note the display-routing half of the original claim is unchanged and still
main-side: `index.ts:250-264` routes by `findOverlayContainingPoint({x, y})`,
so a coord-less action is still delivered to whichever overlay owns the
origin. It is now simply drawn as a chip rather than as a ripple, so the
routing quirk is invisible. The structural fix — omitting `x`/`y` for
coord-less actions in `agent-driver.ts` — remains open as a main-side
follow-up.

### #2 [MINOR] — closed
Deleted the `a as typeof a & { x2?, y2?, direction? }` cast and the dead
handling behind it:

- No `x2`/`y2` on the echo type, and no drag-endpoint branch. Main sends
  `{ x, y, label, kind }` only, so a drag correctly echoes as a marker at its
  grab point. The unused `.agent-echo-drag` / `@keyframes drag-march` CSS was
  deleted with it (it carried an `infinite` animation for markup that could
  never render).
- `direction` is likewise gone from the echo type. Scroll chevrons still work:
  the direction is recovered from the label inside the render helper, where
  `describe()`'s `scroll up 3` is already the source of truth.

### #3 [MINOR] — still open (main-side)
`shell.openExternal` scheme allowlist. Every current call site is safe
(hardcoded `https://` literals and a fixed-scheme ollama.com template), so
this remains a latent hardening gap rather than a live vulnerability. Unowned
by the overlay pass.

### #4–#7 [MINOR] — still open (main-side / other files)
No CSP on renderer windows (#4), no `setWindowOpenHandler` / `will-navigate`
guards (#5), three dead IPC channels (#6), and `play-audio` bypassing the
`IPC` const (#7). None are overlay-renderer concerns.

### Re-verified after the fix
- `bunx tsc -p tsconfig.renderer.json --noEmit` — clean.
- `bunx eslint` on the two overlay components — no errors, no warnings.
- Echo count cap and the per-echo 1.4s removal timer are unchanged, so the
  stack is still bounded at 8 concurrent glyphs.
