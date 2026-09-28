# ZAPI

Windows-first Electron 33 + React 19 + TypeScript desktop AI companion (fork of the
upstream Flicky project).
Talk mode with on-screen drawing, agent mode (computer control via nut-js), always-on
listening, dictation, and multiple named agents ("Clickys") that can each run their own
turns, schedules, and file deliverables — parity target is heyclicky.com.

## Layout

```
src/shared/types.ts     single contract: IPC channel map, FlickySettings, Scene/SceneCue,
                        AgentAction/AgentStatus, CaptureMode, UsageStats, DisplayInfo.
                        Main, preload, and renderer all import from here.
src/preload/index.ts    contextBridge surface — window.flicky. One-to-one with IPC channels.
src/main/
  index.ts              app entry: tray + menu, global PTT shortcut (hold/toggle), IPC
                        routing, window lifecycle, overlay→display routing tables.
  companion-manager.ts  the turn pipeline: PTT / VAD utterance → transcribe →
                        voice self-settings → dictation → agent routing → talk
                        turn → scene scheduler + TTS. Owns turnId ++
                        AbortController interruption; every async callback gates
                        on isCurrent(). Also holds applyVoiceSelfSetting (the
                        spoken "talk slower" / "be quiet" / "mute my routines"
                        commands — no module of its own, they route through the
                        same setters as the panel/tray so SETTINGS_CHANGED still
                        fires) plus runTextTurn / acceptSuggestion /
                        refreshSuggestions. The agent loop itself lives in
                        agent-orchestrator — this file builds the deps for the
                        'main' runtime.
  windows.ts            factories: panel window, per-display transparent overlay,
                        draggable stream window.
  services/
    element-detector.ts the tag DSL: parseScene / parseAgentActions / parseTypeTags /
                        parseFileTags / stripFileBlocks / extractAgentTask / TAG_STRIP_REGEX.
                        See docs/DSL.md.
    agent-orchestrator.ts AgentRuntime (one per agent: the screenshot→plan→act loop,
                        turn state, status emission) + AgentOrchestrator (the
                        lazy runtime registry; stop(id?) / getStatus(id)).
    agent-driver.ts     executes [ACT:*] via @nut-tree-fork/nut-js (lazy-loaded).
    input-lease.ts      global FIFO mutex around physical input. Agents reason in
                        parallel; only nut-js actions serialize. 60 s wait timeout,
                        abort-aware, pure module state (smoke-testable).
    routines.ts         RoutineScheduler: one 15 s tick evaluates every routine
                        (interval / daily HH:MM), so upserts and enable flips need
                        no restart. Zero Electron deps.
    prompts.ts          system prompts — BASE_PROMPT (talk+draw DSL) and AGENT_PROMPT.
    claude-api.ts / openai-api.ts / ollama-api.ts
                        Mind providers; streamChat(prompt, screenshots, history, model,
                        {reasoningDepth, replyTone, signal, mode}, callbacks).
    transcription.ts    Groq / OpenAI Whisper; providers buffer PCM16 and transcribe on
                        stop(); transcribeWith(provider, pcm) for finished VAD utterances.
    screen-capture.ts   desktopCapturer → JPEG ≤1600px, sorted cursor-display-first.
    elevenlabs-tts.ts / fish-audio-tts.ts   speakReplies providers (settings.ttsProvider).
    auto-typer.ts       nut-js typing for [TYPE:] tags + dictation auto-type.
    settings-store.ts   zapi-settings.json in userData (in-memory cache, atomic writes).
    key-store.ts        API keys via safeStorage → zapi-keys.json (enc:/plain: prefixes).
    chat-history-store.ts   bounded per-agent chat log → zapi-chats.json in userData.
    usage-store.ts      monthly counters → zapi-usage.json (talkTurns/agentMessages/
                        dictationUtterances, plus a perAgent row keyed by
                        AgentProfile.id); best-effort, swallows IO errors.
    artifact-store.ts   files agents produced. Writes into
                        userData/artifacts/<agentId>/, keeps metadata in
                        zapi-artifacts.json (200 entries/agent, debounced atomic
                        flush). Owns sanitizeFilename / sanitizeAgentSegment /
                        uniquePath (a re-run yields `name-2.csv`, never a silent
                        overwrite) and inferKind (extension → sheet|doc|image|code|other).
    suggestion-store.ts  dismissed/proposed task cards → zapi-suggestions.json,
                        same cache-then-flush shape as the chat/artifact stores.
                        Dismissals are permanent — list() hides them, the file keeps them.
    suggestion-engine.ts  stateless: per agent, builds a prompt from that agent's
                        recent chat, one Mind completion, then parses JSON back into
                        Suggestion[] (default cap 5/agent). Persistence is the caller's job.
    context-manager.ts  rolling token-budgeted history w/ auto-compaction summaries.
    audio-capture.ts    just the AUDIO_IPC channel names (capture lives in the overlay).
    key-validation.ts, gpu-guard.ts, fs-util.ts, analytics.ts (PostHog, lazy).
src/renderer/
  overlay.tsx + components/OverlayApp.tsx    per-display transparent click-through window:
                        companion cursor, InkLayer strokes, mic capture + VAD, TTS playback.
  audio-capture-worklet.js   AudioWorklet → PCM16 mono 16 kHz to main.
  panel.tsx + components/panel/*             settings UI (Mind/Ear/Voice/General/Home/Chats,
                        onboarding, Ollama management, NewAgentModal, RoutineModal).
                        HomeTab is the multi-agent surface: agent cards (status,
                        unread dot, artifact pile), routines block, suggestions block.
  stream.tsx + components/StreamApp.tsx      live Q/A rail + agent status/stop
                        button + artifact pile + suggestion strip.
docs/
  DSL.md               the tag DSL reference — scene cues, [ACT:*], [FILE:*],
                        extractAgentTask, the 'waiting' phase, the input lease.
  QUICKSTART.md        user-facing first-run guide. Plain language, no code
                        references; every claim is checked against the tree, so
                        it goes stale the moment a default or a label changes.
scripts/               verification suite — see §Commands. dev-verify.mts is the
                        aggregate gate; the two *-preload.ts files stub electron
                        so store modules import outside a running app.
```

## Commands

```sh
bun install                 # deps (bun.lock is the lockfile)
bun run dev                 # tsc --watch (main) + vite dev (renderer) in parallel
bun run build               # build:main (tsc) + build:renderer (vite)
bun run typecheck           # tsc -p tsconfig.main.json --noEmit && renderer tsconfig
bun run lint                # eslint src
bun run start               # electron dist/main/main/index.js with VITE_DEV_SERVER=1
npm run package:win         # build + electron-builder --win (nsis)
```

### Verification (scripts/)

`dev-verify.mts` is the one-shot gate — it runs both typechecks, then every
`*-smoke` / `*-check` / `*-abort` / `*-response` script plus `scene-pipeline.mts`
(discovered by filename, so new test scripts run free), then `npm run lint`
report-only. Exit code = number of real failures, capped at 1.

```sh
bunx tsx scripts/dev-verify.mts        # 19 passed, 0 failed, 0 skipped
```

Scripts that need a bun Electron stub are matched to their preload by name
(`PRELOAD_FOR` in `dev-verify.mts`): `agent-abort.mts` → `agent-stub-preload.ts`;
`store` / `chat` / `keystore` / `routines` / `artifact` / `suggestion` smokes →
`store-preload.ts`. Everything else runs under `bunx tsx`.

**Auto-discovered** (matched by the suffixes above — these run inside dev-verify):

| Script | Covers |
|---|---|
| `agent-abort.mts` | agent-run abort/interrupt paths (stubs Electron) |
| `artifact-smoke.mts` | `sanitizeFilename`, `inferKind`, `uniquePath`, dir layout |
| `chat-smoke.mts` | chat store, incl. the legacy `flicky-chat-history.json` migration |
| `golden-response.mts` | a canned provider response through the full tag-DSL parse |
| `hotkey-suspend-check.mts` | PTT / suspend lifecycle |
| `ink-check.mts` | headless math from `renderer/components/inkMath.ts` — per-display culling (incl. boundary straddles), stroke budget, arrow geometry, smoothing, write-wrap |
| `keystore-smoke.mts` | safeStorage + `plain:` fallback paths |
| `lease-smoke.mts` | input-lease FIFO, timeout, abort, idempotent release |
| `parse-smoke.mts` | the tag DSL: scenes, `[ACT:*]`, `[FILE:]`, trigger grammar |
| `preload-check.mts` | every `IPC.*` key has a live sender; every preload channel resolves (both directions, incl. `ipcRenderer.on` pairs) |
| `routines-smoke.mts` | `RoutineScheduler` interval/daily due logic |
| `scene-pipeline.mts` | scene/cue → display-space mapping |
| `shape-check.mts` | `Scene` / `SceneCue` / `AgentAction` shape invariants |
| `store-smoke.mts` | the settings/usage JSON stores |
| `suggestion-smoke.mts` / `suggestion-parse-smoke.mts` | suggestion store lifecycle / JSON salvage + open-loop detection |

**Manual only** — these names don't match a discovery suffix, so dev-verify
skips them. Run them by hand:

| Script | Covers |
|---|---|
| `flicky-sweep.mts` | classifies every `flicky` hit as intentional vs **stray** (attribution leftovers); exits 1 on a stray |
| `settings-parity.mts` | `StoredSettings` ↔ `FlickySettings` field-name parity, both ways |
| `size-report.mts` | bundle sizes vs the 500 KB budget (re-runs the build internally, so don't chain it after `bun run build`) |
| `agent-dryrun.mts` | agent loop dry run |
| `make-ico.mjs` | regenerates `assets/icon.ico` from a PNG |

Preload stubs (`store-preload.ts`, `agent-stub-preload.ts`) fake `electron` so a
store module can be imported outside a running app — that's why those smokes are
bun-only.

## Conventions

- **Comments explain why**, not what — most non-obvious lines carry the bug/motive that
  produced them. Keep that habit; delete nothing silently.
- **The tag DSL is a three-way contract**: `shared/types.ts` shapes, `element-detector.ts`
  regexes/mappers, and `prompts.ts` prompt text must move together. Same for IPC —
  `IPC` in shared/types.ts + preload surface + index.ts handlers.
- **Turn interruption**: `turnId` bumps on every new turn (PTT press or VAD utterance);
  the in-flight turn's `AbortController` is aborted. Any async callback that mutates UI
  state must gate on `isCurrent()` — no stale chunks, chat entries, or TTS. The same gate
  applies per agent runtime: an aborted background run must not resurrect a status card.
- **Model-supplied filenames are untrusted**: everything a model writes goes through
  `artifact-store`'s sanitizer + the `path.dirname` assertion in `writeArtifact` before it
  touches disk. Never `path.join(userData, modelString)` by hand.
- **Overlays are one-per-display, transparent, click-through**
  (`setIgnoreMouseEvents(true, {forward:true})`), always-on-top at screen-saver level.
  Mic capture is sent to exactly ONE overlay — never broadcast (double audio broke
  transcription historically). Scene cues route to the overlay containing the first
  cue's anchor; clears broadcast.
- **Capture modes**: `onStartAudioCapture('ptt')` streams raw chunks to main;
  `'vad'` runs the overlay-side VAD which ships finished utterances as `VAD_UTTERANCE`
  (PCM16 mono 16 kHz). Always-on = vad; PTT reuses the same gate in ptt mode.
- **Streaming providers** share one call shape; `mode: 'talk' | 'agent'` in options picks
  which system prompt buildSystemPrompt emits. Don't bypass providers with ad-hoc fetches.
- Settings changes emit `SETTINGS_CHANGED` and rebuild the tray menu — add new settings
  through `settings-store` fields + a companion setter + an IPC channel, not ad hoc.

## Multi-agent ("Clickys")

- **`AgentProfile`** (`shared/types.ts`) is the identity of an agent: `id` (a user-authored
  slug), `name`, `kaomoji`, `color`, `archived`. Profiles live inside the settings payload
  (`FlickySettings.agents`), so they go through `settings-store` + `SETTINGS_CHANGED` like any
  other setting — never a separate file. `MAIN_AGENT_ID` (`'main'`) is the default profile.
- **Per-agent runtimes.** `AgentOrchestrator.runtimeFor(id)` lazily creates and *caches* one
  `AgentRuntime` per agent id, so renaming or archiving a profile doesn't kill an in-flight run.
  The loop itself takes its collaborators through `AgentRuntimeDeps`: the `'main'` runtime is
  wired to `CompanionManager`'s own turn id / abort controller / voice state (that's what keeps
  the classic pipeline byte-identical), while background runtimes get a private
  `LocalTurnControl`. Only the mic-owning runtime may clear scenes and speak — a background
  agent talking over the user, or wiping the foreground agent's ink, are both bugs.
- **Input lease.** `input-lease.ts` is a module-level FIFO mutex around nut-js. It is taken for
  a whole action batch (not per action) and skipped when the batch is only `done`/`fail`, so a
  batch is never interleaved. Agents *reason* concurrently and only *act* serially. A waiter
  surfaces as `AGENT_STATUS` phase `'waiting'` via the driver's `onLeaseWait` hook.
- **Routing.** `extractAgentTask` (element-detector) decides *whether* an utterance is an agent
  turn and strips the trigger; `CompanionManager.resolveAgentTarget` then decides *which*
  profile — it matches profile names in the transcript longest-name-first and strips a leading
  `"<name>:"`, so **"zapi agent scout: open notepad"** lands on Scout's card with the task
  "open notepad". An unrecognized name falls back to `MAIN_AGENT_ID` rather than dropping the
  request. See docs/DSL.md for the trigger grammar.
- **Routines.** `Routine` is an agent-owned scheduled task (`interval` or `daily` HH:MM) that
  runs as a normal talk turn on its own agent. `RoutineScheduler` fires them from one 15 s tick;
  `companion-manager` skips a due routine while the user is mid-turn, and `routinesMuted`
  silences only the completion announcement, never the run.

## Gotchas

- **win32 scaleFactor**: Electron reports display bounds in DIP; nut-js positions the
  cursor in physical pixels. agent-driver multiplies by `display.scaleFactor` — without
  it clicks land wrong on 125%/150% scaled displays. Screenshot→display mapping lives in
  element-detector (`shotToDisplay`); the two conventions must stay consistent.
- **Settings/keys on disk**: `userData/zapi-settings.json`, `zapi-keys.json`,
  `zapi-usage.json`, `zapi-chats.json`, `zapi-artifacts.json`, `zapi-suggestions.json`,
  `gpu-state.json` (post-rebrand names; pre-rebrand installs are not migrated, so an old
  chat log is simply left behind). Agent-produced *files* are a separate tree —
  `userData/artifacts/<agentId>/`, one sanitized directory per agent id, created on demand.
  When safeStorage is unavailable, keys are stored as `plain:` base64 — check
  `encryptionAvailable` before promising encryption.
- **`userData` is hijacked at module scope.** The package name `zapi` resolves it to
  `%APPDATA%\zapi`, which a *different installed app already owns*. `index.ts` claims
  `%APPDATA%\ZAPI Companion` in a top-level block and migrates our six known JSON files
  plus the `artifacts/` tree. This must stay above every `app.getPath('userData')` read —
  moving it into `whenReady` silently splits the stores across two directories.
- **File bodies are data, not instructions.** `parseAgentActions` must be fed
  `stripFileBlocks(text)`, never the raw reply — otherwise an `[ACT:key:enter]` inside a
  python file the model wrote executes against the user's machine.
- **Windows `additionalArguments` split on spaces** — the display-info JSON handed to
  overlays via `DISPLAY_INFO_ARG_PREFIX` must stay purely numeric (see windows.ts).
- **PTT 'hold' mode relies on OS key-repeat**: debounce grace is 1100 ms for the first
  repeat then 250 ms; macOS forces 'toggle' because globalShortcut has no key-up event.
- **Transcription providers buffer whole utterances** — there is no partial-transcript
  channel at all. `stop()` returns the final transcript and the turn blocks on it; every
  provider (Groq / OpenAI) is a whole-file upload, so live captions would need a streaming
  provider that does not exist yet. Don't reintroduce `onPartialTranscript`.
- **`bun`-installed global `opencode` shim is broken** on this machine — use `devin`.
- Renderer dev server assumed at `localhost:5173` when `VITE_DEV_SERVER=1`.
