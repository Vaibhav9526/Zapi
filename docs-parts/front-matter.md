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
