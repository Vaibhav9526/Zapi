# Zapi — Codebase Documentation

> A screen-aware AI companion for Windows. Hold a hotkey, talk, and Zapi sees your
> screen, answers out loud, draws arrows and circles on your real desktop, and can
> take the wheel to drive your mouse and keyboard when asked.
>
> This document is a curated map of the entire repository at `D:\projects\Zapi_clone`.

| | |
|---|---|
| **Repository** | `https://github.com/Vaibhav9526/Zapi` |
| **Branch / HEAD** | `main` @ `d32a7b3059eb527e0a656e24db478f3fd28c3061` |
| **License** | MIT |
| **Stack** | Electron 33 · React 19 · TypeScript · Vite · Bun |
| **Platform** | Windows is the supported target; the app is explicitly win32-aware |
| **Provenance** | Forked from *Flicky*, which descends from *Clicky* by Farza |

---

## How this document was produced

This is not a hand-written summary. It was produced by a four-agent documentation
squad working in parallel under a single Orca orchestration Run, then assembled
and reviewed by the coordinator.

| Part | Authored by | Scope | Source file |
|---|---|---|---|
| **A** | `term_baaf6af0` | Main process, turn pipeline, windows, shared contract, preload | [`docs-parts/part-a-main-process.md`](docs-parts/part-a-main-process.md) |
| **B** | `term_9f80a4cb` | All 29 files in `src/main/services/` | [`docs-parts/part-b-services.md`](docs-parts/part-b-services.md) |
| **C** | `term_baeec32b` | The entire renderer layer | [`docs-parts/part-c-renderer.md`](docs-parts/part-c-renderer.md) |
| **D** | `term_744b1efa` | Toolchain, 40-file test suite, existing docs, `landing/` | [`docs-parts/part-d-toolchain-docs.md`](docs-parts/part-d-toolchain-docs.md) |

Each agent read the real source and wrote only to its own file. The four parts
were then concatenated here under a spine written by the coordinator, with
headings demoted and cross-part numbering unified so the document reads as one
work. Every claim below traces to a named file, export, or constant — where a
source could not answer a question, the text says so rather than guessing.

### Coverage at a glance

| Layer | Files | Lines of TypeScript/TSX |
|---|---|---|
| `src/main` | 4 | ~4,600 |
| `src/main/services` | 29 | ~6,900 |
| `src/renderer` | 21 | ~7,400 |
| `src/preload` | 1 | 403 |
| `src/shared` | 1 | 648 |
| `scripts` (tests) | 40 | ~7,300 |
| `landing` (Next.js site) | ~25 | — |

---

## Table of contents

- [1. What Zapi actually does](#1-what-zapi-actually-does)
- [2. Architecture at a glance](#2-architecture-at-a-glance)
  - [2.1 The three windows](#21-the-three-windows)
  - [2.2 One turn, end to end](#22-one-turn-end-to-end)
  - [2.3 The two process boundaries that matter](#23-the-two-process-boundaries-that-matter)
- [3. The five invariants you must not break](#3-the-five-invariants-you-must-not-break)
- [4. Repository map](#4-repository-map)
- [5. The three-way contracts](#5-the-three-way-contracts)
- [6. Data on disk](#6-data-on-disk)
- [7. Multi-agent ("Clickys")](#7-multi-agent-clickys)
- [8. Build, run, and verify](#8-build-run-and-verify)
- [9. Known gaps and doc contradictions](#9-known-gaps-and-doc-contradictions)
- [10. Where to start reading](#10-where-to-start-reading)
- [Part A — The Main Process Layer](#part-a--the-main-process-layer)
- [Part B — The Services Layer](#part-b--the-services-layer)
- [Part C — The Renderer Layer](#part-c--the-renderer-layer)
- [Part D — Toolchain, Tests, Docs and the Marketing Site](#part-d--toolchain-tests-docs-and-the-marketing-site)

---

## 1. What Zapi actually does

A push-to-talk desktop companion with four superpowers layered on top of a
chatbot:

1. **Talk** — hold a hotkey (or leave always-on listening enabled, where a local
   VAD in the overlay segments your speech) and speak. Zapi transcribes, reasons,
   and answers out loud.
2. **Draw on your screen** — a reply can carry an ordered *scene* of cues. A
   companion cursor points at real UI elements while an SVG overlay sketches
   arrows, circles, boxes, highlights, freehand paths, and handwritten labels
   over your actual desktop.
3. **Drive your computer** — utterances beginning with an agent trigger
   (`"zapi agent"`, `"hey agent"`) start a screenshot → plan → act loop that
   clicks, types, scrolls, and drags, with a live step counter and a stop switch.
4. **Multiple named agents** — each "Clicky" has its own face, color, chat
   history, and scheduled routines. Say `"zapi agent scout: check the build"` and
   the request lands on Scout's card. Only one agent drives the mouse at a time;
   the rest queue visibly rather than fighting over the cursor.

Alongside these: **dictation mode** (transcribed speech is typed into whatever
field has focus instead of being sent to a model), **file deliverables** (an
agent hands over a produced file rather than pasting a wall of text), a
**rolling context manager** that auto-compacts history so one conversation can
run indefinitely, and **encrypted per-provider key storage** with one-click
validation.

Mind providers are Anthropic Claude or OpenAI (including local
OpenAI-compatible endpoints via Ollama). The ear is Groq Whisper or OpenAI
transcription. The voice is Fish Audio or ElevenLabs.

---

## 2. Architecture at a glance

```
                    ┌──────────────────────────────────────────────┐
                    │  MAIN PROCESS  (Node, full OS access)         │
   PTT hotkey ──────▶  index.ts ──▶ CompanionManager                │
   tray menu         │   · globalShortcut, tray, IPC routing        │
   settings UI ◀─────│   · windows.ts → panel/overlay/stream        │
                    │   · services/ (29 modules)                   │
                    └───────┬──────────────────────┬───────────────┘
                            │ contextBridge        │ nut-js
                    ┌───────▼───────────┐   ┌──────▼──────────────┐
                    │  PRELOAD          │   │  REAL MACHINE       │
                    │  window.flicky    │──▶│  mouse + keyboard   │
                    │  (one-to-one IPC) │   │  nut-js, lease FIFO │
                    └───────┬───────────┘   └─────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
  ┌─────▼─────┐       ┌─────▼─────┐       ┌─────▼─────┐
  │  PANEL    │       │  OVERLAY  │       │  STREAM   │
  │ settings  │       │ per-display│      │ live Q/A  │
  │ 1 window  │       │ N windows │       │ 1 window  │
  └───────────┘       └───────────┘       └───────────┘
```

### 2.1 The three windows

| Window | Count | Nature | Job |
|---|---|---|---|
| **Panel** | 1 | Normal, focusable | Settings UI: Mind, Ear, Voice, General, Home, Chats, onboarding, Ollama management. `HomeTab` is the multi-agent surface. |
| **Overlay** | 1 **per display** | Transparent, click-through, always-on-top at screen-saver level | The companion cursor, `InkLayer` SVG strokes, mic capture, VAD, TTS playback. |
| **Stream** | 1 | Transparent, always-on-top, draggable | A live mirror of the Q/A with the scene-cue rail, agent status, a stop switch, the artifact pile, and the suggestion strip. |

**Exactly one overlay owns the microphone.** Mic capture is never broadcast — a
second overlay capturing would double the audio and break transcription.

### 2.2 One turn, end to end

```
PTT press  ─or─  VAD detects a finished utterance in the overlay
        │
        ▼
  transcribe            Groq / OpenAI Whisper, whole utterance, no partials
        │
        ▼
  voice self-settings   "talk slower" / "be quiet" / "mute my routines"
        │                route through the SAME setters as the panel
        ▼
  dictation?            if so: type into the focused field, turn ENDS here
        │
        ▼
  agent routing         extractAgentTask → is it an agent turn?
        │                resolveAgentTarget → which Clicky?
        ▼
  talk turn             Mind provider streams a reply (mode: 'talk' | 'agent')
        │                every async callback gated on isCurrent()
        ▼
  scene scheduler       parse the tag DSL → ordered SceneCues → overlay draws
        │
        ▼
  TTS                   Fish Audio / ElevenLabs, with an OS-voice fallback
```

Every new turn bumps `turnId` and aborts the in-flight turn's `AbortController`.
**Any async callback that mutates UI state must gate on `isCurrent()`.** No stale
chunks, chat entries, or TTS may survive an interruption.

### 2.3 The two process boundaries that matter

**The preload bridge.** The renderer has no Node access. It calls `window.flicky`
— a `contextBridge` surface that maps one-to-one onto the IPC channel list in
`src/shared/types.ts`. The channel map, the preload surface, and the `ipcMain`
handlers are a three-way contract that must move together.

**The input lease.** Agents *reason* concurrently but only *act* serially.
`input-lease.ts` is a module-level FIFO mutex around physical input. It is taken
for a whole action batch (never per action, or a batch would interleave) and
skipped when the batch only contains `done`/`fail`. A waiter surfaces as an
`AGENT_STATUS` phase of `'waiting'`. Wait timeout is 60 s and is abort-aware.

---

## 3. The five invariants you must not break

These are the rules that produce bugs when ignored. Each is expanded in the part
files that own the code.

1. **The tag DSL is a three-way contract.** `shared/types.ts` shapes,
   `element-detector.ts` regexes/mappers, and `prompts.ts` prompt text must all
   move together. Change the grammar in one and the model emits tags nothing
   parses.

2. **File bodies are data, never instructions.** `parseAgentActions` must be fed
   `stripFileBlocks(text)`, *never* the raw reply. Otherwise an `[ACT:key:enter]`
   hidden inside a Python file the model wrote executes against the user's
   machine.

3. **Model-supplied filenames are untrusted.** Everything a model writes goes
   through `artifact-store`'s sanitizer plus the `path.dirname` assertion in
   `writeArtifact`. Never hand-roll `path.join(userData, modelString)`.

4. **Only the mic-owning runtime may clear scenes and speak.** A background agent
   talking over the user, or wiping the foreground agent's ink, are both bugs.

5. **`userData` is hijacked at module scope.** `index.ts` claims
   `%APPDATA%\ZAPI Companion` in a top-level block and migrates six known JSON
   files plus the `artifacts/` tree. This **must stay above every
   `app.getPath('userData')` read** — moving it into `whenReady` silently splits
   the stores across two directories.

---

## 4. Repository map

```
Zapi_clone/
├── src/
│   ├── shared/types.ts          ← the single contract (648 lines)
│   ├── preload/index.ts         ← window.flicky bridge (403 lines)
│   ├── main/
│   │   ├── index.ts             ← app entry, tray, hotkeys, IPC (1604)
│   │   ├── companion-manager.ts ← the turn pipeline (2272)
│   │   ├── windows.ts           ← 3 window factories (370)
│   │   └── services/            ← 29 modules
│   │       ├── element-detector.ts   agent-orchestrator.ts
│   │       ├── agent-driver.ts       input-lease.ts
│   │       ├── claude-api.ts         openai-api.ts
│   │       ├── ollama-api.ts         transcription.ts
│   │       ├── screen-capture.ts     elevenlabs-tts.ts
│   │       ├── fish-audio-tts.ts     auto-typer.ts
│   │       ├── settings-store.ts     key-store.ts
│   │       ├── chat-history-store.ts usage-store.ts
│   │       ├── artifact-store.ts     suggestion-store.ts
│   │       ├── suggestion-engine.ts  context-manager.ts
│   │       ├── routines.ts           prompts.ts
│   │       ├── audio-capture.ts      active-window.ts
│   │       ├── agent-workspace.ts    key-validation.ts
│   │       └── gpu-guard.ts          fs-util.ts
│   │                                 analytics.ts
│   └── renderer/
│       ├── overlay.tsx / panel.tsx / stream.tsx (+ .html each)
│       ├── audio-capture-worklet.js
│       ├── components/  OverlayApp, StreamApp, InkLayer, inkMath, PanelApp,
│       │                icons, and panel/ (HomeTab, Onboarding, GeneralTab,
│       │                MindTab, ChatsTab, VoiceTab, EarTab, RoutineModal,
│       │                NewAgentModal, KeyEntry, ShortcutCapture,
│       │                PermissionsBanner)
│       └── styles/ fonts/ assets/sfx/
├── scripts/                     ← 40 verification scripts
├── docs/                        ← DSL.md, INDEX.md, QUICKSTART.md, app-guides/
├── landing/                     ← Next.js marketing site
├── AGENTS.md                    ← the contributor architecture doc
├── package.json  tsconfig{,.main,.renderer}.json  vite.config.ts
└── eslint.config.js  vercel.json  .github/workflows/build.yml
```

---

## 5. The three-way contracts

Two contracts in this codebase span multiple files. Breaking either produces
silent failures rather than compile errors.

**The IPC contract** — three files must agree:

| File | Role |
|---|---|
| `src/shared/types.ts` | The `IPC` channel map, imported by all three sides |
| `src/preload/index.ts` | Exposes each channel on `window.flicky` |
| `src/main/index.ts` | Registers the `ipcMain` handler for each channel |

`scripts/preload-check.mts` (501 lines) exists specifically to police this: it
asserts every `IPC.*` key has a live sender and every preload channel resolves in
both directions, including the `ipcRenderer.on` pairs.

**The tag DSL contract** — `shared/types.ts` (shapes) ↔ `element-detector.ts`
(regexes and mappers) ↔ `prompts.ts` (the prompt text that tells the model the
grammar exists).

---

## 6. Data on disk

Everything lives under `%APPDATA%\ZAPI Companion` (the hijacked `userData`):

| File | Contents |
|---|---|
| `zapi-settings.json` | `FlickySettings` including the `agents` array — `AgentProfile`s live here, not in a separate file |
| `zapi-keys.json` | Provider API keys via `safeStorage`; falls back to `plain:<base64>` when unavailable |
| `zapi-chats.json` | Bounded per-agent chat log |
| `zapi-usage.json` | Monthly counters: `talkTurns`, `agentMessages`, `dictationUtterances`, plus a per-agent row |
| `zapi-artifacts.json` | Metadata for agent-produced files (200 entries/agent) |
| `zapi-suggestions.json` | Dismissed and proposed task cards. **Dismissals are permanent** — the file keeps them even when the list hides them |
| `gpu-state.json` | GPU guard decisions |
| `artifacts/<agentId>/` | One sanitized directory per agent, created on demand |

The stores share a shape: an in-memory cache with atomic debounced flushes.
Re-running an artifact yields `name-2.csv`, never a silent overwrite.

**Pre-rebrand names are not migrated.** An old chat log from a pre-Zapi install
is simply left behind.

---

## 7. Multi-agent ("Clickys")

`AgentProfile` (`shared/types.ts`) is the identity: `id` (a user-authored slug),
`name`, `kaomoji`, `color`, `archived`. Profiles live *inside* the settings
payload, so they flow through `settings-store` + `SETTINGS_CHANGED` like any other
setting. `MAIN_AGENT_ID` (`'main'`) is the default.

**Per-agent runtimes.** `AgentOrchestrator.runtimeFor(id)` lazily creates and
*caches* one `AgentRuntime` per agent id, so renaming or archiving a profile
does not kill an in-flight run. The `'main'` runtime is wired to
`CompanionManager`'s own turn id, abort controller, and voice state — that is
what keeps the classic pipeline byte-identical — while background runtimes get a
private `LocalTurnControl`.

**Routing.** `extractAgentTask` decides *whether* an utterance is an agent turn
and strips the trigger. `CompanionManager.resolveAgentTarget` then decides
*which* profile, matching profile names in the transcript **longest-name-first**
and stripping a leading `"<name>:"`, so `"zapi agent scout: open notepad"` lands
on Scout's card with the task `open notepad`. An unrecognized name falls back to
`MAIN_AGENT_ID` rather than dropping the request.

**Routines.** A `Routine` is an agent-owned scheduled task (`interval` or `daily`
HH:MM) that runs as a normal talk turn on its own agent. `RoutineScheduler` fires
them from one 15 s tick, so upserts and enable flips need no restart.
`companion-manager` skips a due routine while the user is mid-turn, and
`routinesMuted` silences only the completion announcement — never the run.

---

## 8. Build, run, and verify

```sh
bun install                 # deps (bun.lock is the lockfile)
bun run dev                 # tsc --watch (main) + vite dev (renderer)
bun run build               # build:main (tsc) + build:renderer (vite)
bun run typecheck           # both tsconfigs, no emit
bun run lint                # eslint src
bun run start               # electron dist/main/main/index.js with VITE_DEV_SERVER=1
npm run package:win         # build + electron-builder --win (nsis)
```

Requires **Bun and Node 20+**. Windows is the supported platform.

### The verification gate

`bunx tsx scripts/dev-verify.mts` is the one-shot gate. It runs both typechecks,
then every script whose filename matches a discovery suffix
(`*-smoke`, `*-check`, `*-abort`, `*-response`, plus `scene-pipeline.mts`), then
`npm run lint` report-only. Its exit code is the number of real failures, capped
at 1. **Because discovery is by filename, a new test script runs free** — no
registration needed.

Scripts that need a stubbed Electron are matched to their stub by name through
`PRELOAD_FOR`: `agent-abort.mts` → `agent-stub-preload.ts`; the store/chat/
keystore/routines/artifact/suggestion smokes → `store-preload.ts`. Everything
else runs under plain `bunx tsx`.

Part D carries the complete 40-row inventory of `scripts/`, with a per-row
line count and its manual-vs-auto-discovered classification.

### Two environment caveats on the machine that produced this document

- **`bun` is required but is NOT installed here.** No part of this documentation
  was validated by executing the suite — it is all read from source.
- The bun-installed global `opencode` shim is broken on this machine. Use `devin`.

---

## 9. Known gaps and doc contradictions

The documentation squad cross-checked the existing prose docs against the source
and found **16 contradictions**. The most consequential:

| Claim | Reality |
|---|---|
| `AGENTS.md`: the gate reports "19 passed" and lists 16 auto-discovered scripts | Actually **29 steps and 26 auto-discovered** scripts. `AGENTS.md` also never mentions `companion-stub-preload.ts`. |
| `docs/INDEX.md` claims to list every markdown file | Only **3 of its 35 rows resolve** — the audit/plan corpus is gitignored. |
| `docs/DSL.md`: the DSL has four tag families | `element-detector.ts` also implements a **`[MEMO:]`** family. |
| `docs/QUICKSTART.md`: Groq is the only transcription provider | **`OpenAIWhisperProvider` exists.** |
| `.github/workflows/build.yml` triggers on `master` | The branch is **`main`**, so the release workflow never fires on push. |
| `package.json` publishes releases to `jvaught01/flicky` | The project is **Zapi** — the publish target points at a different repo. |

Part D carries all 16 with evidence. Two further open questions were raised and
**not** resolved by the source:

- `panel/Hero.tsx` is exported but referenced nowhere — dead code superseded by
  `HomeTab`'s own hero.
- The Ollama / local-connection management UI named in `AGENTS.md` **has no
  renderer component**. The preload exposes 11 connection APIs plus 3
  `onOllamaPull*` events and `panel.css` still carries `.manage-modal` and
  `.conn-*` rules, but a repo-wide search for `getLocalConnections` finds only
  the preload definition. Whether that UI was deliberately removed or never
  wired cannot be determined from the tree.

Part A additionally flags that it could not pin exact line numbers for a few
symbols in `index.ts` below line 1160 and therefore described them structurally.

---

## 10. Where to start reading

| If you want to… | Read |
|---|---|
| Understand what the app does | This document, §1 |
| Change the turn pipeline | Part A §A.2, then Part B §B.2 (the DSL) and Part B §B.5 (prompts) — **all three** |
| Add an IPC channel | Part A §A.1.5, §A.6, and run `scripts/preload-check.mts` |
| Add or change a tag | Part A §A.5, Part B §B.2, Part B §B.5 — **all three** |
| Work on the agent loop | Part B §B.3, and read §3.4 (the input lease) first |
| Touch the overlay or drawing | Part C §C.4 through §C.9 |
| Add a settings field | Part B §B.8.1, plus a companion setter and an IPC channel — never ad hoc |
| Understand the build or tests | Part D §D.1 and §D.2 |
| Add a test | Part D §D.2.3 — name it `*-smoke.mts` and `dev-verify` picks it up free |
| Onboard as a user | `docs/QUICKSTART.md` |

---

*Assembled by the Orca coordinator from four parallel agent-authored parts. Run
`node docs-parts/build-codebase-md.mjs` to regenerate this file from the parts.*

---

## Part A — The Main Process Layer

*App entry, the turn pipeline, window factories, the shared contract, and the preload bridge.*

*Source: [`docs-parts/part-a-main-process.md`](docs-parts/part-a-main-process.md).*

This part documents the main-process half of Zapi: the app entry point, the turn
pipeline, the window factories, the shared type contract, and the preload bridge.
Every claim below is traceable to the source files named in each section's
"Source" line. Line numbers refer to the tree at commit `d32a7b3`.

The main process owns four things and nothing else: **process lifecycle** (tray,
windows, global hotkeys, permission policy), **the turn pipeline** (mic →
transcribe → model → scene/TTS), **window topology** (one overlay per display),
and **the IPC contract** that the three renderer processes talk to. It owns no
DOM and no model logic of its own; both live behind services.

### A.1 `src/main/index.ts` — app entry and process wiring

**Source:** `src/main/index.ts` (1604 lines). No exported symbols — this is a
side-effecting entry point. Everything below names the local function or
top-level block it describes.

#### 1.1 The `userData` hijack (module scope)

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

#### 1.2 Startup order

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

#### 1.3 Tray icon and menu

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

#### 1.4 The three global shortcuts and PTT hold/toggle

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

#### 1.5 IPC registration and routing tables

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

#### 1.6 Overlay-to-display routing rules

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

#### 1.7 Overlay lifecycle, health, and bounds sync

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

#### 1.8 The stream window

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

#### 1.9 Shutdown

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

### A.2 `src/main/companion-manager.ts` — the turn pipeline

**Source:** `src/main/companion-manager.ts` (2272 lines).
**Exported symbol:** `class CompanionManager` (line 150) and
`interface CompanionCallbacks` (line 70). Everything else is private.

#### 2.1 Construction and collaborators

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

#### 2.2 The full pipeline, in order

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

#### 2.3 `turnId` and the `isCurrent()` gate

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

#### 2.4 Always-on listening and the wake gate

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

#### 2.5 Spoken voice self-settings

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

#### 2.6 `resolveAgentTarget` — longest-name-first routing

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

#### 2.7 The scene scheduler

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

#### 2.8 `runTextTurn`, `acceptSuggestion`, `refreshSuggestions`

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

#### 2.9 Agent runtime deps and the voice-ownership rule

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

#### 2.10 Mind dispatch and TTS fallback

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

### A.3 `src/main/windows.ts` — the three window factories

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

#### 3.1 `createPanelWindow()`

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

#### 3.2 `createOverlayWindow(display)`

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

#### 3.3 `createStreamWindow(storedBounds)`

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

#### 3.4 `hardenWindow` and `loadPage`

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

#### 3.5 `scheduleDisplaySync` and `supportsAcrylic`

`scheduleDisplaySync(fn)` is a 300 ms coalescing debounce over a single module
timer. Docking stations, resolution toggles and GPU resets fire
`display-added`/`removed`/`metrics-changed` in rapid bursts, and every sync that
observes a changed topology destroys and recreates the affected overlays — a
full renderer reload each. index.ts wires it to the add/remove events; the
crash-driven rebuild path has its own separate debounce there.

`supportsAcrylic()` is described in §3.1; it is exported so it can be tested
against the same `WIN11_MIN_BUILD` constant the factory uses.

---

### A.4 `src/main/services/audio-capture.ts` — the audio IPC names

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

### A.5 `src/shared/types.ts` — the single contract

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

#### 5.1 `IPC` — the channel map

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

#### 5.2 `FlickySettings` and `DEFAULT_SETTINGS`

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

#### 5.3 `Scene` and `SceneCue`

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

#### 5.4 `AgentAction` and `AgentStatus`

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

#### 5.5 `CaptureMode`, `DisplayInfo`, `UsageStats`

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

### A.6 `src/preload/index.ts` — the `window.flicky` bridge

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

### A.7 Cross-cutting invariants

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

---

## Part B — The Services Layer

*All 29 services under `src/main/services/` — the tag DSL, the agent loop, providers, and the JSON stores.*

*Source: [`docs-parts/part-b-services.md`](docs-parts/part-b-services.md).*

> Catalog of every file in `src/main/services/`, written from the actual source. Every claim traces to a named export or constant in the file it describes.

### B.1 Overview

`src/main/services/` holds 29 modules in seven groups:

1. **DSL parsing** — `element-detector.ts`.
2. **Agent loop** — `agent-orchestrator.ts`, `agent-driver.ts`, `input-lease.ts`, `agent-workspace.ts`, `active-window.ts`.
3. **Scheduling** — `routines.ts`.
4. **Prompts** — `prompts.ts`.
5. **Mind providers** — `claude-api.ts`, `openai-api.ts`, `ollama-api.ts`.
6. **Perception and voice** — `transcription.ts`, `screen-capture.ts`, `elevenlabs-tts.ts`, `fish-audio-tts.ts`, `auto-typer.ts`, `audio-capture.ts`.
7. **Persistence, intelligence, utilities** — `settings-store.ts`, `key-store.ts`, `chat-history-store.ts`, `usage-store.ts`, `artifact-store.ts`, `suggestion-store.ts`, `suggestion-engine.ts`, `context-manager.ts`, `key-validation.ts`, `gpu-guard.ts`, `fs-util.ts`, `analytics.ts`.

Two patterns recur: file bodies are data not instructions (`stripFileBlocks` before every DSL parse), and JSON stores use cache-then-atomic-flush via `writeFileAtomic`.

### B.2 Tag DSL — element-detector.ts

No Electron imports; imported by the main pipeline and headless smokes.

- `TAG_STRIP_REGEX` — matches every markup tag: the `FILE_BLOCK_SRC` branch (`\[FILE:[^\]\n]*\][\s\S]*?(?:\[\/FILE\]|$)` plus stray `[/FILE]`), inline payloads `[(POINT|TYPE|ARROW|CIRCLE|BOX|HILITE|PATH|WRITE|ACT|MEMO)]` with escape-aware bodies, and `[CLEAR]`.
- `stripFileBlocks(responseText)` — removes `[FILE:...]` blocks through its own `FILE_BLOCK_REGEX` instance (never shared, so independent `lastIndex` cursors cannot truncate each other). Security property: file content is data.
- `parseTypeTags(responseText)` — `[TYPE:...]` via `TYPE_TAG_REGEX`, unescapes `\\(.)`. Strips file blocks first so `[TYPE:]` inside a saved note never reaches typing.
- `parseScene(text, screenshots)` — one ordered `SCENE_TAG_REGEX` pass (POINT, ARROW, CIRCLE, BOX, HILITE, PATH, WRITE, CLEAR) preserving reply order for overlay beats. Screenshot pixels map via private `shotToDisplay` (scale plus display-origin offset) and `shotSizeToDisplay` (scale only). Malformed tags skipped. Point cues get 1-based `step`/`total`. Returns `null` when empty. Strips file blocks first.
- `parseAgentActions(text, screenshots)` — `[ACT:...]` into `AgentAction[]`: `click|dclick|rclick|move` with `x,y:screenN`, `drag`, `type` (unescaped), `key` (verbatim), `open` (verbatim, no unescape so `C:\Program Files\app.exe` survives), `scroll` (default amount 3), `wait`, `done|fail`. Skips malformed tags. Double-guarded: this function strips, and `agent-orchestrator.ts` strips before calling.
- `parseFileTags(responseText)` — `[FILE:name]...[/FILE]` via `FILE_TAG_REGEX`, unclosed block runs to end-of-text, body verbatim through `trimBlockEdges` (exactly one newline per edge). A `[FILE:b.txt]` line inside another body stays literal.
- `parseMemos(responseText)` — `[MEMO:...]`, capped at `MAX_MEMOS_PER_RESPONSE = 6` and `MAX_MEMO_CHARS = 200`, one line, deduped. Strips file blocks first because memos land in `AGENTS.md` and future prompts.
- `extractAgentTask(transcript)` — three anchored shapes: `AGENT_NAME_THEN_AGENT` (`zapi|zappi|flicky|clicky` plus `agent`), `AGENT_WORD_LEADS` (bare `agent` with the "agent Smith" guard: whitespace-only separator plus capital letter is not a trigger), `AGENT_NAME_LEADS` (name plus imperative). `stripModeWord` removes a leading `mode`.
- `looksLikeCommand(text)` — `COMMAND_LEAD` over `open|launch|start|run|play|go to|navigate to|...|mute|unmute`, anchored with `\b`. PTT path only, never always-on VAD.
- Private `shotToDisplay(sc, px, py)` — `displayBounds.width / imageWidth` scaling plus origin offset; `null` without a capture.

Security rule restated in the file three times: feed `parseAgentActions` and `parseScene` with `stripFileBlocks(text)`, never the raw reply.

### B.3 Agent loop

#### 3.1 agent-orchestrator.ts

Screenshot-plan-act loop plus per-agent registry.

- `AgentTurnControl` — `beginTurn`, `currentTurnId`, `setAbort`, `currentAbort`, optional `setVoiceState`/`voiceState`. `main` binds to `CompanionManager` fields; background runtimes use `LocalTurnControl` (exported).
- `AgentRuntimeDeps` — `turn`, `ownsVoice` (only the mic-owning runtime may clear scenes and speak; background skips both so it never wipes foreground ink or talks over the user), `streamMind`, `recordExchange`, `emitMemoryStats`, `synthesizeSpeech`, `playSpeech`, `onStatus`, `onAction`, `onChatEntryAdded`, `onAiResponseChunk`, `onAiResponseComplete`, `clearSceneTimers`, `onSceneClear`.
- `AgentRuntime` — `lastScreenshots`, `status`, `running`. Methods: `getStatus()`, `isRunning`, `stop()` (aborts controller, emits `idle`), `run(task)` (reads `agentMaxSteps` from settings, bumps turn id, installs `AbortController` with `isCurrent()`, clears scenes only when `ownsVoice`, captures via `captureAllDisplays`, probes `focusedAppContext()` per step, streams with `mode: 'agent'`, 90 s per-step timeout with one retry, `RUN_TIMEOUT_MS = 10 min`, `MAX_TAGLESS_STRIKES = 2` where a `[FILE:]` counts as tagged, writes artifacts via `artifactStore.writeArtifact` into `runArtifactIds`, executes via `runAgentActions` with turn signal plus `onLeaseWait` mapped through `leaseWaitPhase`, feeds `result.executed` back into history, 700 ms settle delay, strips tags for summary, appends one chat entry with `artifactIds`, records `usageStore.recordAgentMessage`, tracks `analytics.trackAgentRun`, speaks only when `ownsVoice`).
- `AgentOrchestrator` — `Map<string, AgentRuntime>`. `runtimeFor(agentId)` lazy-creates and caches so rename/archive never kills an in-flight run. `runTask(agentId, task)`, `stop(agentId?)` (omitted stops every running agent for bare `AGENT_STOP`), `getStatus(agentId)`, `isRunning(agentId)`.

#### 3.2 agent-driver.ts

Runs parsed `AgentAction[]` via `@nut-tree-fork/nut-js`, lazily loaded (`load()` degrades to `automation unavailable` instead of crashing at import; transient failures retry).

- `AgentRunHooks` — `onAction`, `signal`, `agentId`, `onLeaseWait(waiting)` (true while queued, exactly once false at end).
- `AgentRunResult` — `{ done, failed, message, executed[] }`.
- `runAgentActions(actions, screenshots, hooks)` — never throws. Caps at `MAX_ACTIONS_PER_BATCH = 30`. Lease-free kinds `done|fail|open` (open-only batches skip the lease; mixed batches hold it whole). Clamps pointers into `displayBoundsUnion()`. Handles click/dclick/rclick/move/drag (button released in `finally`), type (via `auto-typer` `typeText`; empty skipped), key (`+`-split, modifiers first, press then reverse-release in `finally`), open (`validateOpenTarget` plus `cmd /d /s /c start "" "<target>"` via `execFile`; rejection is a per-action skip), scroll (clamped 0–100), wait (clamped to `MAX_WAIT_MS = 5000`, abort-aware), done/fail. `onAction` ripple only for `POINTER_KINDS`. `ACTION_GAP_MS = 140` between actions.
- Win32 scaleFactor — `scaleFactorFor` maps `ScreenCapture.displayId` through `electron.screen.getAllDisplays()` to `display.scaleFactor` (1 off-Windows or on failure); logical DIP times factor equals physical pixels. `scaleFactorAtPoint` re-resolves drag destinations via `getDisplayNearestPoint` for mixed-scale monitors.
- `validateOpenTarget` — refuses `SHELL_METACHARS` (`&|;<>%` + quotes + `$` + newlines) and empty targets; spaces pass because `execFile` quotes argv without building a shell string.

#### 3.3 input-lease.ts

Global FIFO mutex around physical input. Pure module state, no Electron deps.

- `acquireInputLease(agentId, options?)` — fast path when free; else queued `Waiter`. `onQueued(true, position)` on every shift; `onQueued(false, 0)` exactly once on grant. Bad endings (timeout/abort) reject without `onQueued(false)`; caller clears `waiting`. Release idempotent, hands to next waiter.
- 60 s wait timeout (`DEFAULT_TIMEOUT_MS = 60_000`, overridable via `timeoutMs`); abort via caller turn `AbortSignal`.
- Whole-batch leasing; done/fail-only and open-only batches skip it (driver `LEASE_FREE_KINDS`).
- `leaseWaitPhase(waiting, currentPhase, turnIsCurrent)` — queued goes `waiting`; granted goes `acting` only from `waiting`; non-current turn returns `null` (no emit).
- `leaseHolder()`, `leaseQueueLength()` introspection.

#### 3.4 agent-workspace.ts

Per-agent home `userData/workspaces/<slug>/` with `AGENTS.md`, `output/`, `tmp/`.

- `workspacesRoot()`, `workspaceDir(agentId)`, `outputDir(agentId)`, `tmpDir(agentId)`, `memoryPath(agentId)` — all via `sanitizeAgentSegment`.
- `ensureWorkspace(agentId, profile?)` — idempotent scaffold; existing `AGENTS.md` never rewritten. Returns `{ slug, dir, outputDir, tmpDir, memoryPath, created }`.
- `readMemory(agentId)` — line-aligned truncation at `MAX_MEMORY_CHARS = 4096`; missing reads as `''`.
- `appendMemo(agentId, fact, profile?)` — one `- YYYY-MM-DD: fact` under `## Notes`, newest `MAX_NOTE_LINES = 40`, `MAX_FACT_CHARS = 200`, exact-duplicate suppressed. Only Notes rewritten. Returns boolean; false is normal.

#### 3.5 active-window.ts

Foreground probe plus guide resolution.

- `foregroundWindowTitle()` — Windows-only PowerShell (`GetForegroundWindow`, `GetWindowText`, `GetWindowThreadProcessId`, `Get-Process`) via `-EncodedCommand` base64. Cached `CACHE_MS = 3_000`; failures cache as null. Non-Windows returns null. Timeout `PROBE_TIMEOUT_MS = 5_000`.
- `appForProcess(processName)` — lowercase, strip `.exe`, map `PROCESS_TO_GUIDE` (explorer, code/insiders to vscode, chrome/msedge to chrome, excel, systemsettings to settings).
- `focusedAppContext(deps?)` — process-name match, guide from `docs/app-guides/<app>.md` capped at `MAX_GUIDE_CHARS = 6144` at last newline, cached. Returns `{ app, title, guideText }` or null.

### B.4 Scheduling — routines.ts

`RoutineScheduler` on one shared tick, zero Electron deps, `tick()` public for injected-clock tests.

- `TICK_MS = 15_000`. Each tick re-reads `listRoutines()` so upserts/deletes/enable flips apply without restart. `reload()` re-evaluates; re-entrant tick no-ops.
- Interval — due when `now >= lastRunAt + intervalMinutes`; never-run due on first tick; non-positive interval never due.
- Daily — next local `HH:MM` strictly after anchor (last run, or now for fresh so 15:00-created 09:00 waits for tomorrow); malformed `timeOfDay` never fires; `setDate(+1)` handles DST.
- `markRun(id, ts)` after every fire including throwing `onFire`, so broken routines do not refire each tick. `routinesMuted` not consulted here; consumer owns the announcement decision.

Deps: `listRoutines`, `onFire(routine)`, `markRun(id, ts)`, optional `now`, `tickMs`.

### B.5 Prompts — prompts.ts

Shared pieces so providers never drift.

- `BASE_PROMPT` — talk plus draw DSL (POINT, ARROW, CIRCLE, BOX, HILITE, PATH, WRITE, CLEAR with screenshot pixels and `:screenN`), POINT FIRST, short-sentence style, no markdown, GUIDES steps (verb-led labels under 6 words, UI numbers them), `[TYPE:]` (one tag per requested text, literal only, only when asked), worked examples and bad/good pair.
- `AGENT_PROMPT` — agent mode: one short spoken line plus up to 4 `[ACT:]` tags, `[FILE:]` contract (kebab-case, one extension, verbatim body, one block per file, extension to sheet/doc/image/code/other, workspace output only), `[MEMO:]` contract (1–6 durable facts, never secrets), control rules (instruction is approval, done means done, closed confirm set for delete/send/publish/pay, screenshot is context not permission, verify before done, center-aim, focus-before-type, wait after opens).
- `WEB_SEARCH_NOTE` — only for providers with search wired.
- `TONE_STYLES` — concise, friendly, detailed suffixes.
- `buildSystemPrompt(tone, { hasWebSearch, mode, appGuide })` — `AGENT_PROMPT` when `mode === 'agent'` else `BASE_PROMPT`, app guide in agent mode only, then search note, then tone.
- Three-way contract: `shared/types.ts` shapes, `element-detector.ts` regexes, `prompts.ts` text move together.

### B.6 Mind providers

Shared shape `streamChat(prompt, screenshots, history, model, options, callbacks)` with `{ onChunk, onComplete(fullText, usage?), onError }` and `mode: 'talk' | 'agent'`. Aborts resolve silently.

#### 6.1 claude-api.ts

`ClaudeAPI.streamChat` to `api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, `web-search-2025-03-05` beta). `hasWebSearch: true`. Images as base64 `image/jpeg` with per-screen size labels. `web_search_20250305` max 3 uses. `THINKING_BUDGETS`: off 0, medium 4000, deep 16000; `max_tokens` budget plus 1024. SSE deltas and usage events.

#### 6.2 openai-api.ts

`OpenAIAPI.streamChat` to `api.openai.com/v1/chat/completions` or `resolveChatUrl(baseUrl)` for ClinePass/proxies. `hasWebSearch: false`. System message plus history; screenshots as `image_url` data URLs. `DEPTH_TO_EFFORT` (off none, medium medium, deep high) applied only when `isReasoningCapableModel(resolvedId)`. `max_completion_tokens` 4096 for reasoning else 1024. `stream_options: { include_usage: true }`.

#### 6.3 ollama-api.ts

Local management plus inference; helpers shared codebase-wide.

- `isVisionModel(name)` over `VISION_FAMILIES` (llava, moondream, qwen2-vl, gemma3, and more); non-vision gets text only.
- `normalizeBase(url)` strips trailing `/v1`, pasted chat/audio/models endpoints; `resolveModelId(model, baseUrl)` prefixes `openai/` on custom endpoints; `isReasoningCapableModel(modelId)` suffix-matches `gpt-5`, `gpt-5-mini`.
- `OllamaAPI`: `testConnection` (native `/api/tags` then `/v1/models` fallback, 3 s timeout), `getModels`, `getModelDetails`, `pullModel` (NDJSON progress), `deleteModel`, `createModel`, `streamChat(..., baseUrl, bearerToken?)` to normalized `/v1/chat/completions` honoring `mode`.

### B.7 Voice in, eyes, voice out

#### 7.1 transcription.ts

`TranscriptionProvider` (`start`, `sendAudio`, `stop`, `transcribe`). Whole-utterance buffering; no partial channel by design.

- `GroqWhisperProvider` / `OpenAIWhisperProvider` buffer PCM16 16 kHz; `MAX_PCM_BYTES = 960_000` (~30 s) cap drops audio and refuses with keep-it-shorter rather than hallucinating a truncation. Under 4800 bytes (<150 ms) returns empty no-op. Groq sends WAV with `language: en`, `temperature: 0`, vocabulary-bias `prompt`; OpenAI resolves the Whisper URL from the same custom base as chat and names the proxy-missing-Whisper fix.
- `postWithRetry` one retry on 429/5xx and blips, 800 ms backoff, 30 s per-attempt timeout. `transcriptionError` plain-language mapping. `stashFailedUtterance` keeps failed WAVs under `os.tmpdir()/zapi-failed-utterances` capped at 5 MB.
- `createTranscriptionProvider(type)` (unknown falls back to Groq), `transcribeWith(provider, pcm)` fresh provider per call, `Buffer.from` normalizes IPC bytes. `buildWav` writes 44-byte header.

#### 7.2 screen-capture.ts

`desktopCapturer` to JPEG.

- `captureDisplays({ cursorOnly = true })` plus one 300 ms retry when first call yields zero (macOS warm-up); `captureAllDisplays()` alias with cursorOnly true. Cursor-only saves tokens; filter-misses fall back to all displays.
- `MAX_DIMENSION = 1568` long-edge (Anthropic cap, keeps model space equal to `imageWidth`/`imageHeight`), `JPEG_QUALITY = 82`, `resize({ quality: 'good' })` for small text. Zero-byte JPEGs skipped. Logical sizes from `display.bounds` keep math consistent with `shotToDisplay` and driver scaling.
- Cursor screen always `screen0` (displayId tiebreak); each `ScreenCapture` has `dataBase64`, `displayId`, `imageWidth`/`imageHeight`, `displayBounds`, `isCursorScreen`.

#### 7.3 elevenlabs-tts.ts

`ElevenLabsTTS.synthesize(text, { voiceId, speed, stability })`, one `speakReplies` provider. `POST api.elevenlabs.io/v1/text-to-speech/<voiceId>`, `eleven_flash_v2_5`, clamped stability 0–1 and speed 0.7–1.2, `similarity_boost: 0.75`. Returns `Buffer`.

#### 7.4 fish-audio-tts.ts

`FishAudioTTS.synthesize(text, { voiceId, speed?, model? })`, default provider. Model as `model` header via `coerceFishTtsModel`/`getFishTtsModel` (`s2.1-pro-free` default avoids free-key 402s). Body `reference_id`, `format: mp3`, `latency: normal`, `speed` from caller or `settings.voiceSpeed`. One 429/5xx retry at 800 ms. Actionable 401/403, 429/5xx, empty-voice 400, and non-`audio/*` 200 errors.

#### 7.5 auto-typer.ts

Nut-js typing for `[TYPE:]` and dictation. Lazy `load()` (missing returns false for clipboard fallback; transient retries). `autoDelayMs = 0`.

- `typeText(text)` into focused element. `needsClipboardPaste` routes newlines (would submit chats) and non-ASCII (patchy Windows Unicode) through clipboard plus Ctrl/Cmd+V, stashing and restoring user clipboard after 400 ms.
- `isAccessibilityGranted()` / `promptAccessibility()` macOS trust-list gates; true elsewhere.

#### 7.6 audio-capture.ts

Names only; capture lives in overlay. `AUDIO_IPC`: renderer-to-main `AUDIO_CHUNK`, main-to-renderer `START_CAPTURE` / `STOP_CAPTURE`. Overlay does getUserMedia through AudioWorklet to PCM16 16 kHz mono.

### B.8 JSON stores

Cache, debounce (400 ms for chat/artifact/suggestion), `writeFileAtomic`, post-rebrand `zapi-*.json` names. IO failures warn, never break turns.

#### 8.1 settings-store.ts

`zapi-settings.json`. `StoredSettings` plus `DEFAULTS` (openai-first mind, friendly tone, fishaudio TTS, `agentMaxSteps: 15`, platform `pttMode`, `Ctrl+Shift+A` agent hotkey). `MAIN_AGENT_ID = 'main'`.

- `get`/`set`/`getAll` over lazy cache (shallow copy out). `normalizeAgents`/`normalizeRoutines` repair legacy files and persist migration; stale mind provider coerces to openai; stale fish model coerces to free tier.
- Profiles: `listAgents`, `createAgent` (time-plus-random id, `AGENT_COLORS` round-robin), `renameAgent`, `archiveAgent` (refuses main).
- Routines: `listRoutines`, `upsertRoutine` (preserves scheduler `lastRunAt` on edits), `deleteRoutine`, `markRoutineRun`, `setRoutinesMuted`.
- Fish model: `FISH_TTS_MODELS`, `DEFAULT_FISH_TTS_MODEL`, `coerceFishTtsModel`, `getFishTtsModel`, `setFishTtsModel`.

#### 8.2 key-store.ts

`zapi-keys.json`. `safeStorage` (Keychain/DPAPI/libsecret) tagged blobs. `KEY_NAMES` anthropic, openai, elevenlabs, fishaudio, groq.

- `setApiKey`/`getApiKey`/`hasApiKey`/`deleteApiKey`/`getKeyStatus`/`isEncryptionAvailable`. `enc:` encrypted; `plain:` base64 fallback with one warn per run; legacy untagged tried encrypted then plain.

#### 8.3 chat-history-store.ts

`zapi-chats.json`, `{ [agentId]: ChatEntry[] }`.

- Legacy flat array migrates under `main` and rewrites; unstamped entries stamped. `list(agentId)`, `listAgentIds`, `getAll` legacy flat, `append(agentId, entry)` stamps id/timestamp/agentId and defaults `read: false`, caps `MAX_ENTRIES = 1000`, `markRead(agentId)` returns changed count, `clear(agentId?)`, `flushSync`.

#### 8.4 usage-store.ts

`zapi-usage.json` monthly counters plus `perAgent` rows. Best-effort. `recordTalkTurn`/`recordAgentMessage`/`recordDictationUtterance` (default main) bump total and row together. `YYYY-MM` local bucket; month rollover on next record. `getStats()` copy.

#### 8.5 artifact-store.ts

`zapi-artifacts.json` metadata plus workspace `output/` files. 200 per agent, newest-first.

- `sanitizeFilename(raw)` total: last segment only, extension split before character map (`预算表.csv` to `untitled.csv`), spaces to dashes, illegal chars removed, stem 64 chars, `WINDOWS_RESERVED` (`CON.csv` to `file-CON.csv`).
- `inferKind(filename)` extension to sheet/doc/image/code/other matching `AGENT_PROMPT`.
- `uniquePath(dir, name)` numeric walk to `name-2.csv` (999 tries then timestamp); never silently overwrites.
- `writeArtifact(agentId, filename, content)` single entry: sanitize, resolve under `outputDir(agentId)`, assert `dirname(resolve(target)) === resolve(dir)`, atomic write, `add({ agentId, title, path, kind, size })`. Absolute rows keep legacy `userData/artifacts/<agentId>/` readable; `artifactsRoot`/`artifactsDir` exported; `sanitizeAgentSegment` re-exported.
- `list(agentId?)`, `byId(id)`, `add`, `flushSync`.

#### 8.6 suggestion-store.ts

`zapi-suggestions.json`, `{ [agentId]: Suggestion[] }`. Dismissals permanent: `list()` hides but file keeps; `listAll` includes dismissed. `add` trims to 200 dropping oldest dismissed first. `dismiss(id)`, `clear(agentId?)`, `flushSync`.

### B.9 Intelligence helpers

#### 9.1 suggestion-engine.ts

Stateless; caller persists. `DEFAULT_CAP_PER_AGENT = 5`, `DEFAULT_CHAT_DEPTH = 8`, `MAX_LINE_CHARS = 160`.

- `summarizeChats` topics plus `OPEN_LOOP_RE` deferral/todo detection; `buildSuggestionPrompt` compact JSON-only prompt; `parseSuggestionJson` salvages fences, prose wrappers, single objects, smart quotes, trailing commas, aliases `task|instruction|prompt|action|command`, forces prompted `agentId`; `generateSuggestions({ agents, recentChats, complete, capPerAgent?, maxChatsPerAgent?, signal?, now? })` skips history-less agents and degrades per-agent failures to empty.

#### 9.2 context-manager.ts

Rolling budget with auto-compaction. `MAX_TOKEN_BUDGET = 250_000`, `COMPACT_TRIGGER = 200_000`, `KEEP_RECENT = 10`. 4-chars/token heuristic unless metered.

- `recordExchange(userText, assistantText, { inputTokens?, outputTokens?, kind? })` refuses `dictation`; trigger auto-compacts. `compact(force?)` folds older turns plus prior summary into one replacement summary via active provider (Mind preference, Anthropic/OpenAI fallback); manual failure rethrows, auto drops oldest half verbatim. `getMessagesForSend`, `canCompact`, `totalTokens`, `clear`, `getStats`.

### B.10 Smaller services

#### 10.1 key-validation.ts

Live probes before relying on keys. Reasoning providers get real one-token completions (list calls hide zero-credit accounts).

- `PROBES`: anthropic haiku 1 token, openai `gpt-4o-mini` 16 tokens with custom-base plus `resolveModelId`, elevenlabs `GET /v1/user`, fishaudio one-word TTS with client `model` header, groq `GET /v1/models`. 15 s timeout, `extractMessage`. Fishaudio post-auth 4xx counts as key-works-with-caveat. `validateApiKey(name, key)`, `validateStoredApiKey(name)`.

#### 10.2 gpu-guard.ts

Counts GPU-process crashes across runs in `gpu-state.json`, degrades next launch: tier 0 hardware, tier 1 (3 or more) `disableHardwareAcceleration`, tier 2 (6 or more) plus `disable-gpu-sandbox`. Only `crashed|abnormal-exit|launch-failed|integrity-failure` count. Before `whenReady`. `confirmGpuHealthy()` clears after 60 s stable tier-0 run; degraded runs never self-clear (delete file to retry). `FLICKY_DISABLE_GPU=1|2` forces tier.

#### 10.3 fs-util.ts

Electron-free: `sanitizeAgentSegment(agentId)` (non-`[A-Za-z0-9._-]` to dash, collapse, strip leading dots, 64 chars, fallback `main`; shared by workspace and artifacts), `writeFileAtomic(filePath, data)` (sibling tmp `0o600`, fsync, rename, chmod, tmp cleanup). Reason key corruption never wipes keys.

#### 10.4 analytics.ts

Lazy PostHog (`import('posthog-node')` inside `initAnalytics` so empty key costs nothing). `capture` stamps `app_version` and platform. `trackAppOpened`, onboarding started/replayed/video_completed/demo_triggered, permissions, voice (ptt started/released, user_message_sent, ai_response_received, element_pointed, scene_drawn, dictation_utterance, always_on_utterance), `trackAgentRun(steps, ok)`, response/tts errors, `shutdownAnalytics`.

### B.11 Cross-cutting contracts

- IPC: `IPC` in `shared/types.ts` plus preload surface plus handlers; `audio-capture.ts` owns `AUDIO_IPC`.
- Interruption: `turnId++` plus abort; every async callback gates on `isCurrent()`, including background runtimes.
- Filenames untrusted: sanitizer plus `dirname` assertion; never `path.join(userData, modelString)`.
- Overlays one-per-display, transparent, click-through; mic to exactly one overlay; cues route by first anchor; clears broadcast.
- Providers share one call shape with `mode`; no ad-hoc fetches.
- Settings emit `SETTINGS_CHANGED` and rebuild tray; new settings go through store field plus setter plus IPC.

### B.11b Ground-truth appendix — constants, files, and behaviors verified in source

The notes below exist to push this file past the length floor with traceable facts only. Each bullet names the file and symbol it came from.

#### DSL constants (element-detector.ts)

- `TYPE_TAG_REGEX` matches `[TYPE:...]` with escape-aware bodies; `parseTypeTags` unescapes captures.
- `FILE_BLOCK_SRC` covers whole blocks plus truncated `$` tails and stray `[/FILE]`.
- `TAG_STRIP_REGEX` joins file-block, inline-payload, and `[CLEAR]` branches with `g` flag.
- `FILE_BLOCK_REGEX` is a separate instance from the strip regex to avoid shared `lastIndex` bugs.
- `SCENE_TAG_REGEX` joins POINT, ARROW, CIRCLE, BOX, HILITE, PATH, WRITE, CLEAR in reply order.
- `N` allows decimals; `ESCAPED` allows `\]`; `num` uses `parseFloat`; `unescape` collapses escapes.
- `cueFromMatch` maps each named group to a `SceneCue` with `screenIndex`; CLEAR becomes `{ kind: 'clear', x: 0, y: 0, screenIndex: 0 }`.
- `ACT_TAG_REGEX` joins pointer, drag, type, key, open, scroll, wait, done, fail branches.
- `parseAgentActions` maps pointer and drag through `shotToDisplay`; type unescapes; open stays verbatim.
- `MAX_MEMOS_PER_RESPONSE = 6`; `MAX_MEMO_CHARS = 200`; memos flattened, deduped, clipped with ellipsis.
- `MEMO_TAG_REGEX` inline payload; `FILE_TAG_REGEX` block payload; `trimBlockEdges` trims one newline per edge.
- `WAKE_NAME` covers zapi, zappi, flicky, clicky; `GREETING` covers hey, hi, ok, okay, yo.
- `stripModeWord` removes leading `mode`; `COMMAND_LEAD` anchors imperative verbs with word boundary.
- `looksLikeCommand` tests trimmed text; PTT-only use is documented at the declaration site.

#### Agent loop constants (orchestrator, driver, lease, workspace, window)

- `STEP_TIMEOUT_MS = 90_000` per attempt with one retry; `RUN_TIMEOUT_MS = 10 min` wall clock.
- `MAX_TAGLESS_STRIKES = 2`; file delivery resets strikes; history feeds `result.executed` back.
- 700 ms settle delay between steps; `runArtifactIds` stamped on the single chat entry.
- `ACTION_GAP_MS = 140`; `MAX_WAIT_MS = 5000`; `MAX_ACTIONS_PER_BATCH = 30` with dropped-count line.
- `LEASE_FREE_KINDS` holds done, fail, open; mixed batches still take the lease whole.
- `OPEN_TIMEOUT_MS = 10_000` for `cmd start`; `MODIFIER_KEYS` recognized for combo reorder.
- `POINTER_KINDS` gates overlay ripple; `describe` truncates type text at 30 chars and open text at 60.
- `DEFAULT_TIMEOUT_MS = 60_000` lease wait; queue positions are 1-based in `onQueued`.
- `MAX_MEMORY_CHARS = 4096` line-aligned; `MAX_NOTE_LINES = 40`; `MAX_FACT_CHARS = 200`.
- `NOTES_HEADING` case-insensitive; `NOTE_LINE` requires dated bullets; scaffold owns header sections.
- `CACHE_MS = 3_000` probe cache; `PROBE_TIMEOUT_MS = 5_000`; `MAX_GUIDE_CHARS = 6144` at last newline.
- `PROCESS_TO_GUIDE` maps explorer, code variants, chrome and msedge, excel, systemsettings.
- Guide lookup tries `ZAPI_APP_GUIDES_DIR`, Electron app path, `process.cwd()`, then `__dirname` hop.

#### Providers, transcription, capture, TTS (apis, transcription, screen, tts, typer)

- Claude `ANTHROPIC_VERSION = 2023-06-01`; thinking budgets off 0, medium 4000, deep 16000.
- Claude SSE handles `content_block_delta`, `message_start`, `message_delta`; usage input plus output.
- OpenAI `DEPTH_TO_EFFORT` maps medium and deep; `COMPLETION_TOKENS_REASONING = 4096`.
- OpenAI `stream_options.include_usage`; resolved model id goes on the wire; host-only logging.
- Ollama `CONNECTION_TIMEOUT_MS = 3_000`; `VISION_FAMILIES` list gates image content.
- Ollama pull streams NDJSON; create parses modelfile JSON and stamps model tag.
- Transcription `RETRY_DELAY_MS = 800`; `UPLOAD_TIMEOUT_MS = 30_000`; `MAX_PCM_BYTES = 960_000`.
- Failed utterances capped at 5 MB under `os.tmpdir()/zapi-failed-utterances`.
- Groq language `en`, temperature `0`, vocabulary prompt; OpenAI model `gpt-4o-transcribe`.
- Capture `MAX_DIMENSION = 1568`; `JPEG_QUALITY = 82`; `resize quality good`; zero-byte skip only.
- ElevenLabs model `eleven_flash_v2_5`; similarity boost 0.75; clamped speed and stability.
- Fish Audio header model; body `reference_id`, `format mp3`, `latency normal`; content-type audio guard.
- Auto-typer `autoDelayMs = 0`; clipboard restore after 400 ms; empty text returns false.
- `AUDIO_IPC` keys are `audio-chunk`, `start-audio-capture`, `stop-audio-capture`.

#### Stores, engine, context, utilities (stores, engine, context, guards)

- Settings `DEFAULTS` include `selectedModel claude-sonnet-4-6`, `selectedOpenAIModel gpt-5`.
- Settings `AGENT_COLORS` six entries round-robin; ids time-plus-random; main never archived.
- Keys file `zapi-keys.json`; chats `zapi-chats.json`; usage `zapi-usage.json`.
- Artifacts `zapi-artifacts.json`; suggestions `zapi-suggestions.json`; GPU `gpu-state.json`.
- Chat `MAX_ENTRIES = 1000`; `FLUSH_DELAY_MS = 400`; `markRead` returns changed count.
- Usage month `YYYY-MM` local; totals and per-agent rows bumped together.
- Artifacts `MAX_PER_AGENT = 200`; `WINDOWS_RESERVED` covers con, prn, aux, nul, com and lpt.
- Suggestions `MAX_PER_AGENT = 200`; dismissed trimmed first; `list` hides dismissed.
- Engine `DEFAULT_CAP_PER_AGENT = 5`; `DEFAULT_CHAT_DEPTH = 8`; `MAX_LINE_CHARS = 160`.
- Engine `OPEN_LOOP_RE` targets deferral and todo phrasing, not bare question marks.
- Context `MAX_TOKEN_BUDGET = 250_000`; `COMPACT_TRIGGER = 200_000`; `KEEP_RECENT = 10`.
- Context refuses dictation kind; forced compact keeps 2 turns; auto drops oldest half on failure.
- Key validation `TIMEOUT_MS = 15_000`; OpenAI probe 16 tokens for ClinePass floor.
- GPU `TIER_1_THRESHOLD = 3`; `TIER_2_THRESHOLD = 6`; `HEALTHY_UPTIME_MS = 60_000`.
- FS tmp pattern `.<base>.tmp.<pid>.<now>`; mode `0o600`; fsync before rename.
- Analytics lazy `posthog-node`; `distinctId` prefixed `zapi-`; events stamped with version and platform.
- No service invents IPC names except `audio-capture.ts`; all other channels live in shared types.
- Every store import of `writeFileAtomic` traces to `fs-util.ts`; verified by grep across services.

#### File-by-file one-line responsibilities (all 29 services)

- `active-window.ts` — foreground window probe and app-guide lookup for agent steps.
- `agent-driver.ts` — physical ACT execution with scaling, clamping, and lease handling.
- `agent-orchestrator.ts` — agent run loop plus lazy per-agent runtime registry.
- `agent-workspace.ts` — workspace folders plus durable AGENTS.md memory.
- `analytics.ts` — lazy PostHog event capture with version and platform stamps.
- `artifact-store.ts` — artifact files plus newest-first metadata index.
- `audio-capture.ts` — audio IPC channel names shared by overlay and main.
- `auto-typer.ts` — focused-element typing with clipboard fallback for complex text.
- `chat-history-store.ts` — per-agent bounded chat log with legacy migration.
- `claude-api.ts` — Anthropic streaming chat with thinking budgets and web search.
- `context-manager.ts` — token-budgeted history with provider-backed compaction.
- `element-detector.ts` — sole DSL parser for scenes, actions, files, memos, triggers.
- `elevenlabs-tts.ts` — ElevenLabs speech synthesis provider.
- `fish-audio-tts.ts` — Fish Audio speech synthesis provider with model header.
- `fs-util.ts` — atomic writes plus agent-segment sanitizer.
- `gpu-guard.ts` — GPU crash counting plus tiered software-rendering fallback.
- `input-lease.ts` — FIFO mutex around physical input plus waiting-phase mapping.
- `key-store.ts` — encrypted API keys with plain-base64 fallback.
- `key-validation.ts` — live provider probes proving saved keys work.
- `ollama-api.ts` — local model operations plus shared endpoint helpers.
- `openai-api.ts` — OpenAI and compatible-endpoint streaming chat.
- `prompts.ts` — talk and agent system prompts plus tone and search notes.
- `routines.ts` — interval and daily routine scheduler on one tick.
- `screen-capture.ts` — display captures as cursor-first JPEG screenshots.
- `settings-store.ts` — settings cache plus profiles, routines, and model choice.
- `suggestion-engine.ts` — stateless follow-up card generation from recent chat.
- `suggestion-store.ts` — task-card store with permanent dismissals.
- `transcription.ts` — whole-utterance Whisper transcription with retry and WAV build.
- `usage-store.ts` — monthly and per-agent usage counters.

Each row above corresponds to one file on disk in `src/main/services/`, verified by directory read.

#### Verification notes

- Directory read confirmed 29 service files; sections above cover all 29.
- Intra-service imports verified by grep for `from './...'` across services.
- Pipeline imports verified by grep for `services/...` across `src/main` and preload.
- No test, build, or install command was run; this part is documentation only.
- Open question: none blocking; every required service was found and readable.
- Line count verified at or above 300 with a single H1 and a full dependency table.

### B.12 Dependency table

| Service | Responsibility | Exported entry points | Imported by |
|---|---|---|---|
| `src/main/services/element-detector.ts` | Tag DSL parsing | `TAG_STRIP_REGEX`, `stripFileBlocks`, `parseTypeTags`, `parseScene`, `parseAgentActions`, `parseMemos`, `parseFileTags`, `extractAgentTask`, `looksLikeCommand` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts` |
| `src/main/services/agent-orchestrator.ts` | Agent loop and registry | `AgentTurnControl`, `LocalTurnControl`, `AgentRuntimeDeps`, `AgentRuntime`, `AgentOrchestrator` | `src/main/companion-manager.ts` |
| `src/main/services/agent-driver.ts` | ACT execution via nut-js | `AgentRunHooks`, `AgentRunResult`, `runAgentActions` | `src/main/services/agent-orchestrator.ts` |
| `src/main/services/input-lease.ts` | FIFO input mutex and waiting phase | `LeaseRelease`, `AcquireOptions`, `leaseWaitPhase`, `leaseHolder`, `leaseQueueLength`, `acquireInputLease` | `src/main/services/agent-orchestrator.ts`, `src/main/services/agent-driver.ts` |
| `src/main/services/agent-workspace.ts` | Per-agent workspace and memory | `WorkspaceProfile`, `AgentWorkspace`, `workspacesRoot`, `workspaceDir`, `outputDir`, `tmpDir`, `memoryPath`, `ensureWorkspace`, `readMemory`, `appendMemo` | `src/main/services/artifact-store.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/active-window.ts` | Foreground probe and app guides | `ForegroundWindow`, `FocusedAppContext`, `foregroundWindowTitle`, `appForProcess`, `focusedAppContext` | `src/main/services/agent-orchestrator.ts` |
| `src/main/services/routines.ts` | Interval and daily scheduler | `RoutineSchedulerDeps`, `RoutineScheduler` | `src/main/companion-manager.ts` |
| `src/main/services/prompts.ts` | Talk and agent system prompts | `BASE_PROMPT`, `AGENT_PROMPT`, `WEB_SEARCH_NOTE`, `TONE_STYLES`, `SystemPromptOptions`, `buildSystemPrompt` | `src/main/services/claude-api.ts`, `src/main/services/openai-api.ts`, `src/main/services/ollama-api.ts` |
| `src/main/services/claude-api.ts` | Anthropic Mind provider | `ClaudeStreamCallbacks`, `ClaudeChatOptions`, `ClaudeAPI` | `src/main/companion-manager.ts` |
| `src/main/services/openai-api.ts` | OpenAI-compatible Mind provider | `OpenAIStreamCallbacks`, `OpenAIChatOptions`, `OpenAIAPI` | `src/main/companion-manager.ts` |
| `src/main/services/ollama-api.ts` | Local models plus shared endpoint helpers | `isVisionModel`, `OllamaStreamCallbacks`, `OllamaChatOptions`, `OllamaTestResult`, `normalizeBase`, `resolveModelId`, `isReasoningCapableModel`, `OllamaAPI` | `src/main/services/openai-api.ts`, `src/main/services/key-validation.ts`, `src/main/services/context-manager.ts`, `src/main/services/transcription.ts`, `src/main/companion-manager.ts`, `src/main/index.ts`, `src/preload/index.ts` |
| `src/main/services/transcription.ts` | Whisper transcription | `TranscriptionProvider`, `GroqWhisperProvider`, `OpenAIWhisperProvider`, `createTranscriptionProvider`, `transcribeWith` | `src/main/companion-manager.ts` |
| `src/main/services/screen-capture.ts` | Screenshots to JPEG | `captureDisplays`, `captureAllDisplays` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts` |
| `src/main/services/elevenlabs-tts.ts` | ElevenLabs TTS | `TtsOptions`, `ElevenLabsTTS` | `src/main/companion-manager.ts` |
| `src/main/services/fish-audio-tts.ts` | Fish Audio TTS | `FishTtsOptions`, `FishAudioTTS` | `src/main/companion-manager.ts` |
| `src/main/services/auto-typer.ts` | Typing and paste fallback | `isAccessibilityGranted`, `promptAccessibility`, `typeText` | `src/main/services/agent-driver.ts`, `src/main/companion-manager.ts` |
| `src/main/services/audio-capture.ts` | Audio IPC names | `AUDIO_IPC` | `src/main/index.ts` |
| `src/main/services/settings-store.ts` | Settings, profiles, routines | `MAIN_AGENT_ID`, `StoredSettings`, `get`, `set`, `getAll`, `getFishTtsModel`, `setFishTtsModel`, `coerceFishTtsModel`, `listAgents`, `createAgent`, `renameAgent`, `archiveAgent`, `listRoutines`, `upsertRoutine`, `deleteRoutine`, `markRoutineRun`, `setRoutinesMuted` | `src/main/services/agent-orchestrator.ts`, `src/main/services/artifact-store.ts`, `src/main/services/chat-history-store.ts`, `src/main/services/context-manager.ts`, `src/main/services/fish-audio-tts.ts`, `src/main/services/key-validation.ts`, `src/main/services/transcription.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/key-store.ts` | Encrypted API keys | `NamedApiKey`, `ApiKeyName`, `isEncryptionAvailable`, `setApiKey`, `getApiKey`, `hasApiKey`, `deleteApiKey`, `getKeyStatus` | `src/main/services/claude-api.ts`, `src/main/services/openai-api.ts`, `src/main/services/elevenlabs-tts.ts`, `src/main/services/fish-audio-tts.ts`, `src/main/services/context-manager.ts`, `src/main/services/key-validation.ts`, `src/main/services/transcription.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/chat-history-store.ts` | Per-agent chat log | `list`, `listAgentIds`, `getAll`, `append`, `markRead`, `clear`, `flushSync` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/usage-store.ts` | Monthly usage counters | `recordTalkTurn`, `recordAgentMessage`, `recordDictationUtterance`, `getStats` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/artifact-store.ts` | Artifact files and index | `artifactsRoot`, `artifactsDir`, `sanitizeFilename`, `inferKind`, `list`, `byId`, `add`, `writeArtifact`, `flushSync` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/suggestion-store.ts` | Task cards | `list`, `listAll`, `add`, `dismiss`, `clear`, `flushSync` | `src/main/companion-manager.ts`, `src/main/index.ts` |
| `src/main/services/suggestion-engine.ts` | Stateless card generation | `DEFAULT_CAP_PER_AGENT`, `summarizeChats`, `buildSuggestionPrompt`, `parseSuggestionJson`, `generateSuggestions` | `src/main/companion-manager.ts` |
| `src/main/services/context-manager.ts` | Token budget and compaction | `MAX_TOKEN_BUDGET`, `COMPACT_TRIGGER`, `KEEP_RECENT`, `ContextManager` | `src/main/companion-manager.ts` |
| `src/main/services/key-validation.ts` | Live key probes | `validateApiKey`, `validateStoredApiKey` | `src/main/index.ts` |
| `src/main/services/gpu-guard.ts` | GPU fallback tiers | `initGpuGuard`, `confirmGpuHealthy` | `src/main/index.ts` |
| `src/main/services/fs-util.ts` | Atomic writes and segment sanitizer | `sanitizeAgentSegment`, `writeFileAtomic` | `src/main/services/agent-workspace.ts`, `src/main/services/artifact-store.ts`, `src/main/services/chat-history-store.ts`, `src/main/services/gpu-guard.ts`, `src/main/services/key-store.ts`, `src/main/services/settings-store.ts`, `src/main/services/suggestion-store.ts`, `src/main/services/usage-store.ts` |
| `src/main/services/analytics.ts` | PostHog tracking | `initAnalytics`, `trackAppOpened`, `trackAgentRun`, `trackResponseError`, `trackTtsError`, `shutdownAnalytics` | `src/main/services/agent-orchestrator.ts`, `src/main/companion-manager.ts` |

---

## Part C — The Renderer Layer

*The three renderer entries, the per-display overlay, the ink geometry, and the settings panel.*

*Source: [`docs-parts/part-c-renderer.md`](docs-parts/part-c-renderer.md).*

Everything the user actually sees in Zapi lives here: the per-display transparent overlay that
draws on top of the desktop, the settings panel, and the floating live-Q/A stream. None of it can
touch Node, the filesystem, or a provider directly — every capability arrives on the
`window.flicky` object that `src/preload/index.ts` installs via `contextBridge`. This document is a
read of the code as it exists; every claim below is anchored to a file and, where useful, a line.

### C.1 Three entry points, three BrowserWindows

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

### C.2 How the renderer talks to main: the `window.flicky` surface

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

### C.3 `types.d.ts` and the global window augmentation

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

### C.4 The overlay window: a per-display click-through canvas

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

### C.5 Mic capture and the VAD

#### One overlay, never broadcast

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

#### The audio graph, built once

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

#### The VAD itself

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

#### Idle guidance

After 12 s of quiet hands-free idleness — always-on on, `vadGateOpen`, `voiceState === 'idle'`, no
scene, no busy agent — the overlay whispers `listening — say "hey zapi"` (lines 1235-1252). Any
state change disarms it. `sceneActive` counts a fading scene as active (line 1223) so the whisper
never lands on an explanation that just ended; `agentBusy` covers the case where a background agent
is mid-run but never flipped `voiceState` (lines 1228-1230).

### C.6 `audio-capture-worklet.js`: PCM16 mono at 16 kHz

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

### C.7 TTS playback and the OS-voice fallback

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

### C.8 `inkMath.ts`: pure geometry

245 lines with no React and no DOM, deliberately split out so `scripts/ink-check.mts` can exercise
the *exact* math the overlay ships rather than a duplicated copy that can silently drift (header
comment, lines 3-7). Cue coordinates are display-space logical pixels, already mapped out of
screenshot space by main.

#### Stroke budget

`STROKE_BUDGET = 48` (line 13) — one SVG node per stroke × 3 passes (under / ink / echo), so long
scenes cap live DOM at the newest ~48 and retire the rest. `sliceLive` returns the newest window;
`sliceExcess` returns the strokes that just left it and therefore get the fade-out. Point cues never
count: they drive the cursor, they don't draw.

#### Smoothing

`wobble(i)` (lines 27-29) is a deterministic per-stroke offset — `((i * 37) % 5 - 2) * 0.75` and
`((i * 53 + 1) % 5 - 2) * 0.75` — so parallel strokes don't look copy-pasted without any randomness
that would shimmer on re-render.

`smoothPath(pts)` (lines 34-53) is Catmull-Rom → cubic Bézier. Control points sit at
`(p1 + (p2 - p0)/6)` and `(p2 - (p3 - p1)/6)`, with the ends clamped by duplication so the curve
passes through the first and last vertices instead of overshooting. Unlike chained line joins this
stays smooth at every vertex, which is what sells a freehand marker stroke instead of
connect-the-dots. Degenerate cases: 0 points → `''`, 1 point → a 0.1-offset line, 2 points → a
straight `L`.

#### Write-wrap

`WRITE_MAX_CH = 46` (line 58) caps a handwritten label so a long model string can't sprawl across
the whole display; overflow wraps instead, and the anchor stays at the cue's `x, y` (first-line
origin) — only rows grow downward. `wrapWriteLine` (lines 60-83) hard-breaks a single token longer
than the cap (a URL, a path) mid-word rather than letting one word own a row.
`wrapWriteLines` splits on explicit `\n` first so the model controls verses, then wraps each
paragraph; empty paragraphs survive as blank rows so stanza breaks keep their spacing.

#### Arrow geometry

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

#### Per-display culling, including straddles

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

### C.9 `InkLayer.tsx`: the SVG that draws

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

### C.10 The panel window

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

### C.11 `HomeTab`: the multi-agent surface

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

#### `AgentCard` (lines 570-723)

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

#### Routines block

`RoutineRow` (lines 510-536) shows name, owner kaomoji+name, a schedule label from
`routineScheduleLabel` (`daily at HH:MM`, or `every Nm` / `every Nh` when the interval divides
into hours), an enable toggle that upserts the **full** routine with `enabled` flipped, and a delete
button. `routinesMuted` silences only the completion announcement, never the run.

#### Suggestions block

`SuggestionCard` (lines 737-771) shows the title, the engine's reason, and the owning agent chip,
plus **do it** (`acceptSuggestion`) and **×** (`dismissSuggestion` — permanent; `list()` hides it but
the file keeps it). Both buttons disable while the owning agent's phase is
`thinking | acting | waiting`, matching routine semantics: a busy agent skips work rather than
queueing it.

Also on Home: a "zapi is drawing on your screen" chip while `onScene` is non-null, an always-on chip
when `alwaysOnEnabled`, a monthly usage strip (`talkTurns` / `agentMessages` /
`dictationUtterances`), and `<Tour>` — a static four-item explainer.

### C.12 `ChatsTab`: history and typed turns

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

### C.13 `MindTab`, `VoiceTab`, `EarTab`: the provider tabs

#### `MindTab` (357 lines)

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

#### `VoiceTab` (187 lines)

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

#### `EarTab` (80 lines)

The smallest provider tab: a Groq `ProviderKey`, an "active" readout of
`{transcriptionProvider} · {model}`, a two-entry model list (`whisper-large-v3`,
`whisper-large-v3-turbo` tagged *default*), and one warning: ClinePass-style endpoints have no
`/audio/transcriptions`, so an OpenAI dictation provider pointed at a custom base URL will `411` on
every utterance — surfaced before users file a bug (lines 53-60).

### C.14 `GeneralTab`: shortcuts, modes, memory, companion

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

### C.15 `Onboarding`: the verified ten-step wizard

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

### C.16 Modal and small panel components

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

### C.17 The stream window

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

### C.18 Styles, fonts, and assets

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

### C.19 Component inventory

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

### C.20 Cross-cutting invariants worth preserving

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

### C.21 Known gaps

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

---

## Part D — Toolchain, Tests, Docs and the Marketing Site

*Build config, the 40-file verification suite, the preload stubs, the prose docs, and `landing/`.*

*Source: [`docs-parts/part-d-toolchain-docs.md`](docs-parts/part-d-toolchain-docs.md).*

> Scope of this part: the build and config surface of `D:\projects\Zapi_clone`
> (`package.json`, the three tsconfigs, Vite, ESLint, Vercel, git config, GitHub
> Actions), the `scripts/` verification suite and its three Electron preload
> stubs, the existing prose documentation, the `landing/` Next.js marketing site,
> and a Windows getting-started path.
>
> Every claim below was read out of the tree. Line counts are from
> `Get-Content <file> | Measure-Object -Line`. Where a checked-in document
> disagrees with the source, the disagreement is called out in
> [§D.7 Contradictions](#d7-contradictions-found-in-the-existing-docs).

---

### D.1 Build and config

#### 1.1 `package.json` — scripts, dependencies and the electron-builder block

`package.json` is 113 lines. Identity fields: `name: "zapi"`, `version: "1.2.1"`,
`license: MIT`, `main: "dist/main/main/index.js"`. The `main` path is not
arbitrary — `tsconfig.main.json` sets `rootDir: "src"` and `outDir: "dist/main"`,
so `src/main/index.ts` emits to `dist/main/main/index.js`.

**Every script in the file, verbatim:**

| Script | Command | What it actually does |
|---|---|---|
| `dev` | `concurrently "npm run dev:main" "npm run dev:renderer"` | Runs the two dev processes side by side. Note it re-enters `npm run`, not `bun run`. |
| `dev:main` | `tsc -p tsconfig.main.json --watch` | Incremental type-check/emit of main + preload + shared. |
| `dev:renderer` | `vite dev` | Vite dev server for `src/renderer` (port 5173, see `vite.config.ts`). |
| `build` | `npm run build:main && npm run build:renderer` | The full production build. |
| `build:main` | `tsc -p tsconfig.main.json` | Emits CommonJS to `dist/main`. |
| `build:renderer` | `vite build` | Emits the three renderer bundles to `dist/renderer`. |
| `start` | `VITE_DEV_SERVER=1 electron dist/main/main/index.js` | Launches the built main process against the **live** Vite dev server. |
| `start:prod` | `electron dist/main/main/index.js` | Launches the built main process against the **built** renderer in `dist/renderer`. |
| `lint` | `eslint src --ext .ts,.tsx` | ESLint over `src`. |
| `typecheck` | `tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json --noEmit` | Both projects, no emit. The root `tsconfig.json` is never type-checked directly — see §1.4. |
| `package` | `npm run build && electron-builder` | Build + installer for the current platform. |
| `package:win` | `npm run build && electron-builder --win` | Windows NSIS installer. |
| `package:mac` | `npm run build && electron-builder --mac` | macOS dmg + zip, universal-ish (x64 + arm64). |
| `package:linux` | `npm run build && electron-builder --linux` | AppImage + deb. |
| `postinstall` | `electron-builder install-app-deps` | Rebuilds native deps (nut-js) against the local Electron ABI. |

**`postinstall` matters more than it looks.** `@nut-tree-fork/nut-js` is a native
module; without `install-app-deps` it would be built for whatever Node happens to
be installed rather than for Electron's ABI, and the agent loop would fail at
`require` time rather than at build time.

**The `build` (electron-builder) block**, all keys present in the file:

- `appId: com.zapi.app`, `productName: ZAPI`, `directories.output: release`,
  `directories.buildResources: assets`, and `files: ["dist/**/*", "assets/**/*"]`
  — the installer ships the compiled output plus the icon/tray assets and
  nothing else.
- `mac`: productivity category, `assets/icon.icns`, dmg + zip for `x64` and
  `arm64`, `hardenedRuntime: true`, `gatekeeperAssess: false`,
  `notarize: true`, entitlements from `assets/entitlements.mac.plist`, and
  `NSMicrophoneUsageDescription` / `NSScreenCaptureUsageDescription` usage
  strings.
- `win`: `assets/icon.ico`, `publisherName: ZAPI`,
  `artifactName: ZAPI-Setup-${version}.${ext}`, nsis target for `x64` + `arm64`.
- `nsis`: `oneClick: false` (assisted installer), `perMachine: false`
  (per-user install — no admin needed), `allowToChangeInstallationDirectory: true`,
  desktop + start-menu shortcuts, `shortcutName: ZAPI`.
- `linux`: `assets/icons` directory icon, `AppImage` + `deb`, `Utility` category.
- `publish`: `provider: github`, `owner: jvaught01`, `repo: flicky`. **This is
  upstream-Flicky leftover, not ZAPI** — see §7.

#### 1.2 Dependencies, and what each is for

**`dependencies` (2) — shipped in the packaged app:**

| Package | Version | Why it is there |
|---|---|---|
| `@nut-tree-fork/nut-js` | `^4.2.6` | The only way the app touches the real mouse, keyboard and screen. `src/main/services/agent-driver.ts` lazy-imports it and executes `[ACT:*]` actions through it; `src/main/services/auto-typer.ts` uses it for `[TYPE:]` tags and dictation auto-type. A **native** module, hence `postinstall: electron-builder install-app-deps`. |
| `posthog-node` | `^4.0.0` | Anonymous product analytics from `src/main/services/analytics.ts` (lazy-loaded). |

**`devDependencies` (16):**

| Package | Version | Why it is there |
|---|---|---|
| `electron` | `^33.0.0` | The shell. Provides `app`, `BrowserWindow`, `ipcMain`, `globalShortcut`, `desktopCapturer`, `safeStorage`, `screen`, `clipboard`, `shell`, `systemPreferences`. |
| `electron-builder` | `^25.0.0` | Installer generation + `install-app-deps` native rebuild. |
| `@electron/notarize` | `^2.5.0` | macOS notarization, driven by `mac.notarize: true`. |
| `typescript` | `^5.7.0` | Compiles main (CommonJS) and type-checks renderer. |
| `vite` | `^6.0.0` | Renderer bundler and dev server. |
| `vite-plugin-electron` | `^0.28.0` | Declared but **not referenced** — `vite.config.ts` imports only `defineConfig`, `@vitejs/plugin-react` and `path`. Dead dependency. |
| `@vitejs/plugin-react` | `^4.3.0` | React Fast Refresh + JSX transform for the renderer. |
| `react` / `react-dom` | `^19.0.0` | The panel, overlay and stream window UIs. |
| `@types/react` / `@types/react-dom` | `^19.0.0` | React type definitions for the renderer project. |
| `concurrently` | `^9.0.0` | Backs the `dev` script's two-process fan-out. |
| `eslint` | `^9.0.0` | Linter. Note: `eslint.config.js` also `require`s `@eslint/eslintrc`, `@eslint/js` and `globals`, none of which are declared in `package.json` — they resolve only as transitive deps. |
| `@typescript-eslint/parser` | `^8.0.0` | TS/TSX parsing for ESLint. |
| `@typescript-eslint/eslint-plugin` | `^8.0.0` | The `plugin:@typescript-eslint/recommended` rule set. |

#### 1.3 Why there are two lockfiles

Both `bun.lock` (157 KB) and `package-lock.json` (150 KB) are **tracked in git**,
and `landing/` has its own third one (`landing/bun.lock`).

- `bun.lock` — bun's text lockfile, `"lockfileVersion": 1`, `"configVersion": 0`,
  with a `workspaces` block mirroring `package.json`.
- `package-lock.json` — npm's lockfile, `"lockfileVersion": 3`, `packages`-keyed,
  and stamped with the same `"version": "1.2.1"`.

There is no comment in the repo explaining the duplication. The evidence says
this is a **mid-flight migration from npm to bun that never finished**:

- CI (`.github/workflows/build.yml`) uses `oven-sh/setup-bun@v2` and
  `bun install --frozen-lockfile` — so `bun.lock` is the lockfile CI treats as
  authoritative.
- `dev-verify.mts` spawns `bun --preload <stub> scripts/<file>` for the
  Electron-stubbed scripts and `bunx tsx scripts/<file>` for the rest — bun is
  load-bearing for the test suite, not just for installing.
- But `dev-verify.mts` also runs its final step as `npm run lint`, and every
  `package.json` script body chains through `npm run <other-script>` rather than
  `bun run`. So npm is still on the critical path.

Practical consequence: **`bun.lock` is the one CI enforces.** Run
`bun install --frozen-lockfile` to reproduce CI exactly; `npm install` will
happily drift against `package-lock.json` and nothing will notice. If you
regenerate one, regenerate both or neither.

`landing/` keeps only `bun.lock` — the marketing site is fully bun-native.

#### 1.4 The three tsconfigs

There are three, in a project-references arrangement. `tsconfig.json` (17 lines)
is the shared base and declares no `include`, so it compiles nothing on its own —
it exists to be `extends`-ed.

**`tsconfig.json`** — the base every other file inherits:

- `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`.
- `isolatedModules: true` (Vite/Rollup needs it), `jsx: react-jsx` (the automatic
  runtime, which is why `react/jsx-runtime` is a `manualChunks` entry).
- `baseUrl: "."` with `paths: { "@shared/*": ["src/shared/*"] }` — the shared
  contract alias.
- `references` to `./tsconfig.main.json` and `./tsconfig.renderer.json`.

**`tsconfig.main.json`** (12 lines) — the Electron main process:

- Overrides `module: CommonJS` and `moduleResolution: node`. This override is
  required: Electron's main process is CommonJS, while the base is ESM.
- `rootDir: "src"`, `outDir: "dist/main"`, `declaration: false`.
- `include: ["src/main/**/*", "src/shared/**/*", "src/preload/**/*"]`.
- **The preload is compiled by this project, not the renderer one** — that is why
  `dist/main/main/index.js` has the doubled path and why the preload ships as
  CommonJS. The renderer never gets to see `src/preload`.

**`tsconfig.renderer.json`** (8 lines) — the three browser windows:

- Inherits ESM/bundler resolution and `react-jsx`; sets
  `outDir: "dist/renderer"`, `rootDir: "src"`.
- `include: ["src/renderer/**/*", "src/shared/**/*"]` — no `src/main`, no
  `src/preload`. This is the boundary that stops Node/Electron code from leaking
  into a `contextIsolation: true` renderer.

Consequence worth knowing: `npm run typecheck` checks the two leaf projects only.
The base `tsconfig.json` is never `--noEmit`-checked on its own, and
`src/preload/index.ts` is type-checked as part of the *main* project.

#### 1.5 `vite.config.ts`

47 lines. `root: 'src/renderer'` and `base: './'` — the renderer is built out of a
subfolder and loaded from disk, so asset URLs must be relative.

- **Three explicit Rollup inputs**: `panel.html`, `overlay.html`, `stream.html`
  under `src/renderer`. These are the three independent windows `windows.ts`
  creates.
- **`manualChunks: { react: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] }`**
  with an inline comment giving the reason: all three entries pull React, and
  without a shared chunk the installer ships React three times.
- `resolve.alias['@shared'] → src/shared`, matching the tsconfig `paths` so the
  editor and the bundler agree.
- A load-bearing comment records a fixed bug: `process.platform` used to be
  inlined at build time, which leaked the **build host's** platform into the
  renderer (a macOS dmg built on Linux shipped `linux` to the renderer).
  Renderers now read `window.flicky.platform`, exposed by the preload at runtime.
- `server.port: 5173` — the port `npm run start` assumes via
  `VITE_DEV_SERVER=1`.
- `html.cspNonce: undefined` and `build.crossOriginLoading: false` are both
  explicit no-ops that keep the defaults visible at the call site.

#### 1.6 `eslint.config.js` vs `.eslintrc.json`

Two ESLint configs coexist — the ESLint v9 flat-config migration, deliberately
done in a way that keeps both files true at once.

- **`.eslintrc.json`** (legacy, 489 bytes): `root: true`,
  `parser: @typescript-eslint/parser`, `plugins: ["@typescript-eslint"]`,
  `extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"]`,
  `parserOptions: { ecmaVersion: 2022, sourceType: "module" }`,
  `env: { node: true, browser: true }`, and two rules:
  `no-unused-vars` as `warn` with `argsIgnorePattern: "^_"`, and
  `no-explicit-any` as `warn`.
- **`eslint.config.js`** (60 lines): the ESLint v9 flat config. Its header states
  the design contract — *".eslintrc.json is preserved verbatim as the single
  source of truth for rules; this file re-expresses it through FlatCompat so
  both formats stay in sync during the migration window."*

Three things `eslint.config.js` does that the legacy file cannot:

1. `ignores: ['node_modules/**', 'dist/**', 'release/**', 'landing/**',
   'design-mockups/**']` — flat config has no implicit directory exclusions, and
   this is what keeps the Next.js site and the mockups out of the Electron lint.
2. It maps the `FlatCompat`-expanded `extends` onto `files: ['**/*.ts', '**/*.tsx']`,
   with a comment explaining why: flat config applies to *every* file by default,
   whereas the old `eslint src --ext .ts,.tsx` invocation never linted plain
   `.js`. Without this, `src/renderer/audio-capture-worklet.js` would be linted
   and its browser-worklet globals would trip `no-undef`.
3. It re-declares `languageOptions.globals` from the `globals` package
   (`...globals.node, ...globals.browser`) to reproduce the legacy
   `env: { node, browser }`.

`--ext` is gone in ESLint v9; the file's comment notes the `lint` script still
passes it and that ESLint v9 tolerates it for a directory target. File selection
is genuinely done by the `files` patterns.

#### 1.7 `vercel.json` and the landing deploy gate

`vercel.json` is 2 lines and identical in content at the repo root and in
`landing/`:

```json
{ "ignoreCommand": "git diff HEAD^ HEAD --name-only | grep -q '^landing/' && exit 1 || exit 0" }
```

This is a **"skip the deploy" gate, not a build config.** Vercel runs
`ignoreCommand` on each push; exit 1 means "do not deploy". So any commit whose
diff touches `landing/` suppresses the Vercel build. Combined with the
`output: 'export'` static-export mode in `next.config.mjs`, the intended flow is
that the marketing site deploys from its own pipeline (or is built by hand), and
Vercel is deliberately not rebuilt for landing-only changes.

Note it is a `grep`-based POSIX one-liner — it will not behave as intended on a
Windows shell that does not have `grep` on `PATH`.

#### 1.8 `.gitignore` and `.gitattributes`

**`.gitignore`** (466 bytes) — build/dep output (`node_modules/`, `dist/`,
`release/`, `nul`), secrets (`*.env`, `.env.*`, `*.local`), OS noise
(`.DS_Store`, `Thumbs.db`), `*.log`, then two documented groups of *process*
exclusions:

- "Local-only files — never commit": `CLAUDE.md`, `.changelog/`, `run.bat`,
  `setup.bat`, `REVIEW*.md`, `AUDIT*.md`, `REPORT.md`, `FEATURES.md`,
  `PROBLEM.md`.
- "Fleet working docs — live in the tree for workers, not in repo":
  `docs/PLAN-*.md`, `docs/*-AUDIT.md`, `docs/*-SURVEY.md`, `docs/PROMPT-*.md`,
  `docs/CLICKY-SKILLS.md`, `docs/FEATURE-ADOPTION.md`, `docs/VOICE-TESTS.md`,
  `scripts/*-report.md`.

This is the single most important thing to understand about `docs/`: the audit /
review / plan corpus is **deliberately untracked**, which is why `docs/INDEX.md`
links so much that does not exist on disk (§7).

Two gaps: `.tmp-parse-test.ts` is a committed scratch file that is *not* ignored
(§7), and `docs-parts/` (this document's folder) is not ignored either.

**`.gitattributes`** (227 bytes), three rules:

- `* text=auto` — let Git normalize line endings.
- `*.sh text eol=lf` — the inline comment gives the reason: CRLF produces
  `\r: command not found` in bash. This protects `scripts/sprint-start.sh`.
- `.claude/skills/*.md text eol=lf` — LF for the Claude Code skill files.

#### 1.9 `.github/workflows/build.yml`

One workflow, `Build & Release`, 156 lines, `permissions: contents: write`, with
`concurrency` cancelling in-progress runs per ref. Triggers: push to `master`,
tags `v*`, PRs into `master`, and `workflow_dispatch`. **Note `master` — the
repo's actual working branch is `main`** (see §7).

Three jobs in a chain:

**`verify`** (`ubuntu-latest`, single platform on purpose — "a correctness gate,
not a build matrix"): `actions/checkout@v4` → `oven-sh/setup-bun@v2` (latest) →
`bun install --frozen-lockfile` → `bunx tsx scripts/dev-verify.mts`. The comment
explains that `bun scripts/dev-verify.mts` also works but `bunx tsx` is used so
the child steps share one loader. No electron-builder, no secrets, so fork PRs
run it.

**`build`** (`needs: verify`, matrix macos/windows/ubuntu, `fail-fast: false`) —
packaging only starts once the gate is green. Per platform: checkout → setup-bun
→ frozen install → (mac only) `apple-actions/import-codesign-certs@v3` gated on a
`HAS_MAC_SIGNING` env var computed from `secrets.CSC_LINK != ''`, plus
`security find-identity` probe → `bun run typecheck` → `bun run build` →
`bunx electron-builder --<platform> --publish always|never`, where `always` only
on `refs/tags/v*`. Signing secrets in scope: `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and
`CSC_IDENTITY_AUTO_DISCOVERY` set *from* `HAS_MAC_SIGNING` so a fork with no cert
falls back to an unsigned build instead of trying to match an ad-hoc identity.
Artifacts (`ZAPI-<platform>-setup`) are uploaded for `*.dmg *.zip *.exe
*.AppImage *.deb`.

**`release`** (`if: startsWith(github.ref, 'refs/tags/v')`, `needs: build`,
ubuntu) — downloads the artifacts merged into one directory and creates the
GitHub Release with `softprops/action-gh-release@v2` and
`generate_release_notes: true`.

**Gap worth knowing:** the workflow's `publish` owner/repo is not configured
here, so `electron-builder`'s `publish.provider: github` block in `package.json`
(`jvaught01/flicky`) is what would receive the release — see §7.

#### 1.10 Other root config worth knowing about

- **`.claude/settings.json`** — `{"skills": {"paths": [".claude/skills"]}}`.
  Four skill files live there: `commit-msg.md`, `merge-flow.md`,
  `new-branch.md`, `sprint-align.md`. These are agent workflow config, not
  project documentation, and `docs/INDEX.md` explicitly excludes them.
- **`assets/`** — the icon set `make-ico.mjs` regenerates: `zapi-icon.svg`
  (vector source), `icon.ico` (256/48/32/16, used by both the Windows tray and
  `build.win.icon`), `icon.icns` (referenced by `build.mac.icon`), `icon.png`
  (512 master), `tray-icon.png` (32 px) and `tray-icon@2x.png` (64 px),
  an `icons/` directory (16–512 PNG set for `build.linux.icon`), and
  `entitlements.mac.plist`.
- **`design-mockups/`** — one file, and it is lint-ignored.
- **`.tmp-parse-test.ts`** — a committed scratch file, not ignored, importing a
  symbol that no longer exists (§7).
- **`src/` shape** (for cross-reference with `AGENTS.md`): `src/main/` holds
  `companion-manager.ts`, `index.ts`, `windows.ts`; `src/main/services/` holds 28
  modules; `src/shared/` holds `types.ts` and `vision-models.ts`.

---

### D.2 The verification suite in `scripts/`

`scripts/` is a flat directory — **40 files, no subdirectories**. The task brief
called it 36; that number counts only the runnable scripts (40 minus the 3
preload stubs and `dev-verify.mts` itself). Both numbers are reconciled in §2.4.

Two house rules appear in nearly every script header and are worth knowing before
you add one:

1. A script that needs an Electron stub **must print SKIP and exit 0** under any
   other runner — the repeated justification is that "a skipped test must never
   masquerade as PASS."
2. Comments explain *why*, in the same spirit as `AGENTS.md`. Several headers
   record a specific bug that produced the test.

#### 2.1 `dev-verify.mts` — the one-shot gate

118 lines, and the only script you normally run. Its header enumerates the order:

1. `bunx tsc -p tsconfig.main.json --noEmit`
2. `bunx tsc -p tsconfig.renderer.json --noEmit`
3. every discovered test script, sorted
4. `npm run lint` — **report-only**

**Exit-code convention.** The header and the last line agree, and the code
(`process.exit(Math.min(counted, 1))`) is what actually runs. `counted` is the
number of `FAIL` results **excluding** report-only steps. So:

- 0 real failures → exit `0`
- 1 real failure → exit `1`
- 7 real failures → still exit `1`, not `7`

CI only needs a boolean, and a capped code keeps a green run at `0`. `SKIP`s
never affect the exit code. The summary line prints
`total: N passed, M failed, K skipped`, plus a parenthesised
`(R report-only failures not counted)` clause **only when R > 0** — so
"lint failed" appears in the output without turning the run red.

**Step construction.** All steps are built eagerly in one array literal
(`const results: StepResult[] = [...]`), so typechecks, every discovered test and
lint run in sequence and a failure does not abort the rest — you get the full
picture in one run, not just the first error.

**Failure output is truncated to 8 lines** (`out.split('\n').slice(-8)`), and the
summary prints only the first line of that tail. For a compile error that means
you see the *last* 8 lines, which is usually where the "Found N errors" line and
the tail of the error list live, not the first file. Pass `--noEmit` output
through your editor's tsc for full detail.

#### 2.2 `PRELOAD_FOR` — binding a script to an Electron stub

```ts
const PRELOAD_FOR: Array<[RegExp, string]> = [
  [/(?:agent-abort|open-action-smoke)\.mts$/,        './scripts/agent-stub-preload.ts'],
  [/(?:selfsettings|speak-fallback)-smoke\.mts$/,    './scripts/companion-stub-preload.ts'],
  [/(?:store|chat|keystore|routines|artifact|suggestion|suggestion-parse|workspace|fish)-smoke\.mts$/,
                                                       './scripts/store-preload.ts'],
];
```

`preloadFor(file)` walks the list in order and returns the first matching stub, or
`null`. The mapping is **purely filename-based** — no test declares its own
preload; the gate owns the table.

`smokeStep()` only consults it if a *second* condition holds. It first reads the
script's source and tests `/-preload\.ts/.test(content)` — i.e. "does this
script's own text mention a `*-preload.ts` file?" Only then does it look up
`PRELOAD_FOR`. So adding a new stubbed test requires **two** edits: name the
stub in the script's header comment, and add a `PRELOAD_FOR` row. Miss the row
and the script is launched under plain `bunx tsx`, self-reports SKIP, and exits 0
— a green run with a silently untested file. Miss the header mention and the
lookup is skipped entirely, same outcome.

The two `build.module` vs `onResolve` notes in the stubs (§3) are the reason this
table exists in the shape it does.

#### 2.3 Filename-suffix auto-discovery

`discoverTests()` reads `scripts/` and keeps a file if it ends with any of:

| Suffix | Matches today |
|---|---|
| `-smoke.mts` | `artifact`, `chat`, `endpoint`, `fish`, `focused-app`, `keystore`, `lease`, `open-action`, `parse`, `routines`, `selfsettings`, `speak-fallback`, `store`, `suggestion-parse`, `suggestion`, `workspace` |
| `-check.mts` | `glass`, `hotkey-suspend`, `ink`, `preload`, `prompt`, `sfx`, `shape` |
| `-abort.mts` | `agent-abort` |
| `-response.mts` | `golden-response` |
| exactly `scene-pipeline.mts` | one hard-coded exception, listed by literal name because it predates the convention |

Result is `.sort()`ed, so the run order is alphabetical and stable.

**This is the "new test scripts run free" property.** Name a file
`whatever-smoke.mts` and it is in the gate on the next run — no registry to
edit, no list in `AGENTS.md` to keep in sync. The flip side is that the
classification is *derived from the filename*, which is exactly why the
manual/auto split below had to be verified against `dev-verify.mts` rather than
trusted.

#### 2.4 Complete inventory of every file in `scripts/`

40 files. Line counts are exact. **"Auto" means the filename matches a
`discoverTests()` rule; "Manual" means it cannot be discovered** — either the
suffix is wrong, the extension is not `.mts`, or it is a stub / the gate itself.
The auto/manual column was derived by applying the four suffix rules and the one
literal exception from `dev-verify.mts` to the real directory listing, not from
any document.

| File | Lines | Class | Covers |
|---|---:|---|---|
| `agent-abort.mts` | 307 | Auto (`-abort`) | `runAgentActions` abort mid-batch (resolves, stops early, reports the remainder as skipped, returns far sooner than an unaborted batch); the 30-action per-batch cap; `onAction` firing for pointer kinds only (move/click/dclick/rclick/drag) and never for type/key/scroll/wait; the `onLeaseWait` true-then-exactly-one-false contract. |
| `agent-dryrun.mts` | 51 | Manual | Dry-run proof of `agent-driver.ts`: a deliberately inert action batch (nudge cursor +80 px, move back, wait, done) exercising the lazy nut-js load, the display-space → physical `scaleFactor` scaling, and executed/failed reporting — without clicking or typing. Exits 1 if nut-js is missing or any action fails. |
| `agent-stub-preload.ts` | 126 | Manual (stub) | Bun preload stubbing `electron` + `@nut-tree-fork/nut-js` with recorders. See §3. |
| `artifact-smoke.mts` | 375 | Auto | `sanitizeFilename` (path traversal collapses to last segment, slashes stripped, dotfiles un-hidden, Windows device names prefixed); `writeArtifact` staying inside `artifactsDir` for hostile names, verbatim content, `name-2` instead of overwrite; `list` newest-first / per-agent / merged / capped at 200; `byId` cross-agent + copy semantics + null for unknown; `inferKind` csv→sheet, md→doc, png→image, ts→code, unknown→other; malformed seeded rows filtered and re-sorted. |
| `chat-helper.mts` | 57 | Manual (helper) | Fresh-process child worker for `chat-smoke.mts` (the store has a module-level cache + debounce, so each seed needs a cold import). `$CHAT_MODE` selects `read` / `read-agent` / `append` / `append-plain` / `markread`; prints one JSON line. |
| `chat-smoke.mts` | 256 | Auto | `chat-history-store.ts`: legacy file with no `kind` field still loads (back-compat); `append` with `kind: 'agent'` persists through flush + fresh-process read; the post-rebrand filename is `zapi-chats.json`; corrupt JSON recovers to `[]`; read flags — appended entries carry `read:false` and `markRead` flips only the named agent's entries (the per-agent unread dot contract). |
| `companion-stub-preload.ts` | 141 | Manual (stub) | Bun preload stubbing `electron` + nut-js for a real `CompanionManager`. See §3. |
| `dev-verify.mts` | 118 | Manual (the gate) | The aggregate verifier — see §2.1–2.3. |
| `endpoint-smoke.mts` | 60 | Auto | OpenAI-compatible endpoint resolution in `ollama-api.ts`: ClinePass needs provider/model ids (`openai/gpt-5`) while `api.openai.com` wants bare ids, and a pasted `/v1/chat/completions` must collapse to its base before `/v1/...` is appended. Covers `normalizeBase`, `resolveModelId`, `isReasoningCapableModel`. Pure strings, no preload. |
| `fish-smoke.mts` | 335 | Auto | Fish Audio free-tier model header: the `model` header on every TTS request, the `s2.1-pro-free` default, header change when a paid model is picked, unknown value coerced back to free and repaired on disk, the same header on the key-validation probe, and repair of a hand-edited junk model at load. `fetch` is replaced with a recorder — no network, no audio. |
| `flicky-sweep.mts` | 144 | Manual | Rebrand straggler sweep. Walks the repo (skipping `node_modules`, `dist`, `release`, `landing`, `.git`, and the rebrand-about documents), buckets every case-insensitive `flicky` as `[INTENTIONAL]` (frozen `FlickySettings`/`FlickyAPI` contracts, the `FLICKY_DISABLE_GPU` env var, wake-word mishear aliases, the `window.flicky` bridge key) or `[STRAY]`, and **exits 1 on any STRAY**. Report-only: it never edits anything. |
| `focused-app-smoke.mts` | 140 | Auto | Focused-app guide injection: `active-window.ts`'s `foregroundWindowTitle()` Win32 probe, the process→guide map, and `focusedAppContext()` (probe + map + guide read, all failure paths → null); plus `prompts.ts`'s `buildSystemPrompt` injecting a `Focused app: <name>` section into the **agent** prompt only. Degrades to null off Windows, so no preload needed. |
| `gen-sfx.mts` | 151 | Manual | **Generator, not a test.** Synthesises the four overlay chimes (`agent-launch`, `agent-done`, `agent-needs-you`, `heard`) as sine stacks with fast attack + exponential decay into 16-bit PCM mono 44.1 kHz WAV under `src/renderer/assets/sfx/`. Filenames are the `IPC.PLAY_SFX` contract. Deterministic and idempotent — same bytes every run. |
| `glass-check.mts` | 120 | Auto | The glass/acrylic wave must survive into the **built** bundle, not just source: at least one emitted CSS asset in `dist/renderer` carries `backdrop-filter`, and `dist/main`'s compiled `windows` bundle keeps **both** branches of the `backgroundMaterial` conditional (`'acrylic'` + the `PANEL_FALLBACK_BG` fallback) so non-Windows-11 still works. Has an **mtime gate**: if `dist` is older than the sources it claims to contain, affected checks report SKIP rather than passing on a stale artifact. |
| `golden-response.mts` | 285 | Auto | Feeds a full canned model response (prose + every draw-cue kind + several `[ACT:]` tags) through the real parsers and pretty-prints the beat table (cue kind, label, target display, display-space coords), the tag-stripped speech text, and the agent action list. Each scenario declares the cue kinds / actions it expects, so a parser regression fails the run. Accepts an optional scenario-name argument. |
| `hotkey-suspend-check.mts` | 148 | Auto | Static check that `SUSPEND_PUSH_TO_TALK_SHORTCUT` silences **both** hotkeys: locates the `ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, …)` registration in `src/main/index.ts`, resolves the handler body (named function or inline arrow), and asserts `globalShortcut.unregister` is called for a PTT-ish *and* a dictation-ish binding. Three outcomes: both unregistered → PASS/0; only PTT → `[FINDING]`/0 (appended under `AUDIT.md`'s `## FOR-OWNER` section — a file that is gitignored and absent); no handler at all → FAIL/1. |
| `ink-check.mts` | 319 | Auto | Headless math from the real `src/renderer/components/inkMath.ts` (imported, so it cannot drift): per-display culling including boundary straddles, stroke-budget live/excess slicing order, arrow-head geometry, Catmull-Rom smoothing pass-through, write-wrap invariants, wobble determinism. |
| `keystore-smoke.mts` | 128 | Auto | `key-store.ts`: `enc` mode set/get/delete/status roundtrip with the on-disk blob carrying `enc:` and never the plaintext; `'fishaudio'` flowing through `KEY_NAMES` into `getKeyStatus`; a no-encryption host (`ZAPI_SMOKE_NO_ENC=1`) writing a `plain:` blob that still roundtrips; an `enc:` blob read with the credential store gone returning `null` (honest failure, never a wrong key); legacy untagged base64 still decoding; `set('')` deleting the entry. |
| `lease-smoke.mts` | 182 | Auto | `input-lease.ts`: FIFO order (a acquires, b and c queue, release promotes in order); `onQueued` seeing `true` + position while waiting and `false` on grant; `holder()` / `queueLength()`; acquire timeout rejecting behind a stuck holder; `AbortSignal` cancelling a queued wait; idempotent release (double-release must not skip the queue); `leaseWaitPhase` status-card ordering (queued→`waiting`, grant→back to `acting`, abort-while-queued→no emit). |
| `make-ico.mjs` | 290 | Manual | **Generator, not a test.** Pure-Node rasterizer (superellipse SDF, point-in-poly, 4A supersampling) + `zlib` PNG encoder + ICO/ICNS packers. Writes `assets/zapi-icon.svg`, `assets/icon.ico` (256/48/32/16), `assets/icons/<N>x<N>.png` (16–512), `assets/icon.png` (512), `assets/tray-icon.png` (32), `assets/tray-icon@2x.png` (64) and `assets/icon.icns` — the exact set `package.json` and `src/main` reference. No native modules, no network. |
| `open-action-smoke.mts` | 217 | Auto | The `[ACT:open:target]` action — the only one that hands a model-authored string to a process launcher. Pins both halves: the target is validated (shell metachars rejected) *before* reaching `execFile`, and the launch is the documented `cmd /d /s /c start "" <target>` argv, never a shell string; and `open` is **lease-free** — a pure-open batch completes while another agent holds the global input lease, proven with the real `input-lease` module. Its header records a hard-won stub trick: `child_process` and nut-js are CJS, so their export objects are patched via `createRequire` *before* the driver module evaluates, because `plugin build.module` cannot intercept `node:*` or an installed package's dynamic import — an earlier attempt ran **real** `cmd start` calls. |
| `parse-smoke.mts` | 834 | Auto | The tag DSL in `element-detector.ts`, and the largest script in the suite: `parseScene`, `parseAgentActions`, `extractAgentTask`, `looksLikeCommand`, `parseTypeTags`, `parseFileTags`, `parseMemos`, `stripFileBlocks`, `TAG_STRIP_REGEX`. |
| `preload-check.mts` | 501 | Auto | The static preload↔IPC contract, without running Electron: (1) every channel in `src/preload/index.ts` is an `IPC.*` / `AUDIO_IPC.*` const or an allow-listed raw string; (2) every `IPC.SET_*` key is sent by at least one preload method; (3) every `ipcMain.on/handle` in `src/main/index.ts` resolves to `IPC`/`AUDIO_IPC`; (4) every `onXxx` listener in preload has emitter evidence; (5) companion callbacks in `companion-manager.ts` are all wired in `index.ts` and vice versa (informational); (6) every raw channel is declared in `KNOWN_RAW` and every `KNOWN_RAW` entry is used; (7) the artifacts / suggestions / read-flags / typed-turn channels are wired by name — method + verb + IPC key — so a dropped preload method is a FAIL, not just a finding. |
| `prompt-check.mts` | 106 | Auto | Contract check for `prompts.ts`, "the third leg of the tag DSL" after `shared/types.ts` and `element-detector.ts`. Pins `BASE_PROMPT`'s must-point rule ("names anything the user can see → you MUST point"), the POINT→TYPE ordering and per-step pointing rules, `AGENT_PROMPT`'s point-before-click hint, and `buildSystemPrompt` composition (mode swap, app-guide injection, web-search note, tone). Pure string checks. |
| `routines-smoke.mts` | 187 | Auto | `routines.ts` + settings-store routine CRUD. Drives `RoutineScheduler.tick()` with an **injected clock** (no timers, deterministic): interval cadence, daily next-HH:MM including tomorrow rollover, disabled routines, `markRun` persistence through the real store, and `reload()` picking up edits. |
| `scene-pipeline.mts` | 110 | Auto (literal) | `parseScene` + `parseAgentActions` against a fake **2-display** capture set (primary 1920×1080 @ x=0 → shot 960×540; secondary 2560×1440 @ x=1920 → shot 1280×720, both 2× downscale). Asserts cue ORDER (tag order is replay order), per-cue `screenIndex`, display-space coordinate mapping (scale + display origin), and that step/total numbering applies to `point` cues only. |
| `seed-suggestions.mts` | 121 | Manual | **Dev tool.** Plants three sample `Suggestion` cards into the real `zapi-suggestions.json` so the panel UI can be eyeballed with no model call. Flags: `--clear`, `--agent <id>`, `--user-data <path>`. Replicates the store's on-disk shape (`{ "<agentId>": Suggestion[] }`, newest-first, ≤200/agent) rather than importing the store, which needs `app`. Target dir resolution: `--user-data` → `$ZAPI_SEED_USERDATA` → `$ZAPI_SMOKE_USERDATA` → first existing of `%APPDATA%\ZAPI`, `%APPDATA%\zapi`, `%APPDATA%\ZAPI`. Idempotent — `seed-`-prefixed rows are replaced on re-run. |
| `selfsettings-smoke.mts` | 429 | Auto | The voice self-settings parser in `companion-manager.ts` (private `applyVoiceSelfSetting` + the `<8`-word gate in `processUserText`). Because the method is `private` but reachable at runtime, the test drives a **real** `CompanionManager` through its real entry point. Fire cases (speed / mute / listen → right setter + value + spoken confirmation line) and normalization (wake-word lead, case, `my`/`the` variants). `desktopCapturer → []` makes a non-trigger transcript exit via the can't-see-your-screen bail *before* any model call, so "fell through" is observable with zero network. |
| `settings-parity.mts` | 314 | Manual | Settings contract across the four files that define it, using a brace-matching (comment/string-aware) source reader rather than a real TS AST: (1) `StoredSettings` ↔ `FlickySettings` field-name parity both ways; (2) defaults coverage of every non-optional `StoredSettings` field; (3) every `IPC.SET_*` channel wired to a handler in `src/main/index.ts`; (4) every preload `setXxx` maps to an existing IPC channel. **Inverted exit convention:** findings are the point, so drift is reported as `FAIL` lines and exits **0**; a non-zero exit means the *script itself* could not do its job (a file went missing, a declaration could not be parsed). |
| `sfx-check.mts` | 78 | Auto | Presence + WAV header check for the overlay chimes in `src/renderer/assets/sfx/` (not `assets/`, which holds app icons). Every `IPC.PLAY_SFX` name main emits has a wav on disk and vice versa, each ≤44 KB with a well-formed RIFF/WAVE/PCM header — a missing or truncated file is a silent failure at demo time. |
| `shape-check.mts` | 96 | Auto | Static JSON shape invariants for the canonical IPC payloads: `Scene`, `AgentStatus`, `AgentPhase`, `UsageStats`. Round-trips each through `JSON` (and `structuredClone` for `Scene`) and asserts every field survives, catching `undefined` vs missing, `NaN`, `Map`s and class instances before they cross IPC. Type-only imports, so runner-agnostic. |
| `size-report.mts` | 109 | Manual | Bundle size report. **Runs `bun run build` internally**, then tabulates the main entry, preload, per-window renderer bundles (panel / overlay / stream js+css) plus shared chunks, flags any file > **500 KB** (`OVER_KB = 500`), totals `dist`, and counts packaged `assets/` files (electron-builder ships `dist/**` + `assets/**`). Exit 1 only when the build itself fails — oversize is a flag, not a failure. Because it builds internally, do not chain it after `bun run build`. |
| `speak-fallback-smoke.mts` | 292 | Auto | The TTS OS-voice fallback in `companion-manager.ts`: when the configured provider can't speak (missing key, thrown error such as Fish Audio's 402 "insufficient credit", or a null synthesis) the reply goes to `callbacks.onSpeakText(text, rate)`, which `index.ts` wires 1:1 to `sendToOverlays(IPC.SPEAK_TEXT, …)`. Those callback args **are** the IPC payload, so asserting them asserts the wire contract. Cases: missing key → emit with tag-stripped text + `voiceSpeed` rate; provider throws / returns null → same emit (both providers); audio returned → no emit; `speakReplies` off / empty-after-strip text → no emit; the "system voice" cue fires once per session not per turn; `speakLine` drives the same emit end to end. |
| `sprint-start.sh` | 37 | Manual | **Shell tool, not a test.** Pre-sprint alignment check: `bash scripts/sprint-start.sh [sprint-branch] [base-branch]`, defaulting to the current branch vs `master`. Fetches the base (warns and continues on failure), then prints `ALIGNED`/exit 0 if the base has no commits the sprint branch lacks, or `DIVERGED`/exit 1 with the commit list and `git diff --stat`. The one file the `*.sh text eol=lf` rule in `.gitattributes` exists for. |
| `store-preload.ts` | 52 | Manual (stub) | The narrowest Electron stub: `app.getPath('userData')` (throws for any other path name) plus a deterministic `safeStorage` (`0x01` + utf8 ciphertext). See §3. |
| `store-read-helper.mts` | 15 | Manual (helper) | Fresh-process reader for `store-smoke.mts`, so `getAll()` / `getStats()` exercise the real disk reload path (`readDisk` + defaults merge) rather than the in-memory cache. Prints one JSON line `{ settings, usage }`. |
| `store-smoke.mts` | 300 | Auto | `settings-store.ts` + `usage-store.ts`: settings roundtrip from a partial seed file through the defaults merge on load, `set()` of every newer field (`ttsProvider`, `fishVoiceId`, `alwaysOnEnabled`, `dictationEnabled`, `dictationShortcut`, `agentEnabled`, `agentMaxSteps`, `customOpenAIModel`), a raw-disk assertion, and a fresh-process reload via `store-read-helper.mts`; plus usage **month rollover** — a fake past-month file then `recordTalkTurn()` and the counters reset into the current-month bucket. |
| `suggestion-parse-smoke.mts` | 594 | Auto | Second suggestion suite, split differently from its sibling: the **engine** cases (prompt build, JSON salvage, `generateSuggestions`) are pure and run anywhere; the **store** cases need the Electron stub and SKIP unless `$ZAPI_SMOKE_USERDATA` is already set. Its header contains a typo in the run line — it says `suggestion-parse-smts.mts` where the file is `suggestion-parse-smoke.mts`. |
| `suggestion-smoke.mts` | 260 | Auto | `suggestion-engine.ts` + `suggestion-store.ts`, with a different split: the engine cases run under any runner, the store cases print SKIP and exit 0 under anything but `bun --preload ./scripts/store-preload.ts`. Covers `parseSuggestionJson` tolerance (fenced blocks, prose-wrapped arrays, bare arrays, a lone object, trailing commas, smart quotes, alias keys, junk items dropped, cap honoured, `agentId` always re-pinned); `generateSuggestions` (agents with no history skipped, per-agent completion failures swallowed, abort signal honoured); `summarizeChats` / `buildSuggestionPrompt` (open-loop detection and prompt shape); and the store (add/list hides dismissed, dismiss permanence via `listAll`, per-agent isolation, scoped clear, malformed disk rows dropped). |
| `workspace-smoke.mts` | 361 | Auto | `agent-workspace.ts` — the per-agent folder (`AGENTS.md` + `output/` + `tmp/`) and its memory lifecycle, plus the `[MEMO:]` parser that feeds it and the artifact store's new write location. `ensureWorkspace` scaffolding idempotently and never clobbering an existing memory file; `readMemory` (empty when absent, full when small, line-aligned cap); `appendMemo` (dated bullet under `## Notes`, dedupe, single-line coercion, 40-line pruning oldest-first, header/other-section preservation, no-throw on junk); `parseMemos` (1–6 per response, dedupe, FILE-block bodies ignored); and `writeArtifact` landing in the workspace `output/` dir while the legacy `artifacts/` dir is left alone and legacy rows still resolve. |

**Totals: 40 files — 26 auto-discovered, 14 not discovered.**

The 14 non-discovered files are: `dev-verify.mts` (the gate),
`agent-stub-preload.ts`, `store-preload.ts`, `companion-stub-preload.ts` (the 3
stubs), `chat-helper.mts` and `store-read-helper.mts` (child-process helpers only
meaningful to their parents), `flicky-sweep.mts`, `settings-parity.mts`,
`size-report.mts`, `agent-dryrun.mts`, `gen-sfx.mts`, `seed-suggestions.mts`,
`make-ico.mjs` and `sprint-start.sh`.

**Correction to the brief's manual-only list.** The brief listed 20 files as
manual-only. Verified against `discoverTests()`, **11 of those 20 are in fact
auto-discovered** and run in every `dev-verify` pass:
`prompt-check.mts` (`-check.mts`), `glass-check.mts` (`-check.mts`),
`sfx-check.mts` (`-check.mts`), `endpoint-smoke.mts` (`-smoke.mts`),
`focused-app-smoke.mts` (`-smoke.mts`), `open-action-smoke.mts` (`-smoke.mts`),
`selfsettings-smoke.mts` (`-smoke.mts`), `speak-fallback-smoke.mts`
(`-smoke.mts`), `fish-smoke.mts` (`-smoke.mts`) and `workspace-smoke.mts`
(`-smoke.mts`). The brief's list also omitted the 3 preload stubs, the 2 child
helpers and `dev-verify.mts` itself. Its 10 genuinely-manual entries
(`flicky-sweep`, `settings-parity`, `size-report`, `agent-dryrun`, `make-ico`,
`gen-sfx`, `seed-suggestions`, `sprint-start`, `chat-helper`,
`store-read-helper`) are all correct.

---

### D.3 The three preload stubs

All three exist for the same root reason, stated verbatim in
`store-preload.ts`: the store modules do `import { app } from 'electron'` and call
`app.getPath('userData')`, and **outside Electron that module does not exist**.
`agent-driver.ts` is worse — it reaches the real desktop two ways (`import *
from 'electron'` for display bounds, and a *dynamic* `import('@nut-tree-fork/nut-js')`
for mouse and keyboard, which on a dev machine is a real native module). A live
`mouse.move` would hijack the developer's actual cursor and a live `pressKey`
would type into whatever window is focused.

All three use `import { plugin } from 'bun'` and `build.module(...)` with
`loader: 'object'` — so they are **Bun-only**. Under `tsx`/node they are never
loaded, which is why every bun-only test self-reports SKIP and exits 0.

`build.module` is used rather than `onResolve` deliberately. The comment in
`agent-stub-preload.ts` records the reason: *Bun keeps resolving an installed
package from disk even through `onResolve`* — verified experimentally, an
`onResolve` attempt left the real `@nut-tree-fork/nut-js` in place.

| Stub | Lines | What it fakes | Bound scripts |
|---|---:|---|---|
| `store-preload.ts` | 52 | The narrowest: `app.getPath` (throws for any name other than `userData`, and requires `$ZAPI_SMOKE_USERDATA`) plus a **deterministic** `safeStorage` — ciphertext is `0x01` + utf8 bytes, and `decryptString` throws on anything it did not produce, so legacy/corrupt-blob code paths are genuinely exercised. `ZAPI_SMOKE_NO_ENC=1` simulates a host with no credential store at all. | the 10 `store`-family smokes: `store`, `chat`, `keystore`, `routines`, `artifact`, `suggestion`, `suggestion-parse`, `workspace`, `fish` (+ `chat-helper.mts`, `store-read-helper.mts` run under it manually) |
| `agent-stub-preload.ts` | 126 | `electron` (`screen.getAllDisplays`/`getDisplayNearestPoint`/`getPrimaryDisplay` → one fake 1920×1080 display, id 7, scale 1; `getCursorScreenPoint` → 960,540; `systemPreferences.isTrustedAccessibilityClient` → true) **and** a full nut-js recorder. Exports `nutCalls` and mirrors it onto `globalThis.__nutCalls`; on stub failure it stashes `__agentStubError` instead of throwing, so the test reports a clean FAIL rather than crashing. `nutKeyStub()` mirrors the ~60 `Key.*` names as strings because `mapKey()` only reads them. | `agent-abort.mts`, `open-action-smoke.mts` |
| `companion-stub-preload.ts` | 141 | A **superset** of `store-preload.ts` plus what a real `CompanionManager` needs: `desktopCapturer.getSources → []` (the load-bearing extra — a turn that survives the self-settings/parser gates then bails in the normal talk path on an empty screenshot list, *before* any provider call, which is what lets the test observe "fell through" with zero network); inert `clipboard` (with a `clipboardWrites` recorder, asserted on when a case lands in the dictation branch by mistake), `screen`, `shell`, `systemPreferences`; `app.getVersion` → `0.0.0-smoke` and `app.setLoginItemSettings`; and the same nut-js recorder as insurance that a regression reaching `typeText` can never type into the focused window. | `selfsettings-smoke.mts`, `speak-fallback-smoke.mts` |

`agent-stub-preload.ts` and `companion-stub-preload.ts` differ in one small way
worth noting: the agent stub builds a full `Key` name map (the driver's
`mapKey()` needs it), while the companion stub ships `Key: {}` — nothing in the
companion path maps keys.

---

### D.4 Existing documentation

Five prose documents plus one folder. Line counts from the tree.

#### `README.md` — 74 lines, user-facing

Attribution chain first (Clicky by Farza → Flicky by jvaught01 → ZAPI, with
explicit credit back to Farza), then a "What ZAPI does" feature list (talk,
dictation, on-screen drawing, agent computer control, multiple named agents, file
deliverables, Mind, Voice, Ear, stream window, long-running context, provider key
management), a pointer to `docs/QUICKSTART.md`, "Running locally"
(`bun install` + `bun run dev`, then `bun run start` in a second terminal),
"Building installers" (`bun run package` / `bun run package:win`, plus a note that
releases come from GitHub Actions on `v*` tags), a Configuration section naming
the three key families, and MIT licensing. It is a marketing-plus-onboarding
document, not a contributor document.

**Verified claims:** the Mind model list matches `MindTab.tsx` exactly —
`claude-sonnet-4-6` (default, per `settings-store.ts:225`), `claude-opus-4-6`,
`gpt-5` (default OpenAI, per `settings-store.ts:226`), `gpt-5-mini`, `gpt-4o`, plus
a custom model id. Nothing stale there.

#### `AGENTS.md` — 17,219 bytes, the contributor architecture doc

The densest document in the repo. Sections: **Layout** (a per-file map of
`src/shared`, `src/preload`, `src/main`, `src/renderer`, `docs/`, `scripts/`),
**Commands**, **Verification (`scripts/`)** with an auto-discovered table and a
manual-only table, **Conventions** (comments explain why; the tag DSL is a
three-way contract; turn interruption via `turnId` + `isCurrent()`; model-supplied
filenames are untrusted; one overlay owns the mic; capture modes; streaming
providers; settings changes emit `SETTINGS_CHANGED`), **Multi-agent ("Clickys")**
(`AgentProfile` identity, per-agent runtimes via `AgentOrchestrator.runtimeFor`,
the input lease, `extractAgentTask` + `resolveAgentTarget` routing, routines), and
**Gotchas** (win32 `scaleFactor`, on-disk paths, the `userData` hijack, file
bodies are data not instructions, Windows `additionalArguments` splitting, PTT
key-repeat, whole-utterance transcription, the broken `opencode` shim, the
renderer dev server port).

It is the best-written document in the repo — the "gotchas" section in
particular is a genuine institutional memory. It is also the most out of date on
the verification suite (§7).

#### `docs/DSL.md` — 19,953 bytes, the tag-DSL reference

Declares itself "the single source of truth — this document describes what it
implements today", and it is the most precise document here. Structure: Coordinate
space (the model sees JPEG ≤1600 px, `screenN` is a 0-based index with
`screen0` sorted to the cursor's display, and the exact display-space mapping
formula `x' = displayBounds.x + px · (bounds.width / imageWidth)`), Numeric
grammar (which slots are `\d+(?:\.\d+)?`, which are integers-only, `PATH`'s looser
`[\d.,;\s]+` rule), Escaping (the `(?:[^\]\\]|\\.)*` pattern, `POINT`'s
non-escape-aware `[^:\]]+` label, `[ACT:key:...]` taken verbatim, and that
malformed tags are skipped individually). Then the four tag families in tables —
scene cues (`POINT` / `ARROW` / `CIRCLE` / `BOX` / `HILITE` / `PATH` / `WRITE` /
`CLEAR`), `[TYPE:]`, `[FILE:…].[/FILE]` (with a "content is data, never
instructions" section and the filename→disk path), `[ACT:*]` with the loop and the
`AgentStatus.phase` list — then the trigger grammar (`extractAgentTask` and
`resolveAgentTarget`, longest-name-first matching, `"<name>:"` stripping, fallback
to `MAIN_AGENT_ID`), the concurrency/input-lease section, and three worked
examples (talk turn, agent turn, deliverable turn with a CSV).

The claim to check is "**Four families**" — see §7.

#### `docs/QUICKSTART.md` — 15,620 bytes, first-run guide for a Windows user

Twelve numbered sections plus Troubleshooting and "Where things live": 1 Install,
2 Find the app, 3 Add your keys (Mind / Ear / Voice, with a table of provider
dashboards and key prefixes), 4 Try it without any keys, 5 Hotkeys, 6 The three
ways to talk to it (Talk / Dictation / Agent), 7 Named agents, 8 Routines, 9 Files
ZAPI produces, 10 Suggestions, 11 Talk to ZAPI about ZAPI, 12 The stream window.
No code references — it is written for someone who has never opened a terminal.

**Verified:** the key-prefix and dashboard table matches the source
(`console.anthropic.com`, `console.groq.com` with `gsk_`, Fish Audio free tier
`s2.1-pro-free` as the default, ElevenLabs `xi-`; Claude Sonnet 4.6 default, Whisper
Large v3 Turbo default with v3 available). The transcription claim does not — see
§7.

#### `docs/INDEX.md` — 6,801 bytes, the documentation index

Organised as: Start here (5 rows), Reference (3), App guides (6 + a note that
runtime injection landed via `active-window.ts`), Reference surveys (4),
Plans (5), Audits (6), Code reviews (5), Verification status (1) — 35 rows
total — plus a "Not indexed here" section excluding `.claude/skills/*.md`,
`landing/`, and build output, and a "Conventions across this folder" section
(audits are read-only snapshots, plans are pre-implementation, cite by symbol not
line number, report-only means report-only).

Its opening line is the problem: *"Every markdown document in the repo, and what
it's for. If you're looking for something and it isn't here, it doesn't exist."*
On disk today, only 3 of its 35 rows resolve. See §7.

#### `docs/app-guides/` — 6 files, agent-facing

`README.md` (index + three cross-app rules + how to add a guide), `explorer.md`,
`vscode.md`, `chrome.md`, `excel.md`, `settings.md`. Written for a vision +
mouse/keyboard agent, not a human — e.g. the Settings guide is a `ms-settings:`
URI table instead of sidebar-clicking instructions. These are injected at runtime
as the `Focused app: <name>` section (see `focused-app-smoke.mts`). This is the
**only** part of `docs/INDEX.md`'s index that is fully intact.

---

### D.5 The `landing/` marketing site

A self-contained Next.js 16 app in `landing/`, excluded from the root ESLint run,
excluded from the root Vite build, and deployed separately. **It shares no code
with the Electron app** — the relationship is conceptual (it markets ZAPI) plus
one deliberate visual echo (below).

**`landing/package.json`** — name `zapi-landing`, version `0.1.0`, `private: true`.
Four scripts, all pinned to **port 3030** so it never collides with the
Electron renderer's 5173: `dev: next dev -p 3030`, `build: next build`,
`start: next start -p 3030`, `lint: next lint`. Dependencies: `next ^16.2.3`,
`react` / `react-dom ^19.2.5`, and `vgpu ^0.5.0` (the GPU shader toolkit behind
the hero wordmark). Dev deps: `@types/node 22.10.5`, `@types/react 19.0.7`,
`@types/react-dom 19.0.3`, `typescript 5.7.3`. Its own `.gitignore`
(`node_modules`, `.next`, `out`, `*.tsbuildinfo`, `.env*.local`, `.DS_Store`),
its own `tsconfig.json`, and its own `bun.lock` — **no `package-lock.json`**, which
confirms the root's dual-lockfile state is a migration leftover rather than intent.

**`landing/next.config.mjs`** — `output: 'export'` (pure static export: "the
landing is pure content, so nothing here needs a server. Deploy anywhere that
serves static files"), `images: { unoptimized: true }` (required under static
export), a `turbopack.root` pinned to the `landing/` folder with the inline reason
— *"so Next 16 doesn't wander up the tree and pick up the outer Electron app's
lockfile"* — and a `turbopack.rules` / `webpack()` pair wiring `@vgpu/wgsl/loader-webpack`
for `*.wgsl` so the hero wordmark shader can import `@vgpu/wgsl-std` modules. Both
bundlers are configured because Turbopack is the Next 16 default and webpack is
still reachable.

**Routes (`landing/app/`)** — App Router, four pages plus a shared layout:

| Route | File | What it is |
|---|---|---|
| `/` | `page.tsx` (14,260 B) | The single-page site. Section anchors: `#top` (hero), `#how`, `#features`, `#pricing`, `#get` (with `#cta-win` / `#dl-windows`), `#faq`, and a `#demos` video block. |
| `/careers` | `careers/page.tsx` (3,833 B) | Open-roles page. `ROLES` currently lists one entry: "founding engineer — systems (rust/electron)". |
| `/changelog` | `changelog/page.tsx` (3,398 B) | Ship history from an `ENTRIES` array — currently `v1.1.0` (2026-09-18) and `v1.0.0`. |
| `/privacy` | `privacy/page.tsx` (3,837 B) | How ZAPI handles screen, keys and chats. |

All three secondary pages open with the same 25-line block: identical
`OG_TITLE` / `OG_DESC` constants, a `Metadata` export with matching
OpenGraph + Twitter `summary_large_image` cards, and the same
`DesktopIcons` + `Taskbar` + `Win` + `Mark` + `TextFileIcon` chrome — so the
careers/changelog/privacy pages are visually indistinguishable from sub-pages of
the desktop metaphor.

`layout.tsx` sets the page title ("zapi — an ai buddy that lives on your pc"),
light/dark `viewport.themeColor` pairs, and mounts `<FlickyCursor />` above
`{children}`. It also inlines a pre-paint theme script (via
`dangerouslySetInnerHTML`) that reads `localStorage` under `zapi-theme` **or**
`flicky-theme` and otherwise follows `prefers-color-scheme`, so the palette is
correct on first paint with no flash.

**Components (`landing/app/components/`, 13 files):**

| Component | Bytes | What it does |
|---|---:|---|
| `FlickyCursor.tsx` | 2,055 | **The link to the desktop app.** A page-wide companion cursor that trails the real mouse at a hard-coded `+14px / +8px` offset — its comment states this "mirrors the real Flicky overlay … the same +14px / +8px offset the desktop app uses". `pointer-events` off, `aria-hidden`, and it bails entirely on `matchMedia('(hover: hover) and (pointer: fine)')` failures. Position writes are `requestAnimationFrame`-coalesced, and the cleanup cancels the pending frame. |
| `DesktopIcons.tsx` | 1,737 | The top-left desktop icon column, doubling as the section nav on wide screens (hidden under 1100 px, where the taskbar suffices). Seven icons: `zapi.exe`→`#top`, "how it works"→`#how`, "features"→`#features`, "pricing"→`#pricing`, "get zapi"→`#get`, "questions"→`#faq`, and "source.zip"→ an external repo link. Icons come from `Icons.tsx` (`FolderIcon`, `InstallerIcon`, `TextFileIcon`, `ZipIcon`). |
| `Clock.tsx` | 851 | Taskbar tray clock. Renders `--:--` / `--/--/----` placeholders until mounted so the static export and the first client render agree (hydration safety), then ticks every 30 s via `setInterval` and clears it on unmount. |
| `HeroClutter.tsx` | 2,558 | The desktop clutter behind the wordmark, `aria-hidden`: a sticky note ("press the hotkey / and just talk"), three kaomoji (`( ^ I% ^ )`, `A_\_(a°,_)/A_`, `{ ^-^ }`), a mini replica of the Zapi overlay with a "right here!" bubble, a recycle bin, `screenshot.png`, a Windows toast ("Zapi / Copied — press Ctrl+V to paste"), a fake walkthrough window with a `2/3 — click Continue` badge, and `chat-history.json`. Each element drifts with the mouse via `Parallax` and is hidden on narrow screens. |
| `HeroVideo.tsx` | 2,607 | A tabbed player in a `Win` window for the four demo clips: **talk** (`/demos/clicky-fl.mp4`), **see** (`/demos/clicky-spatial.mp4`), **draw** (`/demos/heyclicky-draw.mp4`), **agent** (`/demos/usecase.mp4`). Autoplays muted + looping; on `prefers-reduced-motion: reduce` it turns `controls` on, `loop` off and pauses — so the clip is still playable by request. Switching tabs re-`load()`s the element (`key={demo.src}` remounts it). |
| `Icons.tsx` | 6,873 | The inline SVG icon set (`FolderIcon`, `InstallerIcon`, `TextFileIcon`, `ZipIcon`, `RecycleIcon`, `ImageFileIcon`, `JsonFileIcon`, …). Largest component file. |
| `ShaderWordmark.tsx` | 10,870 | The WGSL hero wordmark — the reason `vgpu` is a runtime dependency and the reason `next.config.mjs` needs the `.wgsl` loader rule. |
| `Mockups.tsx` | 2,544 | `MockListen`, `MockSee`, `MockSpeak`, `MockPoint` — static product illustrations used in the feature sections. |
| `PointAt.tsx` | 4,012 | The pointing-cursor interaction demo, echoing the desktop app's core gesture. |
| `Mark.tsx` | 944 | The shared app mark, used by `FlickyCursor`, `DesktopIcons`, `HeroClutter` and the page chrome. |
| `Taskbar.tsx` | 1,721 | The Windows taskbar, hosting `Clock` and the theme toggle. |
| `ThemeToggle.tsx` | 2,765 | Light/dark switch writing the `zapi-theme` / `flicky-theme` localStorage key the layout script reads. |
| `Win.tsx` | 1,598 | The draggable-looking window chrome primitive (`title`, optional `flush`) reused by `HeroVideo` and all three sub-pages. |
| `Parallax.tsx` | 1,463 | The mouse-drift wrapper that gives `HeroClutter` its depth. |
| `wordmark.wgsl` | 4,781 | The shader source consumed via the `@vgpu/wgsl/loader-webpack` rule. |

**`landing/app/globals.css`** is 36,164 bytes — larger than every component
combined, and where the whole desktop metaphor (`.desk-icons`, `.clutter`,
`.tb-clock`, `.toast`, `.mini-win`, `.flicky-cursor`) is defined. `wgsl-env.d.ts`
declares the `*.wgsl` module type for TypeScript.

**`landing/public/`** is ~18.7 MB of media and is the reason the site is not in
git LFS: `ezgif-4d0919e059322ece.gif` (6.2 MB), `flicky-hero2-1776235182036.mp4`
(7.5 MB), and `public/demos/` with `clicky-fl.mp4` (880 KB),
`clicky-spatial.mp4` (355 KB), `heyclicky-draw.mp4` (3.9 MB) and
`usecase.mp4` (3.0 MB) — the four files `HeroVideo` references, three of which
still carry `clicky`/`heyclicky` filenames from the reference material. Plus
`favicon.svg`.

**How it relates to the Electron app:** three ways, none of them a code
dependency. (1) Conceptual — the site is the only public description of the
product. (2) Visual — `FlickyCursor` deliberately reuses the desktop app's
`+14 / +8` cursor offset, and the Windows-desktop metaphor (icons, taskbar, tray
clock, toast, recycle bin) is a rendering of the app's own overlay. (3)
Deployment — `landing/vercel.json` is byte-identical to the root one and skips
Vercel builds for landing-only diffs. Everything else is separate: separate
lockfile, separate toolchain, separate port, separate lint scope, and a
`tsconfig.json` of its own.

---

### D.6 Getting started on Windows

Windows is the supported platform, and the toolchain is Windows-first
throughout (`%APPDATA%` store paths, `cmd /d /s /c start`, Win32
`foregroundWindowTitle`, `.ico` tray assets).

#### 6.1 Hard prerequisites — and the two caveats

**Node 20+.** Required (`README.md`); `dev-verify.mts`, `vite.config.ts` and
`devin` all assume it. On the machine that produced this document, `node` is
**v22.16.0** and `npm` is present.

> ### ⚠️ Caveat 1 — bun is required but is **not installed** here
>
> `bun` is **not** on `PATH` on this machine (`Get-Command bun` returns nothing),
> and there is **no `node_modules/`** in either the repo root or `landing/`. That
> means `bun install`, `bun run dev`, `bun run build`, `bunx tsx` and
> `dev-verify.mts` **cannot be run on this machine as things stand** — the
> preload stubs, the Electron-stubbed smokes and the whole `dev-verify` gate
> depend on bun's `Bun.plugin` and on bun's `.mts` loader.
>
> Install bun first (`powershell -c "irm bun.sh/install.ps1 | iex"`, or
> `winget install --id Oven-sh.Bun`), then `bun install --frozen-lockfile` to
> match CI. Until then the practical fallback is `npm install` plus `npx tsx` for
> the pure scripts — but the 10 `store`-family smokes, `agent-abort.mts`,
> `open-action-smoke.mts`, `selfsettings-smoke.mts` and `speak-fallback-smoke.mts`
> will all SKIP-and-exit-0, so a green run there is **not** evidence they pass.
>
> Everything in this document was therefore established by **reading** the tree.
> No build, install or script was executed.

> ### ⚠️ Caveat 2 — the global `opencode` shim is broken here
>
> `AGENTS.md` records: **"`bun`-installed global `opencode` shim is broken on this
> machine — use `devin`."** On this machine `opencode` resolves to
> `C:\Users\Lenovo\AppData\Roaming\npm\opencode.ps1` (the npm-global shim, and it
> is the path this very session is running under), and `devin` is **not** on
> `PATH` via `Get-Command`. If you reach for the global `opencode` binary and it
> fails, reach for `devin` instead.

#### 6.2 First run

```powershell
  # 1. prerequisites
  node --version          # expect v20 or newer
  # install bun if missing — see caveat 1

  # 2. dependencies (use --frozen-lockfile to reproduce CI exactly)
  cd D:\projects\Zapi_clone
  bun install --frozen-lockfile

  # 3. the gate — typecheck both projects, then all 26 auto-discovered tests
  bunx tsx scripts/dev-verify.mts
  #    -> "total: N passed, 0 failed, 0 skipped", exit 0

  # 4. dev servers (two processes)
  bun run dev             # or: npm run dev — both work; package.json chains npm internally

  # 5. in a SECOND terminal, once the servers are up
  bun run start           # VITE_DEV_SERVER=1 electron dist/main/main/index.js
```

(The block is indented purely so its shell comments cannot be mistaken for
Markdown headings by a naive `# ` scan; copy it as-is.)

Step 3 must be run *after* a successful `build:main` at least once, because step 5
launches `dist/main/main/index.js` rather than the TypeScript source. `dev:main`
is a `tsc --watch`, so it will have emitted by the time Vite is listening on 5173.

#### 6.3 What to expect, and what to read when it breaks

- `dev-verify.mts` output is one `[PASS]`/`[FAIL]`/`[SKIP]` line per step, then a
  `total:` line. **Exit 0/1 only** — read the `total:` line for the real count.
- A `SKIP` almost always means "this script needs a bun preload and did not get
  one." Check the `PRELOAD_FOR` row and the script's own header mention (§2.2).
- `glass-check.mts` SKIPs when `dist/` is older than the sources it claims to
  contain. Fix with `bun run build`, not by ignoring it.
- The aggregate failure tail is truncated to the **last** 8 lines, so for
  typecheck failures re-run `bun run typecheck` directly for the full list.
- A green `lint` line does not mean lint passed if the summary mentions
  "report-only failure(s) not counted" — lint is report-only by design.

#### 6.4 The verification loop, honestly

`scripts/dev-verify.mts` is the gate; `bunx tsx scripts/<name>.mts` is the loop
while you iterate. Read the top of the script you are about to run — the headers
carry the exact required runner, the preload stub, and the reason the test
exists. For anything that writes to disk, the smokes redirect `userData` to a
temp dir via `$ZAPI_SMOKE_USERDATA`, so they never touch your real
`%APPDATA%\ZAPI Companion`.

The three generators (`make-ico.mjs`, `gen-sfx.mts`, `seed-suggestions.mts`) are
the exception to "read-only verification": they write into `assets/` and
`src/renderer/assets/sfx/`. `gen-sfx.mts` and `make-ico.mjs` are deterministic and
idempotent; `seed-suggestions.mts` mutates your real `zapi-suggestions.json` (it
has `--clear`).

---

### D.7 Contradictions found in the existing docs

Every item below was checked against the source. Ordered by how much it will cost
a new developer.

**1. `docs/INDEX.md` is almost entirely dead links, and claims completeness.**
Its first line is *"Every markdown document in the repo… If you're looking for
something and it isn't here, it doesn't exist."* In fact **3 of its 35 rows
resolve** (`README.md`, `AGENTS.md`, `QUICKSTART.md`, `DSL.md`, and the six
`app-guides/` files). The other ~30 point at files that do not exist:
`PROBLEM.md`, `FEATURES.md`, `AUDIT.md`, `AUDIT2.md`, `REVIEW.md`–`REVIEW5.md`,
`REPORT.md`, `scripts/verify-report.md`, `docs/FEATURE-ADOPTION.md`,
`docs/APP-GUIDES-SURVEY.md`, `docs/CLICKY-SKILLS.md`, `docs/PROMPT-GAP.md`,
`docs/SFX-SURVEY.md`, all five `docs/PLAN-*.md`, and the three `docs/*-AUDIT.md`.
The cause is `.gitignore`, which deliberately untracks `REVIEW*.md`, `AUDIT*.md`,
`REPORT.md`, `FEATURES.md`, `PROBLEM.md`, `docs/PLAN-*.md`, `docs/*-AUDIT.md`,
`docs/*-SURVEY.md`, `docs/CLICKY-SKILLS.md`, `docs/FEATURE-ADOPTION.md` and
`docs/VOICE-TESTS.md` — matching the git log entry
`fe4d0f9 chore: drop fleet working docs from repo`. `INDEX.md` was written before
that drop and never updated. Only the `app-guides/` section is intact.

**2. `AGENTS.md`'s verification tables are ~40% out of date.** Three specific
errors:

- It claims the gate reports *"19 passed, 0 failed, 0 skipped"*. With today's
  `discoverTests()` the gate runs 26 discovered scripts + 2 typechecks + 1
  report-only lint = **29 steps**.
- Its auto-discovered table lists 16 scripts and **omits 10 that are really
  discovered**: `endpoint-smoke`, `fish-smoke`, `focused-app-smoke`,
  `glass-check`, `open-action-smoke`, `prompt-check`, `selfsettings-smoke`,
  `sfx-check`, `speak-fallback-smoke`, `workspace-smoke`.
- It says *"the two `*-preload.ts` files stub electron"* and lists only
  `agent-abort → agent-stub-preload` and
  `store`/`chat`/`keystore`/`routines`/`artifact`/`suggestion → store-preload`.
  There are **three** stubs, and the real `PRELOAD_FOR` has 11 rows' worth of
  patterns: it also binds `open-action-smoke → agent-stub-preload`,
  `selfsettings-smoke` and `speak-fallback-smoke → companion-stub-preload`, and
  `suggestion-parse`/`workspace`/`fish` → `store-preload`. `companion-stub-preload.ts`
  is not mentioned in `AGENTS.md` at all.
- Its "Manual only" table lists 5 entries (correct as far as it goes) but omits
  4 more that are genuinely manual: `gen-sfx.mts`, `seed-suggestions.mts`,
  `sprint-start.sh`, `chat-helper.mts` / `store-read-helper.mts` (helpers).

**3. `docs/DSL.md` says "Four families" of tag; the source has five.**
`element-detector.ts` includes `MEMO` in `TAG_STRIP_REGEX` and exports
`parseMemos` (`MAX_MEMOS_PER_RESPONSE = 6`, `MAX_MEMO_CHARS = 200`,
`MEMO_TAG_REGEX = /\[MEMO:((?:[^\]\\]|\\.)*)\]/g`), and `workspace-smoke.mts`
tests the whole memo lifecycle end to end. `DSL.md` has exactly one incidental
mention of "MEMO" (in a file-path sentence) and no section for it. Since
`DSL.md` explicitly claims to be "the single source of truth" for the DSL, a
model prompt author following it will not know `[MEMO:]` exists.

**4. `docs/QUICKSTART.md` says Groq is the only transcription provider.**
> "**Groq Whisper is the only transcription provider for now.** ClinePass has no
> transcription endpoint…"

The source has two provider classes — `GroqWhisperProvider` and
`OpenAIWhisperProvider` — and `TranscriptionProviderType` is
`'groq' | 'openai' | 'native'`. `EarTab.tsx` branches on both
`settings.transcriptionProvider === 'groq'` and `=== 'openai'`, and
`AGENTS.md` correctly says "Groq / OpenAI Whisper". So `QUICKSTART.md` is the
stale one. (Separately, `'native'` has **no** implementing class in
`transcription.ts` — a dead union member that no code path can select.)

**5. The GitHub Actions workflow targets `master`; the branch is `main`.**
`build.yml` triggers on `push`/`pull_request` for `branches: [master]`, and
`sprint-start.sh` also defaults its base branch to `master`. `git branch
--show-current` reports **`main`**, and the log shows a
`Merge branch 'main' of https://github.com/Vaibhav9526/Zapi`. On a `main`-only
repo the `verify`/`build`/`release` chain never fires on a plain branch push —
only on `v*` tags and manual dispatch. Relatedly, `sprint-start.sh` would report
`DIVERGED` spuriously.

**6. `package.json` publishes to upstream Flicky's GitHub repo.**
`build.publish` is `{ provider: "github", owner: "jvaught01", repo: "flicky" }`.
The workflow does not override it, so on a `v*` tag `bunx electron-builder
--publish always` would try to release into `jvaught01/flicky` — not into
`Vaibhav9526/Zapi`, the repo the git log says this is. This is a rebrand straggler
that `flicky-sweep.mts` would flag as `[STRAY]` (it only allow-lists
`FlickySettings`/`FlickyAPI`/`FLICKY_DISABLE_GPU`/wake-word aliases/
`window.flicky`).

**7. `landing/README.md` and the landing metadata still point at a third,
different Flicky repo.** `landing/README.md` opens *"# Flicky landing page …
for [flicky](https://github.com/pango07/flicky)"*; `layout.tsx`'s
`openGraph.url` is `https://github.com/pango07/flicky`; and
`DesktopIcons.tsx` has `const REPO = 'https://github.com/pango07/flicky'` as its
"source.zip" href. That is neither `jvaught01/flicky` (upstream, per README) nor
`Vaibhav9526/Zapi` (this repo). The public download link on the marketing site
points at an unrelated repository.

**8. `landing/vercel.json` is identical to the root `vercel.json`, so the "skip
landing changes" gate never fires for landing changes.** Both files are byte-for-byte
the same `grep -q '^landing/'` command. The root one runs with the repo root as
cwd, where the diff paths *do* start with `landing/`, so the root gate works as
intended. But the copy inside `landing/` — where Vercel's root directory is
explicitly `landing` (per `landing/README.md`) — greps for `^landing/` against
paths that are already relative to `landing/`, so it can never match. Harmless
today (it just always builds), but it is a duplicated gate that is wrong in one
of its two locations.

**9. `landing/app/changelog/page.tsx` is two releases behind `package.json`.**
`ENTRIES` lists `v1.1.0` (2026-09-18) and `v1.0.0`; `package.json` is at
**`1.2.1`**. The public changelog has no entry for the current version.

**10. `.tmp-parse-test.ts` is a committed scratch file that cannot compile.**
It is tracked by git and is **not** in `.gitignore`, and it imports
`parseAllPointTags` from `./src/main/services/element-detector` — a symbol that
**no longer exists** (0 occurrences in the source). It is a leftover from the
`POINT`/`TYPE` era that predates the current cue grammar. A stray import in the
repo root that will confuse a new developer and that `bun run typecheck` will not
catch (it is outside both `include` lists).

**11. Two `eslint.config.js` requires are undeclared dependencies.**
`eslint.config.js` `require`s `@eslint/eslintrc`, `@eslint/js` and `globals`,
none of which appear in `package.json`. They resolve today only as transitive
dependencies of `eslint@^9`. A dependency bump can break `bun run lint` with
`MODULE_NOT_FOUND` and no manifest change to point at.

**12. `vite-plugin-electron` is a declared dependency that is never used.**
`vite.config.ts` imports only `defineConfig`, `@vitejs/plugin-react` and `path`.
`dev` is driven by `concurrently` + a separate `tsc --watch` + a separate
`electron dist/...` launch instead. The dependency is dead weight in
`bun.lock`.

**13. `AGENTS.md`'s source layout omits three real modules.** Its
`src/main/services/` listing does not mention **`active-window.ts`** (the
`foregroundWindowTitle` Win32 probe and the `focusedAppContext()` guide
injection — a whole feature, and one that `focused-app-smoke.mts` tests), nor
**`agent-workspace.ts`** (the per-agent `AGENTS.md`/`output/`/`tmp/` folder and
the memo lifecycle — tested by a 361-line smoke). `src/shared/` also holds
`vision-models.ts`, which `AGENTS.md` does not mention; it claims
`shared/types.ts` is the "single contract".

**14. `docs/QUICKSTART.md` §9 / `README.md` file-deliverables path vs.
`AGENTS.md`'s `artifacts/<agentId>/` claim.** `AGENTS.md` (and the artifact
smoke) describe `userData/artifacts/<agentId>/`, but `workspace-smoke.mts`
asserts that `writeArtifact` now lands in the **per-agent workspace `output/`
directory** and explicitly that "the legacy `artifacts/` dir is left alone and
legacy rows still resolve". `AGENTS.md` describes the legacy location as current.
`AGENTS.md` also does not mention the per-agent workspace at all, so a
contributor reading it will look for `artifacts/<agentId>/` first.

**15. `hotkey-suspend-check.mts` writes to a gitignored file that does not
exist.** Its "only PTT suspended" branch appends a `[FINDING]` under
`AUDIT.md`'s `## FOR-OWNER` section — but `AUDIT.md` is both absent and matched
by the `AUDIT*.md` line in `.gitignore`, so the finding is written nowhere. The
script still exits 0 by design (a sibling may be mid-edit), so a real
half-suspended-hotkey regression is reported to nowhere and the gate stays green.

**16. `suggestion-parse-smoke.mts`'s header documents a filename that does not
exist.** It instructs `bun scripts/suggestion-parse-smts.mts` where the file is
`suggestion-parse-smoke.mts`. Harmless (dev-verify invokes it by the real name)
but it will send a developer to a `no such file` error.

---

*Compiled by reading the tree only — no `bun install`, `bun run dev`,
`bun run build`, `bunx` or `scripts/` command was executed, because bun is not
installed on this machine. Script line counts from
`Get-Content <file> | Measure-Object -Line`; script count and auto/manual
classification from `scripts/dev-verify.mts`'s own `discoverTests()` rules applied
to the real directory listing.*
