# ZAPI — Full Verification Report

Date: 2026-09-28 (refreshed later the same day). Read-only verification + this
file; no source was modified. `scripts/**` was executed (never edited).

## Verification table

Re-run at refresh time. `dev-verify` discovers test scripts **by filename
suffix**, so the suite grows for free as `*-smoke` / `*-check` / `*-abort` /
`*-response` files appear — 7 steps → 20 over the session. The bun-stub scripts
(`agent-abort`, the store smokes) run under their declared preload instead of
self-reporting SKIP.

> **Discovery is suffix-based, which means some scripts never run.** Only
> `*-smoke.mts`, `*-check.mts`, `*-abort.mts`, `*-response.mts` and
> `scene-pipeline.mts` are picked up. `flicky-sweep.mts`,
> `settings-parity.mts`, `size-report.mts`, `agent-dryrun.mts`,
> `seed-suggestions.mts` and `make-ico.mjs` do **not** match and are silently
> skipped — they have to be run by hand. A green dev-verify line is therefore not
> a statement about those six.

| Check | Command | Result |
|---|---|---|
| **dev-verify total** | `bunx tsx scripts/dev-verify.mts` | **20 passed, 0 failed, 0 skipped**, exit 0 |
| Typecheck (main) | `bunx tsc -p tsconfig.main.json --noEmit` | PASS (via dev-verify) |
| Typecheck (renderer) | `bunx tsc -p tsconfig.renderer.json --noEmit` | PASS (via dev-verify) |
| Lint (report-only) | `npm run lint` | PASS (via dev-verify) |
| Preload check | `bunx tsx scripts/preload-check.mts` | **358 passed, 0 failed, 0 findings**, exit 0 — was 328 / **9 failed** |
| Scene pipeline smoke | `bunx tsx scripts/scene-pipeline.mts` | PASS — 20 checks, exit 0 (was 19) |
| Rebrand sweep | `bunx tsx scripts/flicky-sweep.mts` | **FAIL** — 242 intentional, **11 stray**, exit 1 — triaged below |

### Rebrand-sweep triage — 11 strays, none user-visible

The count moved 4 → 11 as new documents landed, not because anything regressed.
Classified:

| File:line | Text | Verdict |
|---|---|---|
| `AGENTS.md:4`, `LICENSE:3`, `package.json:110` | "upstream Flicky project", "Flicky contributors", `"repo": "flicky"` | Pre-existing attribution / publish target — the original 4, unchanged |
| `scripts/chat-smoke.mts:177`, `AGENTS.md:132` | `flicky-chat-history.json` | The legacy migration path the smoke deliberately asserts; AGENTS.md only names the file |
| `AGENTS.md:151` | `flicky-sweep.mts` | The script's own name, in the table describing it |
| `docs/QUICKSTART.md:334` | "Descends from [Flicky](…/flicky)" | Upstream attribution — same class as `README.md:5`, which the sweep *does* classify as intentional |
| `docs/VOICE-TESTS.md:162,213,308`, `docs/PLAN-api-ui.md:39` | wake-word test phrases, `flicky.listRemoteModels()` | Test/plan prose; the classifier has no category for it yet |

No log prefix, UI string, IPC channel, or config value regressed. The gap is in
the **classifier** (`flicky-sweep.mts`): it has no category for documentation
prose. It exits 1, so this will keep reading as a failure until it gets one.

The scratch files the api-ui sweep counted (`.tmp-probe.mts`, `tmp-review5/`)
are gone, and `docs/VOICE-TESTS.md` landed with three wake-word test phrases
that no classifier category covers — hence 12 → 11 with a different file set.

### One transient red, not a regression

`selfsettings-smoke.mts` was observed failing one assertion
(`no fire: 'stop announcing yourself'`) while its file was **mid-edit** — the
owner was swapping that stale expectation for the opposite one (`'yourself'` is
an allowed tail word, per the accepted-shapes list in `applyVoiceSelfSetting`).
Caught between the two writes, it showed up as 18/2 and then 19/1 across three
consecutive `dev-verify` runs. The file settled at the correct assertion and now
passes 20/20 on repeat runs. Recorded because a single green sample would have
been luck, not proof.


The full 20-step `dev-verify` line, in order: `tsc main`, `tsc renderer`,
`agent-abort.mts`, `artifact-smoke.mts`, `chat-smoke.mts`, `golden-response.mts`,
`hotkey-suspend-check.mts`, `ink-check.mts`, `keystore-smoke.mts`,
`lease-smoke.mts`, `parse-smoke.mts`, `preload-check.mts`, `routines-smoke.mts`,
`scene-pipeline.mts`, `selfsettings-smoke.mts`, `shape-check.mts`,
`store-smoke.mts`, `suggestion-parse-smoke.mts`, `suggestion-smoke.mts`,
`lint (report-only)`.

Earlier-wave results, kept for the record: `npm run build` PASS (66 modules to
`dist/renderer`); `npm run package:win` PASS — `release/ZAPI Setup 1.2.1.exe`,
170.4 MB, NSIS x64+arm64, unsigned (expected, no local cert).

## Known-open items — all three defects resolved

Items 1–3 were open defects; every one is now closed, with evidence. Item 4 was
never a defect — it is a standing note on intentional leftovers.

1. ~~**AUDIT2 [BREAKING] multi-display scenes drop off-target cues.**~~
   **RESOLVED — verified, not assumed.** In `index.ts`, the `onScene` callback now
   broadcasts `IPC.SCENE` via `sendToOverlays(...)` and `onSceneCue` broadcasts the
   beat via `sendToOverlays(IPC.SCENE_CUE, i)`. Single-target routing is gone.
   The in-code rationale is that a scene's cues carry per-cue `screenIndex`, so
   each renderer culls strokes outside its own display bounds (`InkLayer`) and
   hops point cues only on its own display (`OverlayApp`) — extra copies are
   inert on the wrong screens, and every screen stays beat-synchronized.
2. ~~**Cline REVIEW.md pending — no `REVIEW.md` in the repo root.**~~
   **RESOLVED.** `REVIEW.md`, `REVIEW2.md`, `REVIEW3.md`, `REVIEW4.md` all exist.
3. ~~**AUDIT FOR-OWNER leftovers (B1/B2, D4–D7, F-C1, F-C2).**~~
   **RESOLVED.** Re-checked each against the tree, by symbol:

   | Item | Status now |
   |---|---|
   | B1/B2 stream subscriptions | Wired — `StreamApp.tsx` subscribes `onAiError` and `onTypeFulfilled` |
   | D4 `setStreamWindowBounds` | Wired — `preload/index.ts` → `IPC.SET_STREAM_WINDOW_BOUNDS` handler in `index.ts` → `companion-manager` method |
   | D5 `getApiKeyStatus` | Wired — `preload/index.ts` → `IPC.GET_API_KEY_STATUS` handler in `index.ts` → `companion-manager` method |
   | D6 legacy point parsers | Gone — no second/legacy POINT parser anywhere in `src/` |
   | D7 `AUDIO_IPC.AUDIO_LEVEL` | Gone — `audio-capture.ts` exports exactly 3 keys |
   | F-C1 dead enum entries / F-C2 raw-string channels | `preload-check` reports **0 findings** |

4. **Naming leftovers (intentional, unchanged).** `window.flicky`,
   `FlickySettings`, `flicky-chat-history.json` (still asserted by
   `chat-smoke.mts:177`), `--flicky-display-info`, publish `repo: "flicky"` —
   see FEATURES.md GAPS. The sweep now reports **11 strays** — see
   §Rebrand-sweep triage above; all are attribution, test-phrase, or
   documentation prose, none a user-visible brand string.

## Feature surface (one line per area)

- **Talk:** PTT hotkey (hold/toggle) → mic → Groq/OpenAI transcription → screenshot + Claude/GPT/Ollama → scene draw + ElevenLabs/Fish speech.
- **Draw:** `[POINT/ARROW/CIRCLE/BOX/HILITE/PATH/WRITE/CLEAR]` tags → per-display InkLayer strokes + hopping companion cursor with step badges. Scenes and beats **broadcast** to every overlay; each renderer culls to its own display.
- **Agent:** `"zapi agent …"` trigger → screenshot→act loop (click/dclick/rclick/move/type/key/scroll/drag/wait/done/fail via nut-js) with chip/feed/pill status and stop buttons.
- **Dictation:** sticky mode toggle + dedicated push-to-dictate hotkey (forced-dictation path), auto-type or clipboard, counted separately in usage/history.
- **Always-on:** overlay-side VAD (adaptive threshold, calibration) ships utterances hands-free; tray + panel + onboarding toggles.
- **Settings/panel:** Mind/Ear/Voice/General/Home/Chats tabs, Ollama management, key validation, onboarding with modes slide, shortcut capture.
- **System:** tray menu with mode checkboxes + ink demo, draggable stream window with visibility modes, launch-at-login, per-display transparent overlays, safeStorage key store, local chat history with kinds, usage counters.
- **Landing:** Next.js desktop-metaphor site (`landing/`) — hero demo player, features, pricing, FAQ, changelog/privacy/careers pages; builds clean.

## Wave: latest-features

What landed this session. Each item below was verified against the tree at
refresh time — the citations are the proof, not the intent.

### 1. Artifact system — `[FILE:…]` tag → real files on disk

The model emits a deliverable as a block, not a payload:

```
[FILE:budget.csv]
month,amount
jan,42
[/FILE]
```

`parseFileTags` (in `element-detector.ts`) → `{ filename, content }`, then
`artifact-store.writeArtifact(agentId, filename, content)` writes it into the
agent's workspace `output/` dir — `outputDir(agentId)` from `agent-workspace.ts`,
i.e. `userData/workspaces/<slug>/output/` — and records metadata in
`zapi-artifacts.json`. `userData/artifacts/<agentId>/` is now **legacy**: kept
exported only so rows written before per-agent workspaces existed stay locatable
for reveal-in-Explorer. The agent loop calls `writeArtifact(this.id, …)` in
`agent-orchestrator.ts` and stamps the ids onto the run's chat entry.

> **Cite by symbol, not line number.** Every `file:line` in this section drifted
> more than once during the session — `parseFileActions` alone moved ~50 lines
> between two waves. The symbols are stable; the numbers are not. Line numbers
> below are a convenience, not a contract.

Security is layered, not incidental: `sanitizeFilename` keeps only the last path
segment, `uniquePath` never overwrites (`name-2.csv`), `sanitizeAgentSegment`
scrubs the agent id, and a post-resolve `path.dirname` assertion refuses any path
outside the target dir. `inferKind` derives `sheet|doc|image|code|other` from the
extension — the model never declares it.

`stripFileBlocks` runs **before** `parseAgentActions`, so an `[ACT:key:enter]`
inside a python file the model wrote is data, not an instruction.

Handlers are live: `ARTIFACT_LIST` / `ARTIFACT_OPEN` / `ARTIFACT_REVEAL` at
`ARTIFACT_LIST` / `ARTIFACT_OPEN` / `ARTIFACT_REVEAL` in `index.ts` (`shell.openPath` resolves with an error *string*, handled).

### 2. Suggestion engine + cards

`suggestion-engine.ts` is stateless by design: per agent, one Mind completion over
that agent's recent chat (default cap 5/agent, depth 8), JSON-salvaged back into
`Suggestion[]`. An open-loop regex decides whether a chat line is an unfinished
thread — a bare question mark is far too common to be a signal.

Persistence is `suggestion-store.ts` (`zapi-suggestions.json`); **dismissals are
permanent**, so a card the user swiped away cannot return on the next refresh.
`acceptSuggestion` dismisses *and* runs the task on the card's own agent
(in `companion-manager.ts`), same turn shape as a routine. Handlers in the
`SUGGESTION_*` block of `index.ts`.

### 3. Typed text turns

`TEXT_TURN` → `companion.runTextTurn(agentId, text)` (handler in `index.ts`,
method in `companion-manager.ts`) shares the routine pipeline, so none of the
voice-only branches run: no self-settings commands, no dictation, no agent
trigger. Same queue guards, so a typed message can't stomp a live turn.

### 4. Per-agent unread

`chat-history-store.append` stamps `read: false` on every new entry — defaulted
rather than omitted so "is this unread" is one `read === false` test, and legacy
rows without the field read as read. `markRead(agentId)` flips a whole agent's
rows and returns the changed count so the handler can skip the disk write when
nothing moved. `CHAT_MARK_READ` accepts both the bare agentId and `{ agentId }`.

### 5. Voice-controlled settings phrases

`applyVoiceSelfSetting` (in `companion-manager.ts`) runs **instead of** a model
call on short transcripts and answers with a spoken confirmation:

| Say | Effect |
|---|---|
| "talk slower" / "speed up" | voice speed ∓0.15, clamped to the slider's 0.7–1.2 |
| "stop talking" / "be quiet" | `speakReplies` off |
| "start talking" / "unmute" | `speakReplies` on |
| "mute my routines" / "unmute routines" | `routinesMuted` |
| "always listen" / "stop listening" | always-on VAD |

Every change routes through the same setters the panel and tray use, so
`SETTINGS_CHANGED` still fires and the tray menu still rebuilds. An optional
"hey zapi," lead and trailing punctuation are stripped first, because a PTT
transcript carries whatever the user actually said.

### 6. userData collision fix

The package name `zapi` resolves `userData` to `%APPDATA%\zapi`, which a
**different installed app already owns** (`zapi.db`, `sfx/`, `agents/` live
there). The `app.setPath('userData', …)` block in `index.ts` claims
`%APPDATA%\ZAPI Companion` up front — before any
store reads the path — and migrates only our six known JSON files plus the
`artifacts/` tree. The foreign app's files are left untouched, and the whole
migration is wrapped in try/catch that degrades to a warning.

Ordering matters and is the point: every store resolves through
`app.getPath('userData')`, so `app.setPath` has to run first.

### 7. `openAIBaseUrl` endpoint normalization

`resolveChatUrl` (in `openai-api.ts`) routes an OpenAI-compatible endpoint
through `normalizeBase` (`ollama-api.ts`) before appending
`/v1/chat/completions`: trailing slashes, a trailing `/chat/completions`,
`/audio/transcriptions`, or `/models`, and a trailing `/v1` are all stripped.
A user pasting a full endpoint URL no longer produces
`…/v1/v1/chat/completions`. Empty string falls back to `api.openai.com`.

### Verdict

Seven features, all wired end-to-end, no `[FILE:]`-adjacent gap left: the two
`invoke` channels that used to hang are now `invoke`-resolvable
(`preload-check` 358/0/0), and `dev-verify` is green at **20 passed, 0 failed,
0 skipped**.


## Wave: artifacts+suggestions (superseded — kept for history)

> **SUPERSEDED.** Every finding below has since been fixed: the 9 channels are
> registered in the artifacts + suggestions block of `index.ts`, `preload-check` is now **358 passed / 0
> failed / 0 findings**, and the module table's "untracked-but-unwired" caveat no
> longer holds. Kept verbatim as the record of *why* the sweep ran; the current
> state is §Verification table and §Wave: latest-features.

Read-only contract freshness sweep. No source file was modified; the only writes
were the build's own output into gitignored `dist/`.

### Check results

| Check | Command | Result |
|---|---|---|
| Preload check | `bunx tsx scripts/preload-check.mts` | **FAIL** — 328 passed, 9 failed, 0 findings, exit 1 |
| Rebrand sweep | `bunx tsx scripts/flicky-sweep.mts` | **FAIL** — 226 intentional, **4 stray**, exit 1 |
| Build | `bun run build` | PASS, exit 0 — 66 modules, panel/overlay/stream html + bundles to `dist/renderer` |
| Bundle size report | `bunx tsx scripts/size-report.mts` | PASS, exit 0 — 1 passed, 0 failed |

> Note: `size-report.mts` re-runs `bun run build` internally (line 38), so the
> `bun run build && bunx tsx scripts/size-report.mts` invocation builds twice.
> Both builds exited 0.

### Preload check — 9 failing channels (all "no ipcMain handler")

Every failure is the same shape: the channel is declared in the frozen `IPC`
const and wired through `src/preload/index.ts`, but **no `ipcMain` handler or
listener is registered for it in `src/main/index.ts`** — the message goes
nowhere at runtime. A tree-wide grep for these identifiers returns hits only in
`src/shared/types.ts` (declaration) and `src/preload/index.ts` (call site);
zero in `src/main/`. `src/main/index.ts` registers 77 `ipcMain.handle`/`on`
sites and imports none of the three services below.

**Missing handlers (9) — all artifacts/suggestions/chat surface:**

| Channel | Value | Preload site | Kind |
|---|---|---|---|
| `ARTIFACT_LIST` | `artifact-list` | `preload/index.ts:109` | `invoke` |
| `ARTIFACT_OPEN` | `artifact-open` | `preload/index.ts:110` | `send` |
| `ARTIFACT_REVEAL` | `artifact-reveal` | `preload/index.ts:111` | `send` |
| `SUGGESTION_LIST` | `suggestion-list` | `preload/index.ts:115` | `invoke` |
| `SUGGESTION_ACCEPT` | `suggestion-accept` | `preload/index.ts:116` | `send` |
| `SUGGESTION_DISMISS` | `suggestion-dismiss` | `preload/index.ts:117` | `send` |
| `SUGGESTION_REFRESH` | `suggestion-refresh` | `preload/index.ts:118` | `send` |
| `CHAT_MARK_READ` | `chat-mark-read` | `preload/index.ts:120` | `send` |
| `TEXT_TURN` | `text-turn` | `preload/index.ts:124` | `send` |

**Extra channels: none.** The reverse direction (every `IPC.*` key has a live
sender; every preload channel resolves to an `IPC`/`AUDIO_IPC` value or an
allow-listed raw literal) passed cleanly — including the 6 allow-listed raw
string channels (`audio-chunk`, `display-info`, `play-audio`,
`start-audio-capture`, `stop-audio`, `stop-audio-capture`) and all 24
`ipcRenderer.on(...)` emitter pairings.

**Read:** the artifacts + suggestions feature is contract-complete on the
renderer side and **the service layer is fully implemented** — it is the
`ipcMain` registration layer in `src/main/index.ts` that is missing. The three
backing modules exist and export everything the handlers would need, but none is
imported by `main/index.ts`:

| Module (untracked) | Relevant exports | Backs |
|---|---|---|
| `src/main/services/artifact-store.ts` | `list`, `byId`, `add`, `writeArtifact`, `flushSync`, `inferKind`, `artifactsDir`, `sanitizeAgentSegment`, `sanitizeFilename` | `ARTIFACT_LIST` / `OPEN` / `REVEAL` |
| `src/main/services/suggestion-store.ts` | `list`, `listAll`, `add`, `dismiss`, `clear`, `flushSync` | `SUGGESTION_LIST` / `ACCEPT` / `DISMISS` |
| `src/main/services/suggestion-engine.ts` | `generateSuggestions`, `summarizeChats`, `buildSuggestionPrompt`, `parseSuggestionJson`, `DEFAULT_CAP_PER_AGENT` | `SUGGESTION_REFRESH` |

So the gap is one wiring step (9 `ipcMain.handle`/`on` registrations + the
imports), not a missing feature. `CHAT_MARK_READ` and `TEXT_TURN` have no
dedicated module — they most likely route to the existing
`chat-history-store.ts` / `agent-orchestrator.ts` (`agent-orchestrator.ts` and
`routines.ts` are likewise untracked-but-unwired, which is likely why the wave
was left mid-flight).

Severity: the two `invoke` channels (`ARTIFACT_LIST`, `SUGGESTION_LIST`) are
the most visible — their promises never resolve, so callers render a permanently
pending state. The 7 `send` channels fail silently.

*This section is a read-only diagnosis only; no wiring was performed (source
files were left untouched per task scope).*

### Rebrand sweep — 4 stray `flicky` hits (120 text files scanned, 13 skipped binary/oversized)

| File | Line | Text |
|---|---|---|
| `AGENTS.md` | 4 | `upstream Flicky project).` |
| `LICENSE` | 3 | `Copyright (c) 2026 Julio Vaught and Flicky contributors` |
| `package.json` | 110 | `"repo": "flicky"` |
| `scripts/chat-smoke.mts` | 167 | `const legacyExists = fs.existsSync(path.join(dir, 'flicky-chat-history.json'));` |

All 4 are **already-tracked intentional leftovers**, consistent with
REPORT.md §Known-open item 4 and FEATURES.md GAPS — not new regressions:

- `AGENTS.md:4` / `LICENSE:3` — historical attribution to the upstream project
  the repo descends from (alongside the 226 classified hits, which include the
  `Clicky` lineage lines in the same files).
- `package.json:110` — the GitHub publish `repo` still points at `flicky`;
  renaming it without a matching repo rename would break `publish`.
- `chat-smoke.mts:167` — deliberately asserts the *legacy* `flicky-chat-history.json`
  migration path still resolves; the variable name says so.

Nothing here is a user-visible brand string, log prefix, or config value, so
no rebranding action is implied. The sweep's `FlickySettings` (49),
`window.flicky` contextBridge key (163), `FlickyAPI` (3),
`FLICKY_DISABLE_GPU` (2) and wake-word mishear alias (9) categories are all
frozen by design.

### Bundle sizes vs 500 KB budget — PASS

Largest artifact is the shared React chunk at **189.2 KB**, 38% of budget.
No bundle file exceeds 500 KB; dist totals **831.1 KB across 47 files**,
plus 14 packaged asset files (155.2 KB) shipped via
`files: [dist/**, assets/**]`.

| File | KB | Tag |
|---|---|---|
| `dist/renderer/assets/react-BBy83TsR.js` | 189.2 | shared chunk |
| `dist/renderer/assets/panel-BCkvt-Ee.js` | 92.9 | panel bundle |
| `dist/main/main/index.js` | 62.8 | main entry |
| `dist/renderer/assets/panel-CLRan_Sd.css` | 45.9 | panel bundle |
| `dist/renderer/assets/overlay-wcq33lN_.js` | 26.1 | overlay bundle |
| `dist/main/preload/index.js` | 20.2 | preload |
| `dist/renderer/assets/overlay-De0_N62S.css` | 12.0 | overlay bundle |
| `dist/renderer/assets/stream-BttCjJ6-.js` | 8.8 | stream bundle |
| `dist/renderer/assets/stream-Dw63iN_7.css` | 5.3 | stream bundle |
| `dist/renderer/assets/design-system-qaaxgM_L.css` | 1.3 | shared chunk |
| `dist/renderer/assets/waveform-CAAYP9m3.css` | 1.2 | shared chunk |
| `dist/renderer/assets/design-system-DD1t6aHK.js` | 0.8 | shared chunk |
| `dist/renderer/assets/waveform-DN4-wf3g.js` | 0.4 | shared chunk |

(The 51.22 kB `Caveat-SemiBold` woff2 font is emitted to `dist/renderer/assets/`
but is not matched by the report's bundle globs, so it is not budget-checked.)

### Verdict (as of that sweep — now superseded)

The wave was **not** contract-clean. Two of four checks failed:

1. ~~**Blocking — 9 unwired channels.**~~ **FIXED.** The artifacts + suggestions
   service layer is fully implemented *and* now registered with `ipcMain`
   (in `index.ts`). `preload-check.mts` re-run at refresh: 358 passed,
   0 failed, 0 findings.
2. **Non-blocking — stray `flicky` hits**, documented as intentional. No action
   needed unless the repo is renamed. The count has since drifted 4 → 11 purely
   from new docs; see §Rebrand-sweep triage.


## Sweep: api-ui wave

Post-wave contract sweep, run after the `LIST_REMOTE_MODELS` handler and
`MindTab` panel changes landed. I waited ~3 min for the sibling's writes to
settle (last `src/` edit at 22:36:10, checks started 22:38) before running
anything, so these results reflect a quiescent tree. Read-only: no source file
was modified.

### Check results

| Check | Command | Result |
|---|---|---|
| Preload check | `bunx tsx scripts/preload-check.mts` | **PASS** — 358 passed, 0 failed, 0 findings, exit 0 |
| Settings parity | `bunx tsx scripts/settings-parity.mts` | **PASS** — 5/5 checks, 0 error, 9 notes, exit 0 |
| Rebrand sweep | `bunx tsx scripts/flicky-sweep.mts` | **FAIL** — 239 intentional, 12 stray, exit 1 |
| dev-verify | `bunx tsx scripts/dev-verify.mts` | **PASS** — 20 passed, 0 failed, 0 skipped, exit 0 |

### Preload check — no findings; `LIST_REMOTE_MODELS` is wired ✅

**No missing or extra channels to report.** The api-ui channel passed all four
of its assertions:

```
PASS preload:127 ipcRenderer.invoke(IPC.LIST_REMOTE_MODELS)
PASS main:945 ipcMain.handle(IPC.LIST_REMOTE_MODELS)
PASS preload:127 ipcRenderer.invoke(IPC.LIST_REMOTE_MODELS) — handler method matches
```

The 9 channels that failed the prior sweep are all resolved and the check
added a new `surface:` phase asserting the `window.flicky.*` bridge methods map
1:1 to their `ipcRenderer` calls (`getArtifacts` → `ARTIFACT_LIST`,
`openArtifact` → `ARTIFACT_OPEN`, `revealArtifact` → `ARTIFACT_REVEAL`,
`getSuggestions` → `SUGGESTION_LIST`, `acceptSuggestion` → `SUGGESTION_ACCEPT`,
`dismissSuggestion` → `SUGGESTION_DISMISS`,
`refreshSuggestions` → `SUGGESTION_REFRESH`, `markChatRead` → `CHAT_MARK_READ`,
`sendTextTurn` → `TEXT_TURN`). Totals moved 328→358 passed, 9→0 failed.

### Settings parity — PASS, no drift

`32 stored fields, 34 renderer settings fields`, `104 total channels, 28 SET_*,
27 wired via ipcMain.on`, `28 setXxx preload methods`. The 9 notes are
informational, not errors:

- 3× `2-defaults`: `DEFAULT_SETTINGS` carries `id` / `kaomoji` / `name`, which
  are not persisted `StoredSettings` fields (renderer-only seed values).
- 1× `3-ipc-wiring`: `SET_LOCAL_CONNECTION_KEY` uses `ipcMain.handle` rather
  than `ipcMain.on` — correct, since it is `invoke`-shaped in preload.

The `openAIBaseUrl` field added by the api-ui wave is present on both sides, so
the new setting did not introduce a persistence gap.

### Rebrand sweep — 12 stray, but only 1 is a real product hit

143 text files scanned (13 skipped binary/oversized), up from 120 — the api-ui
wave added files. The stray count rose 4→12, and **8 of the 12 are transient
scratch artifacts from other agents, not product source**:

| File | Line | Text | Assessment |
|---|---|---|---|
| `.tmp-probe.mts` | 88 | `['stop', 'zapi stop', …, 'flicky stop', …]` | scratch probe — disposable |
| `tmp-review5/probe.mts` | 1 | `// Probe: REVIEW5 hypotheses…` | scratch dir — disposable |
| `tmp-review5/out2.txt` | 27–29 | stack-trace lines naming `tmp-review5/probe2.mts` | scratch output — disposable |
| `docs/PLAN-api-ui.md` | 39 | `` `MindTab` … → `flicky.listRemoteModels()` `` | **real** — doc written this wave |
| `docs/QUICKSTART.md` | 334 | `[Flicky](https://github.com/jvaught01/flicky)` | **real** — lineage attribution |
| `AGENTS.md` | 4 | `upstream Flicky project).` | pre-existing (carried from prior sweeps) |
| `AGENTS.md` | 130 | `flicky-sweep.mts \| classifies every flicky hit…` | new — self-referential doc line |
| `LICENSE` | 3 | `Copyright (c) 2026 Julio Vaught and Flicky contributors` | pre-existing |
| `package.json` | 110 | `"repo": "flicky"` | pre-existing (breaks `publish` if renamed alone) |
| `scripts/chat-smoke.mts` | 177 | `…'flicky-chat-history.json'…` | pre-existing (legacy-migration assertion) |

`docs/PLAN-api-ui.md:39` is a **new** stray introduced by this wave: it
documents the api-ui work using the `flicky.` bridge prefix, where the rest of
the docs use the `window.flicky.` phrasing that the classifier's
`window\.flicky` rule catches. It is documentation-only and arguably correct
(those methods really are `window.flicky.listRemoteModels`), so this is a
classifier gap rather than a true leftover — worth noting but not urgent.
`AGENTS.md:130` is likewise a self-description of the sweep tool.

The 4 genuinely-pre-existing strays are unchanged from the last sweep, and are
already tracked in §Known-open as intentional leftovers. Intentional
breakdown grew 226→239: `window.flicky` contextBridge key 170, `FlickySettings`
52, wake-word mishear alias 12, `FlickyAPI` 3, `FLICKY_DISABLE_GPU` 2.

### dev-verify — green at 20/20

`20 passed, 0 failed, 0 skipped`, exit 0. Typecheck (main + renderer), lint
(report-only), and 18 smoke/contract scripts all pass — including the new
`artifact-smoke.mts`, `suggestion-smoke.mts`, `suggestion-parse-smoke.mts`,
`selfsettings-smoke.mts` and `ink-check.mts` that did not exist in the previous
wave's 18-check roster. `chat-smoke.mts` now passes outright, where the
original verification table recorded it as SKIP (needs the bun `--preload`
electron stub, apparently since provided).

### Verdict

The api-ui wave is **contract-clean**. Every contract assertion passes:
`preload-check` 358/0/0 with `LIST_REMOTE_MODELS` correctly wired,
`settings-parity` reports no drift, and `dev-verify` is green at 20/20.

The only outstanding item is cosmetic: `flicky-sweep` exits 1 on 12 stray
hits, but **8 of those are scratch files from concurrent agents**
(`.tmp-probe.mts`, `tmp-review5/`) that should be deleted rather than renamed,
and 3 are pre-existing/documented intentional leftovers. The one net-new
product hit is `docs/PLAN-api-ui.md:39`, a doc line that uses the `flicky.`
prefix — defensible, since those bridge methods genuinely live at
`window.flicky.*`. No source change is required by this wave.


---

## Wave: heyclicky-adoption

Read-only comparison against the extracted HeyClicky bundle at
`D:\Work\ZAPI\heyclicky-extracted\HeyClicky\HeyClicky.app\Contents\Resources\`
(build `main-internal-release-build`, commit `99f33ebc`). No source file was
modified by this wave. The full matrix is
[docs/FEATURE-ADOPTION.md](docs/FEATURE-ADOPTION.md); this is the summary and the
evidence behind it.

### Source material

| Artifact | What it gave |
|---|---|
| `ClickyModelInstructions.md` (25 KB, the shipped agent contract) | The authoritative behavior list: persistent agents, MEMORY, file ownership, approval gate, Composio-first routing |
| `Resources/*.md` — 25 app guides + `AGENTS.md` + `ATTRIBUTION.md` | Guide anatomy (see [docs/APP-GUIDES-SURVEY.md](docs/APP-GUIDES-SURVEY.md)) |
| `ClickyBundledSkills/` | **15 skill directories**, one `SKILL.md` each (`cua-driver` carries 4 extra files, `vercel-deploy` 2) |
| 43 media files | 17 `.wav`, 25 `.mp3`, 1 `.m4a`; `ff.m4a` alone is 5.7 MB, 52% of the payload |
| `ClickyBuildInfo.plist` | Version anchor for the comparison |

### Status matrix

| Area | Status | Evidence on our side |
|---|---|---|
| Named agent workspaces | adopted | `AgentProfile` + cached `AgentRuntime` per id (`agent-orchestrator.ts`) |
| Per-agent workspace dir | adopted | `agent-workspace.ts`: `userData/workspaces/<slug>/` holding `AGENTS.md`, `output/`, `tmp/` |
| Concurrent agents, serialized input | adopted | `input-lease.ts` FIFO; visible `waiting` phase |
| Agent MEMORY (self-editing `AGENTS.md`) | adopted | `[MEMO:…]` → `parseMemos` → `appendMemo` writes `- YYYY-MM-DD: fact` under `## Notes`; `readMemory` re-injects it ahead of every agent step |
| Per-app guides | **partial** | 5 guides written in `docs/app-guides/`, **no runtime injection** |
| Skills router (`Use When` / `Do Not Use When`) | **partial** | Template agreed, not shipped |
| Approve-before-irreversible | **partial** | `AGENT_PROMPT` instruction only; no runtime second-confirmation gate |
| Per-action verification | **deferred** | Loop re-captures but asserts nothing about the capture |
| Composio MCP | **n/a** | Different product model — no hosted connector marketplace |
| `cua-driver` background input | **deferred** | Windows has no background-input primitive; the lease substitutes |
| Suggestion engine | adopted | `suggestion-engine.ts` + permanent dismissals in `suggestion-store.ts` |
| Routines / scheduling | adopted | `RoutineScheduler`, interval + daily `HH:MM` |
| `[FILE:]` deliverables | adopted | `parseFileTags` → `writeArtifact`, `inferKind` |
| OpenAI Realtime voices | **n/a** | No Realtime provider on our side |
| Shipped TTS voice previews | **n/a** | We synthesize the preview on demand instead of shipping 25 mp3s |
| SFX | **partial** | 4 wav in `src/renderer/assets/sfx/`, generated by `scripts/gen-sfx.mts`, wired via `IPC.PLAY_SFX` |
| contentProtection / capture exclusion | adopted | `win.setContentProtection(true)` on every overlay (`windows.ts`) — the comment cites their `ScreenshotManager` |
| Scene/beat routing | adopted | Broadcast to all overlays, each renderer culls to its own bounds — a deliberate divergence from AUDIT2 |
| Glass / vibrancy HUD | **n/a** | macOS aesthetic; Windows Mica/Acrylic unused |

### The five areas the brief called out

- **workspaces** — adopted. Profiles in settings, one cached runtime each, and
  `agent-workspace.ts` gives each one `userData/workspaces/<slug>/` containing
  `AGENTS.md`, `output/`, and `tmp/`.
- **MEMO(RY)** — adopted. `AGENT_PROMPT` teaches `[MEMO:one durable fact]`
  (1–6 per reply, never secrets, never spoken aloud); `parseMemos` extracts,
  dedupes, and caps them; `appendMemo` writes a `- YYYY-MM-DD: fact` bullet under
  `## Notes`, keeping the newest 40 and rejecting exact repeats; `readMemory`
  re-injects the file ahead of every agent step's prompt, so a fact memo'd on step
  N is visible on step N+1. Two honest limits: memory rides only in agent mode
  (the talk path never reads it), and `parseMemos` strips `[FILE:]` blocks first so
  a memo planted inside a file the model just wrote stays data.
- **prompt** — mostly closed. Their P1 eager-doer, P2 verify-after-act, the closed
  confirm set, and the MEMO clause all **landed** in `prompts.ts`; the standing
  exception is per-action verification. Full diff in
  [docs/PROMPT-GAP.md](docs/PROMPT-GAP.md).
- **SFX** — partial. We ship 4 of their 17 `.wav` moments (launch / done /
  needs-you, plus our own `heard`), synthesized rather than bundled. Missing:
  `agent-close`, the four `clicky-text-*`, the two question/connection cues, the
  two skill cues, and the four boot/reveal/hatching/tapback cues.
- **contentProtection** — adopted, and deliberately: `setContentProtection(true)`
  keeps the overlay out of `desktopCapturer` *and* out of the user's screen
  shares, which also stops the agent loop from reading back its own ink as screen
  state.
- **glass** — n/a. macOS vibrancy has no direct equivalent here and we use neither
  Mica nor Acrylic.

### Where we are ahead

Routines are the headline: their shipped contract states Remote Tasks, scheduled
crons, and other background automation are **not part of this release**, while we
ship a scheduler that posts into an agent's chat and skips itself when the user is
mid-turn. Also ahead: multi-agent as the default shape rather than a refactor, and
an explicit FIFO input lease where their answer to "two agents, one cursor" is to
avoid concurrency. Audio weight: 4 generated files against 43 shipped, ~10.6 MB.

### Three source populations, not two surveys

An earlier draft of this section claimed `ClickyBundledSkills/` was empty in our
extract. **It was not** — the path holds 15 skill directories, one `SKILL.md`
each: `clicky-artifacts`, `clicky-build-preview`, `clicky-creative-studio`,
`clicky-dev-setup-doctor`, `clicky-email-assistant`, `clicky-google-workspace`,
`clicky-repo-operator`, `clicky-research-report`, `cua-driver`, `doc`,
`frontend-design`, `obsidian`, `pdf`, `spreadsheet`, `vercel-deploy`. The bad
claim came from listing the directory with a `-File` filter, which finds no files
in a tree made entirely of subdirectories. Both surveys had read the right
directories all along.

The bundle has three distinct markdown sets, and the two surveys cover two of
them. They are **complements, not a total**:

| Population | Location | Count | Survey |
|---|---|---|---|
| App guides | `Resources/*.md` (flat) | 25 | `APP-GUIDES-SURVEY.md` |
| Workflow skills | `Resources/ClickyBundledSkills/<name>/SKILL.md` | 15 | `CLICKY-SKILLS.md` |
| Shipped contract | `Resources/ClickyModelInstructions.md` | 1 file, 106 lines | `PROMPT-GAP.md` |

"25 guides + 15 skills" is not 40 of their docs read — the first set is
app-shaped UI automation reference and the second is workflow routing. Two names
in the contract are not skill directories at all: `composio` and the
`computer-use` MCP server are runtime integrations, and `jev-use` is an optional
third-party MCP server. Neither ships in the bundle, consistent with the contract
stating that dedicated browser MCPs are not bundled in this release.
