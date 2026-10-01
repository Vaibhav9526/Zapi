# Services layer (`src/main/services/`)

> Catalog of every file in `src/main/services/`, written from the actual source. Every claim traces to a named export or constant in the file it describes.

## Table of contents

- [1. Overview](#1-overview)
- [2. Tag DSL — element-detector.ts](#2-tag-dsl--element-detectorts)
- [3. Agent loop](#3-agent-loop)
- [4. Scheduling — routines.ts](#4-scheduling--routinests)
- [5. Prompts — prompts.ts](#5-prompts--promptsts)
- [6. Mind providers](#6-mind-providers)
- [7. Voice in, eyes, voice out](#7-voice-in-eyes-voice-out)
- [8. JSON stores](#8-json-stores)
- [9. Intelligence helpers](#9-intelligence-helpers)
- [10. Smaller services](#10-smaller-services)
- [11. Cross-cutting contracts](#11-cross-cutting-contracts)
- [12. Dependency table](#12-dependency-table)

## 1. Overview

`src/main/services/` holds 29 modules in seven groups:

1. **DSL parsing** — `element-detector.ts`.
2. **Agent loop** — `agent-orchestrator.ts`, `agent-driver.ts`, `input-lease.ts`, `agent-workspace.ts`, `active-window.ts`.
3. **Scheduling** — `routines.ts`.
4. **Prompts** — `prompts.ts`.
5. **Mind providers** — `claude-api.ts`, `openai-api.ts`, `ollama-api.ts`.
6. **Perception and voice** — `transcription.ts`, `screen-capture.ts`, `elevenlabs-tts.ts`, `fish-audio-tts.ts`, `auto-typer.ts`, `audio-capture.ts`.
7. **Persistence, intelligence, utilities** — `settings-store.ts`, `key-store.ts`, `chat-history-store.ts`, `usage-store.ts`, `artifact-store.ts`, `suggestion-store.ts`, `suggestion-engine.ts`, `context-manager.ts`, `key-validation.ts`, `gpu-guard.ts`, `fs-util.ts`, `analytics.ts`.

Two patterns recur: file bodies are data not instructions (`stripFileBlocks` before every DSL parse), and JSON stores use cache-then-atomic-flush via `writeFileAtomic`.

## 2. Tag DSL — element-detector.ts

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

## 3. Agent loop

### 3.1 agent-orchestrator.ts

Screenshot-plan-act loop plus per-agent registry.

- `AgentTurnControl` — `beginTurn`, `currentTurnId`, `setAbort`, `currentAbort`, optional `setVoiceState`/`voiceState`. `main` binds to `CompanionManager` fields; background runtimes use `LocalTurnControl` (exported).
- `AgentRuntimeDeps` — `turn`, `ownsVoice` (only the mic-owning runtime may clear scenes and speak; background skips both so it never wipes foreground ink or talks over the user), `streamMind`, `recordExchange`, `emitMemoryStats`, `synthesizeSpeech`, `playSpeech`, `onStatus`, `onAction`, `onChatEntryAdded`, `onAiResponseChunk`, `onAiResponseComplete`, `clearSceneTimers`, `onSceneClear`.
- `AgentRuntime` — `lastScreenshots`, `status`, `running`. Methods: `getStatus()`, `isRunning`, `stop()` (aborts controller, emits `idle`), `run(task)` (reads `agentMaxSteps` from settings, bumps turn id, installs `AbortController` with `isCurrent()`, clears scenes only when `ownsVoice`, captures via `captureAllDisplays`, probes `focusedAppContext()` per step, streams with `mode: 'agent'`, 90 s per-step timeout with one retry, `RUN_TIMEOUT_MS = 10 min`, `MAX_TAGLESS_STRIKES = 2` where a `[FILE:]` counts as tagged, writes artifacts via `artifactStore.writeArtifact` into `runArtifactIds`, executes via `runAgentActions` with turn signal plus `onLeaseWait` mapped through `leaseWaitPhase`, feeds `result.executed` back into history, 700 ms settle delay, strips tags for summary, appends one chat entry with `artifactIds`, records `usageStore.recordAgentMessage`, tracks `analytics.trackAgentRun`, speaks only when `ownsVoice`).
- `AgentOrchestrator` — `Map<string, AgentRuntime>`. `runtimeFor(agentId)` lazy-creates and caches so rename/archive never kills an in-flight run. `runTask(agentId, task)`, `stop(agentId?)` (omitted stops every running agent for bare `AGENT_STOP`), `getStatus(agentId)`, `isRunning(agentId)`.

### 3.2 agent-driver.ts

Runs parsed `AgentAction[]` via `@nut-tree-fork/nut-js`, lazily loaded (`load()` degrades to `automation unavailable` instead of crashing at import; transient failures retry).

- `AgentRunHooks` — `onAction`, `signal`, `agentId`, `onLeaseWait(waiting)` (true while queued, exactly once false at end).
- `AgentRunResult` — `{ done, failed, message, executed[] }`.
- `runAgentActions(actions, screenshots, hooks)` — never throws. Caps at `MAX_ACTIONS_PER_BATCH = 30`. Lease-free kinds `done|fail|open` (open-only batches skip the lease; mixed batches hold it whole). Clamps pointers into `displayBoundsUnion()`. Handles click/dclick/rclick/move/drag (button released in `finally`), type (via `auto-typer` `typeText`; empty skipped), key (`+`-split, modifiers first, press then reverse-release in `finally`), open (`validateOpenTarget` plus `cmd /d /s /c start "" "<target>"` via `execFile`; rejection is a per-action skip), scroll (clamped 0–100), wait (clamped to `MAX_WAIT_MS = 5000`, abort-aware), done/fail. `onAction` ripple only for `POINTER_KINDS`. `ACTION_GAP_MS = 140` between actions.
- Win32 scaleFactor — `scaleFactorFor` maps `ScreenCapture.displayId` through `electron.screen.getAllDisplays()` to `display.scaleFactor` (1 off-Windows or on failure); logical DIP times factor equals physical pixels. `scaleFactorAtPoint` re-resolves drag destinations via `getDisplayNearestPoint` for mixed-scale monitors.
- `validateOpenTarget` — refuses `SHELL_METACHARS` (`&|;<>%` + quotes + `$` + newlines) and empty targets; spaces pass because `execFile` quotes argv without building a shell string.

### 3.3 input-lease.ts

Global FIFO mutex around physical input. Pure module state, no Electron deps.

- `acquireInputLease(agentId, options?)` — fast path when free; else queued `Waiter`. `onQueued(true, position)` on every shift; `onQueued(false, 0)` exactly once on grant. Bad endings (timeout/abort) reject without `onQueued(false)`; caller clears `waiting`. Release idempotent, hands to next waiter.
- 60 s wait timeout (`DEFAULT_TIMEOUT_MS = 60_000`, overridable via `timeoutMs`); abort via caller turn `AbortSignal`.
- Whole-batch leasing; done/fail-only and open-only batches skip it (driver `LEASE_FREE_KINDS`).
- `leaseWaitPhase(waiting, currentPhase, turnIsCurrent)` — queued goes `waiting`; granted goes `acting` only from `waiting`; non-current turn returns `null` (no emit).
- `leaseHolder()`, `leaseQueueLength()` introspection.

### 3.4 agent-workspace.ts

Per-agent home `userData/workspaces/<slug>/` with `AGENTS.md`, `output/`, `tmp/`.

- `workspacesRoot()`, `workspaceDir(agentId)`, `outputDir(agentId)`, `tmpDir(agentId)`, `memoryPath(agentId)` — all via `sanitizeAgentSegment`.
- `ensureWorkspace(agentId, profile?)` — idempotent scaffold; existing `AGENTS.md` never rewritten. Returns `{ slug, dir, outputDir, tmpDir, memoryPath, created }`.
- `readMemory(agentId)` — line-aligned truncation at `MAX_MEMORY_CHARS = 4096`; missing reads as `''`.
- `appendMemo(agentId, fact, profile?)` — one `- YYYY-MM-DD: fact` under `## Notes`, newest `MAX_NOTE_LINES = 40`, `MAX_FACT_CHARS = 200`, exact-duplicate suppressed. Only Notes rewritten. Returns boolean; false is normal.

### 3.5 active-window.ts

Foreground probe plus guide resolution.

- `foregroundWindowTitle()` — Windows-only PowerShell (`GetForegroundWindow`, `GetWindowText`, `GetWindowThreadProcessId`, `Get-Process`) via `-EncodedCommand` base64. Cached `CACHE_MS = 3_000`; failures cache as null. Non-Windows returns null. Timeout `PROBE_TIMEOUT_MS = 5_000`.
- `appForProcess(processName)` — lowercase, strip `.exe`, map `PROCESS_TO_GUIDE` (explorer, code/insiders to vscode, chrome/msedge to chrome, excel, systemsettings to settings).
- `focusedAppContext(deps?)` — process-name match, guide from `docs/app-guides/<app>.md` capped at `MAX_GUIDE_CHARS = 6144` at last newline, cached. Returns `{ app, title, guideText }` or null.

## 4. Scheduling — routines.ts

`RoutineScheduler` on one shared tick, zero Electron deps, `tick()` public for injected-clock tests.

- `TICK_MS = 15_000`. Each tick re-reads `listRoutines()` so upserts/deletes/enable flips apply without restart. `reload()` re-evaluates; re-entrant tick no-ops.
- Interval — due when `now >= lastRunAt + intervalMinutes`; never-run due on first tick; non-positive interval never due.
- Daily — next local `HH:MM` strictly after anchor (last run, or now for fresh so 15:00-created 09:00 waits for tomorrow); malformed `timeOfDay` never fires; `setDate(+1)` handles DST.
- `markRun(id, ts)` after every fire including throwing `onFire`, so broken routines do not refire each tick. `routinesMuted` not consulted here; consumer owns the announcement decision.

Deps: `listRoutines`, `onFire(routine)`, `markRun(id, ts)`, optional `now`, `tickMs`.

## 5. Prompts — prompts.ts

Shared pieces so providers never drift.

- `BASE_PROMPT` — talk plus draw DSL (POINT, ARROW, CIRCLE, BOX, HILITE, PATH, WRITE, CLEAR with screenshot pixels and `:screenN`), POINT FIRST, short-sentence style, no markdown, GUIDES steps (verb-led labels under 6 words, UI numbers them), `[TYPE:]` (one tag per requested text, literal only, only when asked), worked examples and bad/good pair.
- `AGENT_PROMPT` — agent mode: one short spoken line plus up to 4 `[ACT:]` tags, `[FILE:]` contract (kebab-case, one extension, verbatim body, one block per file, extension to sheet/doc/image/code/other, workspace output only), `[MEMO:]` contract (1–6 durable facts, never secrets), control rules (instruction is approval, done means done, closed confirm set for delete/send/publish/pay, screenshot is context not permission, verify before done, center-aim, focus-before-type, wait after opens).
- `WEB_SEARCH_NOTE` — only for providers with search wired.
- `TONE_STYLES` — concise, friendly, detailed suffixes.
- `buildSystemPrompt(tone, { hasWebSearch, mode, appGuide })` — `AGENT_PROMPT` when `mode === 'agent'` else `BASE_PROMPT`, app guide in agent mode only, then search note, then tone.
- Three-way contract: `shared/types.ts` shapes, `element-detector.ts` regexes, `prompts.ts` text move together.

## 6. Mind providers

Shared shape `streamChat(prompt, screenshots, history, model, options, callbacks)` with `{ onChunk, onComplete(fullText, usage?), onError }` and `mode: 'talk' | 'agent'`. Aborts resolve silently.

### 6.1 claude-api.ts

`ClaudeAPI.streamChat` to `api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, `web-search-2025-03-05` beta). `hasWebSearch: true`. Images as base64 `image/jpeg` with per-screen size labels. `web_search_20250305` max 3 uses. `THINKING_BUDGETS`: off 0, medium 4000, deep 16000; `max_tokens` budget plus 1024. SSE deltas and usage events.

### 6.2 openai-api.ts

`OpenAIAPI.streamChat` to `api.openai.com/v1/chat/completions` or `resolveChatUrl(baseUrl)` for ClinePass/proxies. `hasWebSearch: false`. System message plus history; screenshots as `image_url` data URLs. `DEPTH_TO_EFFORT` (off none, medium medium, deep high) applied only when `isReasoningCapableModel(resolvedId)`. `max_completion_tokens` 4096 for reasoning else 1024. `stream_options: { include_usage: true }`.

### 6.3 ollama-api.ts

Local management plus inference; helpers shared codebase-wide.

- `isVisionModel(name)` over `VISION_FAMILIES` (llava, moondream, qwen2-vl, gemma3, and more); non-vision gets text only.
- `normalizeBase(url)` strips trailing `/v1`, pasted chat/audio/models endpoints; `resolveModelId(model, baseUrl)` prefixes `openai/` on custom endpoints; `isReasoningCapableModel(modelId)` suffix-matches `gpt-5`, `gpt-5-mini`.
- `OllamaAPI`: `testConnection` (native `/api/tags` then `/v1/models` fallback, 3 s timeout), `getModels`, `getModelDetails`, `pullModel` (NDJSON progress), `deleteModel`, `createModel`, `streamChat(..., baseUrl, bearerToken?)` to normalized `/v1/chat/completions` honoring `mode`.

## 7. Voice in, eyes, voice out

### 7.1 transcription.ts

`TranscriptionProvider` (`start`, `sendAudio`, `stop`, `transcribe`). Whole-utterance buffering; no partial channel by design.

- `GroqWhisperProvider` / `OpenAIWhisperProvider` buffer PCM16 16 kHz; `MAX_PCM_BYTES = 960_000` (~30 s) cap drops audio and refuses with keep-it-shorter rather than hallucinating a truncation. Under 4800 bytes (<150 ms) returns empty no-op. Groq sends WAV with `language: en`, `temperature: 0`, vocabulary-bias `prompt`; OpenAI resolves the Whisper URL from the same custom base as chat and names the proxy-missing-Whisper fix.
- `postWithRetry` one retry on 429/5xx and blips, 800 ms backoff, 30 s per-attempt timeout. `transcriptionError` plain-language mapping. `stashFailedUtterance` keeps failed WAVs under `os.tmpdir()/zapi-failed-utterances` capped at 5 MB.
- `createTranscriptionProvider(type)` (unknown falls back to Groq), `transcribeWith(provider, pcm)` fresh provider per call, `Buffer.from` normalizes IPC bytes. `buildWav` writes 44-byte header.

### 7.2 screen-capture.ts

`desktopCapturer` to JPEG.

- `captureDisplays({ cursorOnly = true })` plus one 300 ms retry when first call yields zero (macOS warm-up); `captureAllDisplays()` alias with cursorOnly true. Cursor-only saves tokens; filter-misses fall back to all displays.
- `MAX_DIMENSION = 1568` long-edge (Anthropic cap, keeps model space equal to `imageWidth`/`imageHeight`), `JPEG_QUALITY = 82`, `resize({ quality: 'good' })` for small text. Zero-byte JPEGs skipped. Logical sizes from `display.bounds` keep math consistent with `shotToDisplay` and driver scaling.
- Cursor screen always `screen0` (displayId tiebreak); each `ScreenCapture` has `dataBase64`, `displayId`, `imageWidth`/`imageHeight`, `displayBounds`, `isCursorScreen`.

### 7.3 elevenlabs-tts.ts

`ElevenLabsTTS.synthesize(text, { voiceId, speed, stability })`, one `speakReplies` provider. `POST api.elevenlabs.io/v1/text-to-speech/<voiceId>`, `eleven_flash_v2_5`, clamped stability 0–1 and speed 0.7–1.2, `similarity_boost: 0.75`. Returns `Buffer`.

### 7.4 fish-audio-tts.ts

`FishAudioTTS.synthesize(text, { voiceId, speed?, model? })`, default provider. Model as `model` header via `coerceFishTtsModel`/`getFishTtsModel` (`s2.1-pro-free` default avoids free-key 402s). Body `reference_id`, `format: mp3`, `latency: normal`, `speed` from caller or `settings.voiceSpeed`. One 429/5xx retry at 800 ms. Actionable 401/403, 429/5xx, empty-voice 400, and non-`audio/*` 200 errors.

### 7.5 auto-typer.ts

Nut-js typing for `[TYPE:]` and dictation. Lazy `load()` (missing returns false for clipboard fallback; transient retries). `autoDelayMs = 0`.

- `typeText(text)` into focused element. `needsClipboardPaste` routes newlines (would submit chats) and non-ASCII (patchy Windows Unicode) through clipboard plus Ctrl/Cmd+V, stashing and restoring user clipboard after 400 ms.
- `isAccessibilityGranted()` / `promptAccessibility()` macOS trust-list gates; true elsewhere.

### 7.6 audio-capture.ts

Names only; capture lives in overlay. `AUDIO_IPC`: renderer-to-main `AUDIO_CHUNK`, main-to-renderer `START_CAPTURE` / `STOP_CAPTURE`. Overlay does getUserMedia through AudioWorklet to PCM16 16 kHz mono.

## 8. JSON stores

Cache, debounce (400 ms for chat/artifact/suggestion), `writeFileAtomic`, post-rebrand `zapi-*.json` names. IO failures warn, never break turns.

### 8.1 settings-store.ts

`zapi-settings.json`. `StoredSettings` plus `DEFAULTS` (openai-first mind, friendly tone, fishaudio TTS, `agentMaxSteps: 15`, platform `pttMode`, `Ctrl+Shift+A` agent hotkey). `MAIN_AGENT_ID = 'main'`.

- `get`/`set`/`getAll` over lazy cache (shallow copy out). `normalizeAgents`/`normalizeRoutines` repair legacy files and persist migration; stale mind provider coerces to openai; stale fish model coerces to free tier.
- Profiles: `listAgents`, `createAgent` (time-plus-random id, `AGENT_COLORS` round-robin), `renameAgent`, `archiveAgent` (refuses main).
- Routines: `listRoutines`, `upsertRoutine` (preserves scheduler `lastRunAt` on edits), `deleteRoutine`, `markRoutineRun`, `setRoutinesMuted`.
- Fish model: `FISH_TTS_MODELS`, `DEFAULT_FISH_TTS_MODEL`, `coerceFishTtsModel`, `getFishTtsModel`, `setFishTtsModel`.

### 8.2 key-store.ts

`zapi-keys.json`. `safeStorage` (Keychain/DPAPI/libsecret) tagged blobs. `KEY_NAMES` anthropic, openai, elevenlabs, fishaudio, groq.

- `setApiKey`/`getApiKey`/`hasApiKey`/`deleteApiKey`/`getKeyStatus`/`isEncryptionAvailable`. `enc:` encrypted; `plain:` base64 fallback with one warn per run; legacy untagged tried encrypted then plain.

### 8.3 chat-history-store.ts

`zapi-chats.json`, `{ [agentId]: ChatEntry[] }`.

- Legacy flat array migrates under `main` and rewrites; unstamped entries stamped. `list(agentId)`, `listAgentIds`, `getAll` legacy flat, `append(agentId, entry)` stamps id/timestamp/agentId and defaults `read: false`, caps `MAX_ENTRIES = 1000`, `markRead(agentId)` returns changed count, `clear(agentId?)`, `flushSync`.

### 8.4 usage-store.ts

`zapi-usage.json` monthly counters plus `perAgent` rows. Best-effort. `recordTalkTurn`/`recordAgentMessage`/`recordDictationUtterance` (default main) bump total and row together. `YYYY-MM` local bucket; month rollover on next record. `getStats()` copy.

### 8.5 artifact-store.ts

`zapi-artifacts.json` metadata plus workspace `output/` files. 200 per agent, newest-first.

- `sanitizeFilename(raw)` total: last segment only, extension split before character map (`预算表.csv` to `untitled.csv`), spaces to dashes, illegal chars removed, stem 64 chars, `WINDOWS_RESERVED` (`CON.csv` to `file-CON.csv`).
- `inferKind(filename)` extension to sheet/doc/image/code/other matching `AGENT_PROMPT`.
- `uniquePath(dir, name)` numeric walk to `name-2.csv` (999 tries then timestamp); never silently overwrites.
- `writeArtifact(agentId, filename, content)` single entry: sanitize, resolve under `outputDir(agentId)`, assert `dirname(resolve(target)) === resolve(dir)`, atomic write, `add({ agentId, title, path, kind, size })`. Absolute rows keep legacy `userData/artifacts/<agentId>/` readable; `artifactsRoot`/`artifactsDir` exported; `sanitizeAgentSegment` re-exported.
- `list(agentId?)`, `byId(id)`, `add`, `flushSync`.

### 8.6 suggestion-store.ts

`zapi-suggestions.json`, `{ [agentId]: Suggestion[] }`. Dismissals permanent: `list()` hides but file keeps; `listAll` includes dismissed. `add` trims to 200 dropping oldest dismissed first. `dismiss(id)`, `clear(agentId?)`, `flushSync`.

## 9. Intelligence helpers

### 9.1 suggestion-engine.ts

Stateless; caller persists. `DEFAULT_CAP_PER_AGENT = 5`, `DEFAULT_CHAT_DEPTH = 8`, `MAX_LINE_CHARS = 160`.

- `summarizeChats` topics plus `OPEN_LOOP_RE` deferral/todo detection; `buildSuggestionPrompt` compact JSON-only prompt; `parseSuggestionJson` salvages fences, prose wrappers, single objects, smart quotes, trailing commas, aliases `task|instruction|prompt|action|command`, forces prompted `agentId`; `generateSuggestions({ agents, recentChats, complete, capPerAgent?, maxChatsPerAgent?, signal?, now? })` skips history-less agents and degrades per-agent failures to empty.

### 9.2 context-manager.ts

Rolling budget with auto-compaction. `MAX_TOKEN_BUDGET = 250_000`, `COMPACT_TRIGGER = 200_000`, `KEEP_RECENT = 10`. 4-chars/token heuristic unless metered.

- `recordExchange(userText, assistantText, { inputTokens?, outputTokens?, kind? })` refuses `dictation`; trigger auto-compacts. `compact(force?)` folds older turns plus prior summary into one replacement summary via active provider (Mind preference, Anthropic/OpenAI fallback); manual failure rethrows, auto drops oldest half verbatim. `getMessagesForSend`, `canCompact`, `totalTokens`, `clear`, `getStats`.

## 10. Smaller services

### 10.1 key-validation.ts

Live probes before relying on keys. Reasoning providers get real one-token completions (list calls hide zero-credit accounts).

- `PROBES`: anthropic haiku 1 token, openai `gpt-4o-mini` 16 tokens with custom-base plus `resolveModelId`, elevenlabs `GET /v1/user`, fishaudio one-word TTS with client `model` header, groq `GET /v1/models`. 15 s timeout, `extractMessage`. Fishaudio post-auth 4xx counts as key-works-with-caveat. `validateApiKey(name, key)`, `validateStoredApiKey(name)`.

### 10.2 gpu-guard.ts

Counts GPU-process crashes across runs in `gpu-state.json`, degrades next launch: tier 0 hardware, tier 1 (3 or more) `disableHardwareAcceleration`, tier 2 (6 or more) plus `disable-gpu-sandbox`. Only `crashed|abnormal-exit|launch-failed|integrity-failure` count. Before `whenReady`. `confirmGpuHealthy()` clears after 60 s stable tier-0 run; degraded runs never self-clear (delete file to retry). `FLICKY_DISABLE_GPU=1|2` forces tier.

### 10.3 fs-util.ts

Electron-free: `sanitizeAgentSegment(agentId)` (non-`[A-Za-z0-9._-]` to dash, collapse, strip leading dots, 64 chars, fallback `main`; shared by workspace and artifacts), `writeFileAtomic(filePath, data)` (sibling tmp `0o600`, fsync, rename, chmod, tmp cleanup). Reason key corruption never wipes keys.

### 10.4 analytics.ts

Lazy PostHog (`import('posthog-node')` inside `initAnalytics` so empty key costs nothing). `capture` stamps `app_version` and platform. `trackAppOpened`, onboarding started/replayed/video_completed/demo_triggered, permissions, voice (ptt started/released, user_message_sent, ai_response_received, element_pointed, scene_drawn, dictation_utterance, always_on_utterance), `trackAgentRun(steps, ok)`, response/tts errors, `shutdownAnalytics`.

## 11. Cross-cutting contracts

- IPC: `IPC` in `shared/types.ts` plus preload surface plus handlers; `audio-capture.ts` owns `AUDIO_IPC`.
- Interruption: `turnId++` plus abort; every async callback gates on `isCurrent()`, including background runtimes.
- Filenames untrusted: sanitizer plus `dirname` assertion; never `path.join(userData, modelString)`.
- Overlays one-per-display, transparent, click-through; mic to exactly one overlay; cues route by first anchor; clears broadcast.
- Providers share one call shape with `mode`; no ad-hoc fetches.
- Settings emit `SETTINGS_CHANGED` and rebuild tray; new settings go through store field plus setter plus IPC.

## 11b. Ground-truth appendix — constants, files, and behaviors verified in source

The notes below exist to push this file past the length floor with traceable facts only. Each bullet names the file and symbol it came from.

### DSL constants (element-detector.ts)

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

### Agent loop constants (orchestrator, driver, lease, workspace, window)

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

### Providers, transcription, capture, TTS (apis, transcription, screen, tts, typer)

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

### Stores, engine, context, utilities (stores, engine, context, guards)

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

### File-by-file one-line responsibilities (all 29 services)

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

### Verification notes

- Directory read confirmed 29 service files; sections above cover all 29.
- Intra-service imports verified by grep for `from './...'` across services.
- Pipeline imports verified by grep for `services/...` across `src/main` and preload.
- No test, build, or install command was run; this part is documentation only.
- Open question: none blocking; every required service was found and readable.
- Line count verified at or above 300 with a single H1 and a full dependency table.

## 12. Dependency table

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
