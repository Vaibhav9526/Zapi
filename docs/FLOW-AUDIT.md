# Typed-chat + artifacts flow trace audit

Date: 2026-09-28. **Report-only - no source file was modified by this pass.**
The only file written is this document.

> **Tree state.** `src/main/index.ts` was rewritten twice while this audit ran (10:19:18 and
> 10:32:46 local) and `src/main/companion-manager.ts` once (10:17:29). Citations are against
> the 10:32:46 tree, and every check in section 6 was run on it. Important: the second
> `index.ts` rewrite **added** the `ARTIFACT_LIST/OPEN/REVEAL` and `TEXT_TURN` handlers that
> were missing (and flagged by `preload-check.mts`) earlier in the same session, so those
> earlier "no ipcMain handler" failures are now resolved - this report audits the current
> code. Anchor on the named symbols if a number drifts.

How to read a hop: **VERIFIED** = the value is present and consumed correctly at that hop,
with the evidence cited. **BROKEN** = the value is dropped, defaulted, or routed somewhere
that cannot use it. **[NOTE]** = correct, but worth knowing.

---

## 1. Verdict summary

| Flow | Verdict | Broken hops |
|---|---|---|
| 1. Typed chat: `TEXT_TURN` -> panel Chats tab | **VERIFIED end to end in the panel** | none in the panel path |
| 1b. Same turn as seen by the **stream window** | **BROKEN** | `CHAT_ENTRY_ADDED` is panel-only (`index.ts:395`) while the stream subscribes (`StreamApp.tsx:315`) |
| 2. Artifacts: `[FILE:]` -> `writeArtifact` -> `artifactIds` -> panel piles -> `ARTIFACT_OPEN` | **VERIFIED end to end in the panel** | none in the panel path |
| 2b. Artifacts as seen by the **stream window** | **BROKEN** (same single hop) | same `index.ts:395` gap: `StreamApp.tsx:343/353/905-925` never receives `artifactIds` live |

`agentId` itself is **never dropped or misrouted** anywhere in either flow - it is threaded
from the Chats tab's filter selection through to the chat store's per-agent key, the usage
counter, the agent-status emit and the artifact directory. The only defect is the *last*
hop of both flows, where the sealed `ChatEntry` (which carries `agentId` and `artifactIds`)
is broadcast to one of its two subscribers.

---

## 2. Flow 1 - typed chat, hop by hop

| # | Hop | Where | Verdict |
|---|---|---|---|
| 1.1 | Target agent for the composer | `panel/ChatsTab.tsx:129` `selectedAgentId = agentFilter ?? 'main'` | VERIFIED - a selected agent's chat targets it; the merged 'All' view targets `main` (`:126-128`) |
| 1.2 | Send guard | `ChatsTab.tsx:134-140` - empty draft, or that agent's phase thinking/acting/waiting, blocks the send | VERIFIED (input locked while the agent runs, `:131-132`) |
| 1.3 | Renderer -> preload | `ChatsTab.tsx:138` -> `preload/index.ts:127-128` sends `{ agentId, text }` on `IPC.TEXT_TURN` | VERIFIED - payload shape matches the handler exactly |
| 1.4 | Channel contract | `shared/types.ts:657` `TEXT_TURN: 'text-turn'` | VERIFIED |
| 1.5 | Main handler | `index.ts:902-906` destructures `{ agentId, text }`, defaults `agentId ?? 'main'` / `text ?? ''`, `void companion.runTextTurn(...)` inside a `.catch` | VERIFIED - `send` (not `invoke`), so fire-and-forget is the right shape and the catch keeps a rejection from escaping unhandled |
| 1.6 | Entry point | `companion-manager.ts:1726-1728` `runTextTurn` -> `runQueuedTask(agentId ?? AGENT_ID_MAIN, text ?? '', 'typed', 'typed turn')` | VERIFIED |
| 1.7 | Queue guard + turn ownership | `companion-manager.ts:1693-1704` - trim, skip when `isRecording / pendingStart / voiceState !== 'idle'` (`:1695-1698`), bump `turnId` (`:1702`), then `processUserText(trimmed, { source, agentId })` (`:1704`) | VERIFIED - `agentId` is the first positional arg and rides into opts |
| 1.8 | Source discrimination | `companion-manager.ts:1276-1281` - the `opts.source` union includes `'typed'`; `fromVoice` false; `turnAgentId = opts?.agentId ?? AGENT_ID_MAIN` | VERIFIED |
| 1.9 | Voice-only branches skipped | `:1305-1313` (agent stop, via `agentLive`), `:1326`, `:1331`, `:1342`, `:1351`, `:1376` - every voice branch is gated on `fromVoice` | VERIFIED - a typed "zapi agent ..." message is **not** diverted to the agent loop and typed text is never forced to dictate, matching `runTextTurn`'s doc (`:1720-1725`) |
| 1.10 | Turn completion keeps the agent | `:1400` sets `processing`, `:1402` captures screens, `:1456` calls `completeTalkTurn(text, fullText, usage, isCurrent, turnAgentId, !fromVoice)` | VERIFIED |
| 1.11 | Completion signature | `:1493-1500` `completeTalkTurn(userText, fullText, usage, isCurrent, agentId = AGENT_ID_MAIN, announce = false)` | VERIFIED |
| 1.12 | Chat append | `:1531-1536` `chatHistory.append(agentId, { userText, assistantText: cleanText, kind: 'talk', ...artifactIds })` | VERIFIED - `cleanText` is tag-stripped at `:1504` |
| 1.13 | Store keys the row by agent | `services/chat-history-store.ts:126-148` - stamps `agentId` on the entry (`:133`), `read: entry.read ?? false` (`:139`), files under `map[agentId]` (`:142`) | VERIFIED |
| 1.14 | Usage attribution | `companion-manager.ts:1538` `usageStore.recordTalkTurn(agentId)` | VERIFIED |
| 1.15 | Emit | `companion-manager.ts:1537` -> `index.ts:395` `onChatEntryAdded: (entry) => sendToPanel(IPC.CHAT_ENTRY_ADDED, entry)` | VERIFIED for the panel |
| 1.16 | Panel Chats tab receives | `ChatsTab.tsx:73-86` - drops other agents' entries (`:78`), appends the whole entry (`:79`, so `agentId`/`artifactIds` survive into state), clears live streaming (`:80-81`), marks read (`:85`) | VERIFIED |
| 1.17 | Panel Home cards receive | `HomeTab.tsx:118-124` - `owner = e.agentId ?? 'main'` (`:119`), last-message map (`:120`), unread dot (`:121`), pile refresh (`:122`) | VERIFIED |
| 1.18 | Mark-read round trip | `ChatsTab.tsx:85` -> `preload:124` (sends a **bare** `agentId` string) -> `index.ts:895-898` accepts `string \| { agentId }` -> `chat-history-store.markRead(agentId)` (`:156-168`) | VERIFIED - the dual-shape handler exists exactly because preload sends the bare id |
| 1.19 | Read-back on reload | `ChatsTab.tsx:56-62` (per agent), `HomeTab.tsx:79` and `StreamApp.tsx:249-262` (merged) -> `index.ts:921` -> `companion-manager.ts:622-624` (`undefined` -> `getAll()`, else `list(agentId)`) | VERIFIED |
| 1.20 | **Stream window receives the entry** | `index.ts:395` is panel-only; `StreamApp.tsx:315` subscribes via `preload:358-362` | **BROKEN** - section 4 |

Two shape notes on this flow: the dictation branch also appends a chat entry
(`companion-manager.ts:1364-1369`) but hardcodes `AGENT_ID_MAIN` - correct, because voice has
no agent targeting; and the agent-run variant of the same emit is
`services/agent-orchestrator.ts:420-426` (`chatHistory.append(this.id, ...)` ->
`deps.onChatEntryAdded(entry)`), which lands on the same single emitter and therefore hits
the same break (section 4.3).

---

## 3. Flow 2 - `[FILE:]` artifacts, hop by hop

| # | Hop | Where | Verdict |
|---|---|---|---|
| 2.1 | Model contract | `services/prompts.ts:61-91` tells the model to emit one `[FILE:...]` block per deliverable | VERIFIED - the three-way contract (prompt / parser / pipeline) is intact |
| 2.2 | Parse (talk turns) | `companion-manager.ts:1520` `parseFileTags(fullText)` -> `services/element-detector.ts:376-386` (`FILE_TAG_REGEX:346`, `trimBlockEdges:354-356`) | VERIFIED - parsed from the **raw** reply while display uses the stripped text (`:1504-1505`, `:1555`), so a `[POINT:]` inside a file body can never draw |
| 2.3 | Parse (agent runs) | `services/agent-orchestrator.ts:305` same parser, same contract | VERIFIED |
| 2.4 | Write (talk) | `companion-manager.ts:1522` `artifactStore.writeArtifact(agentId, file.filename, file.content)` -> `services/artifact-store.ts:265-287`: per-agent dir (`:270-271`), `sanitizeFilename` (`:272` -> `:80`), `uniquePath` never overwrites (`:241-253`), containment assert (`:276-278`), atomic write (`:279`) | VERIFIED - `agentId` selects the directory, so a typed turn to `scout` files under `artifacts/scout/` |
| 2.5 | Write (agent run) | `agent-orchestrator.ts:307` `writeArtifact(this.id, ...)` | VERIFIED |
| 2.6 | Each write isolated | `companion-manager.ts:1521-1528` and `agent-orchestrator.ts:306-315` wrap every write in try/catch | VERIFIED - a rejected filename or full disk cannot kill the turn |
| 2.7 | Record | `artifact-store.ts:221-233` `add()` - stamps `id`/`createdAt` (`:224-225`), files under `map[full.agentId]` (`:228`), caps per agent (`:230`) | VERIFIED |
| 2.8 | Ids are unique per write | `artifact-store.ts:207-213` `newId()` = ms + counter + 6 random chars; `byId` (`:195-201`) scans every agent's pile | VERIFIED - the id is a safe addressing key across agents, which is why the open/reveal hop needs no `agentId` |
| 2.9 | Ids collected | `companion-manager.ts:1518`+`:1523` `artifactIds`, `:1519`+`:1524` `artifactTitles`; `agent-orchestrator.ts:203`+`:309` `runArtifactIds` | VERIFIED |
| 2.10 | Ids stamped on the chat entry | `companion-manager.ts:1535` and `agent-orchestrator.ts:424` - spread only when non-empty, so a turn without files gains no empty array | VERIFIED |
| 2.11 | Ids persisted with the entry | `chat-history-store.ts:126-148` stores the whole `ChatEntry`; `shared/types.ts:345` `artifactIds?: string[]` | VERIFIED - round-trip proven by `chat-smoke` (append -> flush -> fresh-process read) |
| 2.12 | Ids reach the panel | `index.ts:395` -> `ChatsTab.tsx:79` (kept in state; no UI - see 5.2) and `HomeTab.tsx:122` `if (e.artifactIds?.length) loadPiles()` | VERIFIED |
| 2.13 | **Ids reach the stream** | same gap as 1.20 | **BROKEN** - section 4 |
| 2.14 | Panel pile data source | `HomeTab.tsx:95-106` `getArtifacts()` with no argument -> `preload:112-113` -> `index.ts:849` `artifactStore.list(agentId)` -> `artifact-store.ts:188-192` (omitted id = merged newest-first across agents) -> grouped 3-per-agent (`HomeTab.tsx:100-103`) | VERIFIED - one invoke serves every card; `undefined` is a deliberate merged view, not an accidental default |
| 2.15 | Stream pile map | `StreamApp.tsx:496-509` (mount) and `:521-535` (refetch when `missingArtifactKey` at `:511-519`) both call `getArtifacts()` merged, keyed by id | VERIFIED - the refetch covers the store-write race the comment describes (`:492-495`) |
| 2.16 | Panel chips -> open/reveal | `HomeTab.tsx:625-655` - click opens (`:632`), right-click reveals (`:637`), the `↗` affordance reveals (`:648-651`) | VERIFIED |
| 2.17 | Stream chip -> open | `StreamApp.tsx:915` `window.flicky.openArtifact(id)` inside the `t.artifactIds.map` at `:907` | VERIFIED - unresolvable ids render `null` (`:908-909`) until the refetch fills the map |
| 2.18 | `ARTIFACT_OPEN` handler | `preload:114` sends `{ id }` -> `index.ts:850-868` - `byId` (`:851`), missing -> `reportAgentError` (`:853`), `shell.openPath` (`:858-867`) with **both** the resolve-with-error-string and the reject path reported | VERIFIED |
| 2.19 | `ARTIFACT_REVEAL` handler | `preload:115` -> `index.ts:869-882` - `byId`, `shell.showItemInFolder` inside try/catch | VERIFIED |
| 2.20 | Addressing | open/reveal carry **only** `{ id }`; ownership is not part of the hop | VERIFIED by design (ids are unique per write, `byId` is cross-agent). [NOTE] 5.4 |

---

## 4. The one broken hop

### 4.1 The defect

`src/main/index.ts:395`

```ts
onChatEntryAdded: (entry) => sendToPanel(IPC.CHAT_ENTRY_ADDED, entry),
```

`CHAT_ENTRY_ADDED` is the **only** event whose payload carries `agentId` and `artifactIds` -
`StreamApp.tsx:306-314` says so explicitly ("The entry is the only event carrying
artifactIds/agentId"), and `types.ts:333-346` agrees. The stream subscribes at
`StreamApp.tsx:315` through `preload:358-362`, but main only ever sends it to the panel
window. A repo-wide search for `CHAT_ENTRY_ADDED` / `onChatEntryAdded` finds exactly one
emitter (`index.ts:395`) and two live subscribers (`ChatsTab.tsx:75`, `HomeTab.tsx:118`) plus
the stream's dead one. Every sibling emitter in the same callback block does fan out -
`TRANSCRIPT_UPDATE` uses `sendToAll` (`index.ts:326`), and `AI_RESPONSE_CHUNK` /
`AI_RESPONSE_COMPLETE` / `AI_ERROR` each call `sendToStream` explicitly (`:327-338`) - so the
omission is a one-line gap, not a design decision.

Fix: `onChatEntryAdded: (entry) => sendToAll(IPC.CHAT_ENTRY_ADDED, entry),` (or add the
missing `sendToStream(...)` beside the existing `sendToPanel`).

### 4.2 What the stream loses - two independent mechanisms

1. **Typed / routine / suggestion turns vanish from the live feed entirely.** Those paths
   emit no `TRANSCRIPT_UPDATE` (a typed turn never touches the mic), so the stream has no
   seeded row and `currentIdRef.current` stays `null`; `StreamApp.tsx:287-293` then drops
   every `AI_RESPONSE_CHUNK` (`if (!id) return`), and the entry that would have created the
   row never arrives (`:315`). The reply is visible in the panel and on the overlay, and
   shows up in the stream only after the window reloads and re-reads `GET_CHAT_HISTORY`
   (`:249-262`).
2. **Voice and agent turns render but stay unattributed.** A PTT/VAD turn does seed a row
   from the transcript, so its text streams; but without the entry, `entryId`, `agentId` and
   `artifactIds` are never attached (`:347-356`). Consequences: the agent label falls back to
   `agentName(profiles, t.agentId ?? 'main')` (`:896`), so a non-main turn is labelled
   'main', and the per-turn file pile at `:905-925` never renders for a fresh turn. An agent
   run is the milder case: `agent-orchestrator.ts:430-431` does push the summary chunks, so
   the row exists - just without its `agentId`/`artifactIds` until a reload.

### 4.3 Blast radius

- `agentId` loss: stream rows mislabel the owning agent (the store and the panel are fine).
- `artifactIds` loss: the stream's file piles are dead for live turns; the panel's Home piles
  and the whole `ARTIFACT_OPEN` path are unaffected, so files stay fully reachable from the
  panel.
- The panel - the surface the task names as the display target - is **not** affected, which
  is exactly why this reads as clean in a panel-only test.

### 4.4 Why the existing contract test does not catch it

`scripts/preload-check.mts` verifies that a channel has *an* emitter and that a subscription
has an emitter - not **which window** an emitter targets. It reports
`358 passed, 0 failed, 0 findings` on this very tree. A regression test for this hop has to
assert the broadcast set (that `onChatEntryAdded` reaches `sendToStream`); no current harness
does that.


---

## 5. Secondary findings (all non-blocking)

1. **Silent skip on a busy pipeline** - `companion-manager.ts:1695-1698` drops a typed turn
   with only a console log when the mic is live, a start is pending, or voice state is not
   idle. The composer's guard (1.2) covers only agent phases, so a typed message can be
   swallowed with no on-screen feedback and no chat entry.
2. **The Chats tab never renders `artifactIds`** - `ChatsTab.tsx:79` keeps them in state, but
   the tab contains no `openArtifact`/`artifactIds` reference at all, so a typed turn's files
   are discoverable only from the Home agent card (or the stream, once 4.1 is fixed). Not a
   data drop - a discoverability gap.
3. **Mark-read does not broadcast** - `index.ts:897` calls `chatHistory.markRead(agentId)`
   with no emit, while `HomeTab.tsx:121` lights an unread dot the moment an entry arrives
   with `read === false`. For a typed turn watched in the Chats tab the dot can stay lit until
   an unrelated settings change triggers `loadChats` (`HomeTab.tsx:125-128`, which recomputes
   from the store and clears it).
4. **No ownership check on open/reveal** - `index.ts:850` and `:869` resolve any id through
   the cross-agent `byId` and act on it. Fine for the current threat model (the only clients
   are our own context-isolated renderers, holding ids from our own events), but a
   `senderFrame`-scoped check would be cheap if artifact ids ever left the app.
5. **Per-agent separation is storage/UI, not model memory** - one shared `ContextManager`
   (`companion-manager.ts:153`, `:217`) receives every exchange, including the orchestrator's
   (`companion-manager.ts:267` -> `agent-orchestrator.ts:417`). A typed turn to `scout` and a
   turn to `main` share one rolling conversation window even though their chat rows, usage
   counters and artifact directories are separate. Pre-existing architecture, not a hop
   defect - but it is exactly what a "does the agentId survive?" question should surface.

---

## 6. Checks executed (read-only, on the 10:32:46 tree)

| Check | Command | Result |
|---|---|---|
| Typecheck (main) | `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit` | **PASS** |
| Typecheck (renderer) | `node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit` | **PASS** |
| Preload/IPC contract | `bun scripts/preload-check.mts` | **358 passed, 0 failed, 0 findings** - `TEXT_TURN`, `ARTIFACT_LIST/OPEN/REVEAL` and `CHAT_ENTRY_ADDED` all have handlers and emitters |
| Settings contract | `bun scripts/settings-parity.mts` | **PASS** - no contract drift |
| Artifact store smoke | `bun --preload ./scripts/store-preload.ts ./scripts/artifact-smoke.mts` | **138 passed, 0 failed** - sanitizing, containment, no-overwrite, per-agent + merged listing, `byId`, `inferKind`, disk flush |
| Parser smoke (`[FILE:]`) | `bun --preload ./scripts/store-preload.ts ./scripts/parse-smoke.mts` | **93 passed, 0 failed** - block parse, unclosed-block recovery, nested-tag swallowing, strip parity, orphan closers |
| Chat store smoke | `bun --preload ./scripts/store-preload.ts ./scripts/chat-smoke.mts` | **14 passed, 0 failed** - per-agent `agentId` persistence, fresh-process read-back, `read:false` + per-agent `markRead` |

## 7. Limits of this pass

- Static tracing plus the four harnesses above; no Electron runtime, so nothing was
  clicked through.
- `CompanionManager` was never instantiated (the stub-preload harness covers the stores and
  the parser, not the turn pipeline), so `processUserText` / `completeTalkTurn` behaviour is
  argued from source rather than observed.
- The `scripts/*-smoke.mts` runs above need `bun --preload ./scripts/store-preload.ts`; the
  `bunx tsx` form used in `REPORT.md` does not resolve in this environment.
- The hop tables cover the two flows as asked. `SUGGESTION_*` shares the artifact and
  chat-entry emit paths and was traced only where it intersects them (`index.ts:884-891`,
  `companion-manager.ts:1737-1751`).

