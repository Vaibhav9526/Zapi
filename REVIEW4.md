# REVIEW4 — agent runtimes: concurrency, input lease, voice isolation, agentId routing

Report-only. **No source file was modified by this pass.**

**Scope read end-to-end:** `src/main/services/agent-orchestrator.ts` (478 lines),
`src/main/services/input-lease.ts` (138 lines), the agent/voice sections of
`src/main/companion-manager.ts` (~1908 lines), plus the counterparts needed to *verify* each
claim: `src/main/services/agent-driver.ts`, `auto-typer.ts`, `routines.ts`,
`settings-store.ts` (profiles), `chat-history-store.ts`, `usage-store.ts`,
`src/shared/types.ts` (agent + IPC block), `src/preload/index.ts`, `src/main/index.ts`
(agent IPC + status fan-out), and the agent-aware renderers (`OverlayApp.tsx`,
`StreamApp.tsx`, `panel/HomeTab.tsx`, `panel/ChatsTab.tsx`).

**Context:** this reviews the *Phase B* extraction described in `docs/PLAN-multi-agent.md`
(per-agent `AgentRuntime`, global input lease, voice turns routed to a target agent). The
intent is largely implemented — per-agent turn/abort state, per-agent chat + usage counters,
lease-serialized physical input, and abort signals actually threaded into the driver all
exist. The defects below are the seams where single-runtime assumptions survived.

Taxonomy (same as REVIEW3):
- **[CRITICAL]** — guaranteed, user-visible defect or a real correctness hole with no recovery path.
- **[MINOR]** — latent race, mis-attribution, or hardening gap.
- **[NIT]** — verified-correct-but-fragile, or a trap for the next edit.

> ⚠️ **Heads-up: the tree moved under this pass, and every finding was re-verified against the
> post-drift state.** While this review ran, a sibling agent landed ~+250 lines in
> `companion-manager.ts` (1908 → 2155) and ~+27 in `agent-orchestrator.ts` (478 → 505 — mostly
> the `[FILE:]`/artifact feature). `input-lease.ts` (138) and `agent-driver.ts` (469) are
> **unchanged**, so C4, M2, M8, N1(lease half), N2–N5 are unaffected.
>
> All six [CRITICAL] and all ten [MINOR] findings were **re-checked against the current on-disk
> code** and still reproduce: `AgentRuntime.stop` still nulls the controller (`:142–149`); `run`
> still has no single-flight guard (`:163`, `running = true` at `:171`, `try` at `:205`); the
> driver hooks still omit `agentId` (`:340–363`); the summary still goes out on the agentId-less
> response channel (`:429–431`) and `recordExchange` still hits the shared context (`:417`); the
> agent-trigger branch still has no voice-state release (`companion-manager.ts:1374–1391`).
>
> **Inline line numbers below are from the pre-drift snapshot; the refreshed symbol→line map at
> the end is authoritative.** Re-anchor by symbol name before fixing.
>
> **Stale-claim warning:** REVIEW.md C4 called a `[ACT:type]` batch ~90 s because of nut-js
> `autoDelayMs = 300` per character. That is **no longer true** — `auto-typer.ts:88` sets
> `autoDelayMs = 0` and the driver never raises it. Lease-hold math below uses the current
> driver, not the old estimate.

---

## [CRITICAL]

### C1. A voice-triggered **background** run never releases `voiceState` — always-on listening goes dead
`LocalTurnControl` (`agent-orchestrator.ts:47–67`) implements only `beginTurn` /
`currentTurnId` / `setAbort` / `currentAbort`. That is deliberate for `voiceState` (mic-side,
`main`-only — `agent-orchestrator.ts:37–43`), and `AgentRuntime.run` correctly guards every
voice touch with `deps.turn.setVoiceState?.(...)` (`:177`, `:409`, `:420`). **The gap is the
caller:** the voice pipeline sets `voiceState` for *every* turn it starts, assuming the turn's
owner will clear it.

- VAD: `processVadUtterance` sets `'processing'` (`companion-manager.ts:917`) and clears it only
  on its own early returns (`:927`, `:947`, `:953`, `:967`) — all *before* `processUserText` is
  awaited (`:962`).
- PTT: `startRecording` sets `'listening'` (`:1143`); nothing in the agent branch resets it.
- Agent trigger: `processUserText:1353–1370` calls
  `this.orchestrator.runTask(target.agentId, target.task)` and returns. For `main` the runtime
  owns voice and does `'acting'` → `'idle'` (`agent-orchestrator.ts:177`, `:420`). **For any
  other agent, `LocalTurnControl` has no `setVoiceState`, so neither call happens.**

**Failure (reproducible):** create a second agent ("Scout"), enable agent mode + always-on and
say *"zapi agent scout: open notepad"*. `resolveAgentTarget` returns Scout (`:1585–1602`), the
run lands on Scout's card, and `voiceState` stays `'processing'` (VAD) or `'listening'` (PTT)
**forever**:

1. `handleVadUtterance` drops every utterance — `if (this.voiceState !== 'idle' &&
   this.voiceState !== 'acting')` (`:861`) → **always-on listening is silently dead**. The
   `finally` at `:1240` *does* re-open the `'vad'` capture gate, so the mic looks live and
   nothing ever arrives — the exact "it stopped hearing me" failure REVIEW.md C1 was about.
2. The overlay pill / panel spinner stay pinned on `processing`/`listening`, and
   `runRoutineTask`'s `voiceState !== 'idle'` guard (`:1631`) starves every routine.
3. Recovery is accidental: a normal talk turn (`:1553`), a dictation turn (`:1349`),
   `speakLine` (`:1858`), `resetFromMicError` (`:483`), or the demo scene ending (`:1082`).
   **`stopAgent()` does not reset voice state** (it only broadcasts `AGENT_STATUS`, `:432–437`),
   so even *"zapi stop"* leaves the mic state stuck.

**Fix direction:** the voice turn that *starts* the run must own the release — capture
`ownsVoice`/the spawner in `processUserText`'s agent branch and reset voice state in a `finally`
around `runTask(...)`. (A background run still must not flip the mic state; the *spawning turn*
must be allowed to end.)

### C2. `AgentRuntime.run` has no single-flight guard — overlapping runs orphan a live controller
`run()` (`:157`) sets `this.running = true` (`:165`) but never checks it, and
`AgentOrchestrator.runTask` (`:451–453`) will happily await a second `run()` on the same cached
runtime (`runtimeFor`, `:442–448`). Reachable today: a PTT press while (or just after) Scout
runs → new voice turn → *"zapi agent scout: …"* again → `runTask('scout')` while run #1 is still
inside `await deps.streamMind(...)` or `await runAgentActions(...)`. `startRecording` only aborts
`this.currentAbort` (`companion-manager.ts:1129–1132`), which is **`main`'s** runtime abort — not
a background runtime's.

What the second run does to the first (`LocalTurnControl`, `agent-orchestrator.ts:47–67`):

- `beginTurn()` (`:161`) bumps the shared `turnId` → run #1's `isCurrent()` (`:164`) goes false at
  its next gate → run #1 returns **without recording its result** (no chat entry, no status).
- `setAbort(abort)` (`:163`) overwrites the turn's controller with run #2's. Run #1's controller
  is now unreachable from `stop()`, and **its signal was never aborted**.
- Run #1's `finally` (`:371–378`) then executes while run #2 is live: `this.running = false` is
  unconditional, so `isRunning` reports *false* for an agent that is genuinely working.
  `AgentOrchestrator.stop()` (bare) is gated on exactly that flag
  (`if (runtime.isRunning) runtime.stop()`, `:464–466`) → the tray / stream / `"zapi stop"` path
  **skips the live run** (only the named `stop(agentId)` path at `:459–463` still reaches it).
- During the whole orphan window run #1 keeps **executing physical input**: the batch inside
  `runAgentActions` is gated on `hooks.signal` (`agent-driver.ts:288–305`, `:448`) and run #1's
  signal was never aborted, so the cursor/keys keep moving. The user's superseding turn can only
  stop it at the next step boundary (up to the 90 s step timeout, `:190`, `:250–253`).
- Both runs share `this.lastScreenshots` (`:114`, `:215`). `parseAgentActions(fullText,
  screenshots)` (`:292`) hands the **same array reference** to `runAgentActions` (`:324`) and the
  contents are replaced wholesale each step. If run #2's capture lands mid-batch, run #1's
  `scaleFactorFor()` (`agent-driver.ts:106–119`) resolves the display scale factor from a
  screenshot that may no longer be the one the action was planned against → **pointer
  coordinates scaled by the wrong factor on mixed-DPI setups**.

**Fix direction:** make `run()` single-flight; if the intent is to supersede, abort
`deps.turn.currentAbort()` **before** `beginTurn()` (mirroring `startRecording` /
`processVadUtterance`, which abort *then* bump); only let the run that still owns the turn clear
`running` / `lastScreenshots`.

### C3. `agentId` is never threaded into the driver or the lease — every agent acts as `'main'`
Three places declare per-agent identity; none are wired:

1. **The lease.** `AgentRunHooks.agentId` is documented as "Identity for the input lease — the
   caller's agent id" (`agent-driver.ts:49–53`) and used as
   `acquireInputLease(hooks?.agentId ?? 'main', …)` (`:274`). The orchestrator's call site passes
   `onAction`, `signal`, `onLeaseWait` **and no `agentId`** (`agent-orchestrator.ts:314–337`).
   So **every runtime leases as `'main'`**: `leaseHolder()` / `leaseQueueLength()`
   (`input-lease.ts:45–52`), the `onQueued(waiting, position)` notifications (`:26–27`, `:54–60`)
   and therefore PLAN Phase C's *"overlay pill shows the lease-holder `<name>` working…"* all
   report the wrong agent.
2. **The action echo.** `AgentAction.agentId` exists (`shared/types.ts:144–147`, "Which agent
   performed this action (echo routing/attribution)"), `preload/index.ts:302–313` types it, and
   `OverlayApp.tsx:973–990` reads `payload.agentId` to pick the ripple's kaomoji/accent — but the
   driver's `onAction` payload is `{ x, y, label, kind }` only (`agent-driver.ts:434–439`) and the
   orchestrator forwards the same four fields (`agent-orchestrator.ts:326–328`). **`agentId` is
   always `undefined`**, so the other two consumers invent an owner instead: `StreamApp.tsx:342–353`
   ("AgentAction carries no agentId, so attribute the row to whoever…") picks the most recently
   updated status, and `panel/HomeTab.tsx:25`, `:47–53` picks the *first* agent whose phase is
   `acting`/`thinking`. With two runtimes live, actions are routinely labelled with the wrong
   agent's name/face — and a `waiting` agent's own actions get attributed to whoever is acting.
3. **The lease's "am I still the holder?" test is a string compare, not a fencing token.**
   `makeRelease(agentId)` does `if (holder === agentId) holder = null;` and then
   **unconditionally** shifts the queue and promotes the next waiter (`input-lease.ts:67–84`).
   Today that happens to be safe *only because* every caller passes the identical string `'main'`
   (see #1) and each acquisition yields exactly one idempotent release closure. Once #1 is fixed
   — or a duplicate release is possible — `holder === agentId` can no longer distinguish "me" from
   "another live batch of the same agent", and a release from a batch that is *not* the holder
   clears the holder slot and promotes a third agent **while the real holder is still driving the
   cursor**. Fixing #1 without a grant token turns a latent hole into a live one.

**Fix direction:** pass `agentId: this.id` in the hooks at `agent-orchestrator.ts:314–337`; stamp
it on the echo (`deps.onAction({ ...a, agentId: this.id })`, widening `AgentRuntimeDeps.onAction`);
and replace `makeRelease(agentId)`'s identity check with a lease *ticket* (opaque object /
counter returned by `acquireInputLease`) so release can prove ownership.

### C4. The lease has no holder watchdog and no retry — one stuck holder permanently breaks input for everyone
`input-lease.ts:17–23` states the guarantee:

> "Rejects with 'input lease wait timed out' after this long. A stuck holder (driver bug, hung
> native call) must not deadlock every other agent forever. Default 60s."

The implementation only times out **waiters** (`:112–117`). Nothing times out, steals, or fences
the **holder**; the holder's own release is the only path that promotes the queue (`:73–82`). So:

- A hung `typeText` / `mouse.*` native call (the driver loads libnut lazily *because* it can be
  "missing or broken" — `agent-driver.ts:6–11`) holds the lease forever. Every other agent then
  fails **every step** with `couldn't get input control — input lease wait timed out`
  (`agent-driver.ts:456–462`), with no retry, no backoff and no way to reclaim the lease short of
  restarting the app. The documented guarantee is therefore false: the timeout converts *infinite
  waiting* into *permanent functional failure for all agents*.
- Even without a hang, the 60 s default is shorter than a **legal** batch.
  `MAX_ACTIONS_PER_BATCH = 30` (`agent-driver.ts:78`) with `[ACT:wait:5000]` clamped to
  `MAX_WAIT_MS = 5000` (`:72`, `:416–418`) → one legal batch can deliberately hold the lease for
  **150 s** before pointer/type latency and `ACTION_GAP_MS = 140` (`:71`). Every co-agent step
  overlapping it times out and burns a step of its own budget. `AcquireOptions.timeoutMs` is
  exposed (`input-lease.ts:23`) but never passed by the only call site (`agent-driver.ts:274–282`).
- The queue is strictly FIFO with **no priority** for the mic-owning/interactive agent (`:73–82`).
  With N background agents, the user's own turn queues behind every batch ahead of it and can time
  out repeatedly — the honest fix (a priority band for `main`, or a per-turn lease deadline) is
  absent.

**Fix direction:** holder deadline + fencing token (grant id) with `forceRelease(grantId)`; driver
retries a timed-out acquisition with backoff until the turn signal aborts; pass an explicit
`timeoutMs` for interactive turns; consider promoting `main`'s wait to the queue head.

### C5. Background-agent output leaks into the foreground chat/stream **and** into every agent's memory
`AgentRuntime.run`'s completion block carefully scopes voice (`ownsVoice`), scene clear, chat
history and usage to the run's own id (`:394–400`) — and then emits the summary on the
**agentId-less** foreground channel:

```
402 |   // The transcript seeded a stream turn; fill it with the summary.
403 |   deps.onAiResponseChunk(cleanSummary);
404 |   deps.onAiResponseComplete(cleanSummary);
```

`AI_RESPONSE_CHUNK` / `AI_RESPONSE_COMPLETE` carry a bare `string` (`preload/index.ts:264–274`,
`index.ts:286–293`) and `StreamApp.tsx:252–269` appends/replaces the text of
`currentIdRef.current` — the turn seeded by the **last final transcript**, i.e. the user's own
conversation. So:

- If a talk turn is open when a background run finishes, `AI_RESPONSE_COMPLETE` **overwrites that
  turn's text with Scout's summary** and marks it not-streaming (`StreamApp.tsx:260–268`) — the
  user's answer is replaced by another agent's one-liner.
- If no turn is open, the summary is dropped, so the one surface that could have shown Scout's
  work shows nothing. Either way the background agent's result lands in the wrong chat, and no
  agent-scoped turn channel exists in the contract. Routine turns use the same channel
  (`completeTalkTurn` → `onAiResponseComplete`, `:1484`), so this is not a one-off.

The larger leak is memory: `deps.recordExchange` maps straight onto the **single** shared
`ContextManager` (`companion-manager.ts:262`) and `streamMind` feeds
`this.context.getMessagesForSend()` to the model for talk turns (`:1455`). Every background run's
`task:` / summary is appended to the memory that `main` (and every other agent's turn) later sends
as prompt history — one agent's task becomes another agent's context. Isolation exists for the
*chat card* and *usage counters*, not for the *model's* memory.

Two smaller leaks in the same family (the "a background agent must never speak over the user"
rule):

- `announceCompletion` checks `voiceState` and then **awaits** TTS with no re-check
  (`:1666–1670`): `synthesizeSpeech(spoken).then(audio => { if (audio) this.playSpeech(audio); })`.
  A PTT press during the seconds-long synthesis flips `voiceState` to `'listening'`, and the
  announcement then plays **over the user's recording** — the gate is applied before an `await`
  instead of after it, unlike every other playback site (which re-checks `isCurrent()`).
- `showTransientBanner` → `startScene` begins with `this.clearSceneTimers()` (`:1016`), wiping the
  *foreground* turn's pending scene beats and replacing `sceneTimers`. A background agent finishing
  mid-answer silently truncates the scene the user's answer is drawing.

**Fix direction:** add `agentId` to the response channel (or per-agent turn channels) and route
per agent in `index.ts` / `StreamApp`; give each agent its own `ContextManager` (or tag exchanges
and filter `getMessagesForSend` by the asking agent); move the announcement's voice gate after the
`await`; make scene timers scene-scoped instead of one shared array.

### C6. Orchestrator `stop()` nulls the turn controller the voice-stop probe depends on
`AgentRuntime.stop()` aborts and then **nulls** the turn's controller (`:136–143`). For `main`
that controller *is* `CompanionManager.currentAbort` (`companion-manager.ts:248–251`). The
voice-stop path's liveness probe requires it to be non-null:

```
1292 |     const agentLive =
1293 |       fromVoice &&
1294 |       this.voiceState === 'acting' &&
1295 |       this.currentAbort !== null &&
1296 |       !this.currentAbort.signal.aborted;
```

So after any stop (button, tray, `"zapi stop"`), a **second** stop utterance arriving while the
run is still unwinding (`voiceState` stays `'acting'` until `run()`'s `finally`,
`agent-orchestrator.ts:371–384`) fails the probe and falls **through** the agent branches
(`:1297–1311`) into a normal talk turn: `setVoiceState('processing')`, a screenshot, a model call —
with the word "stop" as the user's message, *while the physical driver may still be finishing an
action*. The window is one unwind, but it is exactly the window a user in a panic presses stop in.

**Fix direction:** abort without nulling (leave the aborted controller installed until the run's
`finally` clears it), and/or base `agentLive` on an explicit `runInFlight` flag rather than the
controller's presence.

---

## [MINOR]

### M1. Two due routines fire concurrently, and the later turn bump silently discards the earlier reply
`RoutineScheduler.tick()` fires **every** due routine in one synchronous pass and stamps
`markRun` immediately (`routines.ts:65–83`); the consumer is
`onFire: (routine) => { void this.runRoutineTask(routine); }` (`companion-manager.ts:218`) — not
awaited, so N due routines all enter `runRoutineTask` (`:1628–1645`) at once. The first one's
guard (`voiceState !== 'idle'`) passes, and its `voiceState` flip happens *after* an `await`
(`:1379–1385`), so a second routine starting in the same tick also passes. Each then does
`this.turnId += 1` (`:1638`), so the later bump invalidates the earlier turn's `isCurrent()`: its
`mindCallbacks.onComplete` returns early (`:1427`) and its reply **never reaches its chat** — after
the model call was already paid for and while `AI_RESPONSE_*` may already have streamed. Unlike
`startRecording` / `processVadUtterance`, `runRoutineTask` bumps the turn **without aborting** the
previous controller (`:1638` vs `:1129–1132`, `:899–902`), so the orphaned stream keeps its
provider socket open until it finishes.

**Fix:** serialize routine turns (a busy flag / promise chain in `runRoutineTask`) and abort-then-
bump like every other turn entry point.

### M2. Non-leased physical input: dictation and `[TYPE:]` typing bypass the input lease
The lease is the *global* mutex for physical input (`input-lease.ts:1–12`), and the only acquirer
is `runAgentActions` (`agent-driver.ts:274`) — verified: no other module imports
`acquireInputLease`. But `typeText()` drives the real keyboard (`auto-typer.ts:88–108`) from three
places, two of which never take the lease: the dictation branch (`companion-manager.ts:1333`) and
the `[TYPE:]` fulfillment loop in `completeTalkTurn` (`:1522–1537`). So while a **background**
agent holds the lease mid-batch, a voice turn's `[TYPE:]` (or a dictation turn started after a PTT
abort) types into whatever field the agent's last action focused — the exact "type burst split by
another agent's action" failure the lease exists to prevent. Related: the comment at `:1124–1127`
("including a running agent loop, whose `AbortController` dies here") is now true only for `main`
— a PTT press no longer interrupts background runtimes (see C2), so an agent can keep the cursor
while the user records.

**Fix:** make `typeText`'s callers acquire a short lease, or route dictation/`[TYPE:]` through the
driver's lease helpers.

### M3. Stopping one agent cuts the foreground agent's speech
`stopAgent(agentId)` → `orchestrator.stop(agentId)` and then `this.stopSpeech()` unconditionally
(`:422–438`). Stopping Scout (stream Stop button → `window.flicky.agentStop(primaryStatus.agentId)`)
therefore kills whatever `main` is currently speaking. "zapi stop" should cut speech; a per-agent
stop should not reach the mic surface at all.

### M4. The orchestrator drops the "lease granted" transition — the card stays `waiting` for the rest of the batch
`onLeaseWait(queued)` is documented to fire `false` "once the lease is held or skipped"
(`agent-driver.ts:54–59`), and the driver really does call it (`:283–287`). The orchestrator only
acts on `true`:

```
330 |             onLeaseWait: (queued: boolean) => {
331 |               if (!isCurrent()) return;
332 |               if (queued) this.emit({ phase: 'waiting', step, maxSteps });
333 |             },
```

So once the wait ends the agent stays `phase: 'waiting'` until the next emit after the batch
returns — the status card lies for the whole batch. Compounding it: `AgentPhase 'waiting'` is not
counted as running by either consumer (`index.ts` tray: `phase === 'acting' || 'thinking'`;
`StreamApp.tsx:288` same), so an agent queued for input shows **no stop affordance** exactly when
the user most wants to cancel it. Handling `false` (and treating `waiting` as running) closes both.

### M5. `lastAgentStatus` is a single last-writer-wins slot — another agent's idle greys out the tray's Stop
`index.ts:58–59` keeps one `lastAgentStatus`, overwritten by every `AGENT_STATUS` (`:324–331`),
and the tray's "Stop agent" item is enabled from it. `AgentRuntime.stop()` emits `idle` for its own
agent (`agent-orchestrator.ts:142`) and `stopAgent()` emits one more (`:432–437`), so a *background*
agent finishing (or being stopped) overwrites the slot and **disables Stop while `main` is still
acting**. The slot needs to be a per-agent map — the renderers already key by `agentId`; only this
consumer does not.

### M6. Agent-name routing is unguarded — profiles can hijack or capture the wrong utterance
`resolveAgentTarget` (`:1585–1602`) matches `\b<name>\b` **anywhere in the transcript**, over
*every* profile (`settingsStore.listAgents()` includes archived ones), with no uniqueness or
reserved-word check anywhere: `createAgent` / `renameAgent` accept any non-empty name
(`settings-store.ts` — no collision test) and `archiveAgent` only flips a flag. Failure modes: an
agent named "it" / "open" / "stop" captures unrelated utterances; two agents with the same name
resolve by longest-name-then-insertion order, silently; renaming an agent changes where its
*pending* utterances route; and an archived agent remains a valid routing target with a live
runtime (nothing is stopped or evicted — `index.ts:840–849`'s comment "Phase A has one runtime —
so there is no in-flight work to stop" is stale), so it can receive and drive work after the user
archived it.

**Fix:** require unique names, exclude archived profiles from routing, exclude the wake/stop
vocabulary, and prefer an explicit address form (`<name>:` lead) over a substring match.

### M7. `agentMaxSteps` is read globally, not per profile
`AgentRuntime.run` reads `settingsStore.getAll().agentMaxSteps` (`:159–160`) for **every** agent and
the only setter is global (`companion-manager.ts:399–404`). PLAN Phase B/D said "Keep
`agentMaxSteps` per-agent (settings on the profile)". Today, moving the slider mid-session
retroactively changes the budget of running background agents too.

### M8. Lease timeout leaks the abort listener and re-notifies the queue from a dead waiter
The timeout path removes the waiter from the queue and rejects but **never calls `detach(w)`**
(`input-lease.ts:112–117`), unlike the other two removal paths (`:75`, `:128`). The `'abort'`
listener therefore stays attached to the caller's signal — for an agent run that signal lives for
the whole run (`agent-orchestrator.ts:162`; the per-step `stepAbort` is separate) — so repeated
timeouts across steps accumulate listeners (Node warns past 10 per signal) and each stale listener
later calls `notifyWaiters()` (`:129`), spurious-firing every remaining waiter's
`onQueued(true, pos)`, which its owner maps to a fresh `waiting` status emit.

### M9. `this.running = true` sits outside the `try`
`AgentRuntime.run` sets `this.running = true` at `:165`, but the `try` only opens at `:196`; the
intervening calls (`deps.clearSceneTimers()`, `deps.onSceneClear()`, `deps.onStatus`, the log) run
plumbing that ends in `index.ts` fan-out. One throw there latches `isRunning` true forever, which
permanently changes `orchestrator.stop()`'s bare path (it keeps calling `stop()` and aborting
whatever controller the turn holds) and any watchdog later built on that flag.

### M10. Failed background runs are never announced
`maybeAnnounceAgentDone` returns unless `status.phase === 'done'` (`:1702–1706`), while the run's
chat entry records the failure ("couldn't finish that.", `:387–390`). A background agent that dies
on a provider error or the step cap is invisible unless the user opens its card — asymmetric with
"a done announcement for every completion path" in `docs/PLAN-multi-agent.md` (Phase D), and it
gets no banner and no TTS at all where success gets both.

---

## [NIT]

### N1. `orchestrator.stop(id)` skips the `isRunning` check the bare path has — naming `main` can abort a talk turn
`stop(agentId)` calls `this.runtimes.get(agentId)?.stop()` unconditionally (`:459–463`), while the
bare branch only stops `if (runtime.isRunning)` (`:464–466`). For `main`, the runtime's
`currentAbort` **is** `CompanionManager.currentAbort`, which talk turns also install and clear
(`companion-manager.ts:1411–1412`, `:1461`) via the deps at `:248–251`. So `AGENT_STOP` with
`agentId: 'main'` (reachable from any renderer that remembers a status) aborts an in-flight
**talk** turn's LLM stream and nulls the controller, even though no agent was running. Either make
both paths consult `isRunning`, or give talk turns their own controller field so the two cannot
alias.

### N2. `stop()` on an idle runtime still emits `{ phase: 'idle', step: 0, maxSteps: 0 }`
`AgentRuntime.stop()` emits unconditionally (`:142`) — even when nothing was running — which
overwrites `status`/`lastAgentStatus` and forces a tray rebuild (`index.ts:327–330`). Harmless
today, but it means "idle" is not a reliable "a run just ended" signal for anything that wants one.

### N3. `runtimeFor` never evicts, and `getStatus` returns `null` for never-run agents
`runtimes` is an unbounded cache (`:442–448`); archived agents keep their runtime and its
`LocalTurnControl` (turn id / controller) for the session, which is part of M6's problem. Also
`getStatus(agentId)` returns `null` rather than a synthesized idle status (`:469–471`), so a caller
rendering a card must handle both `null` and `{phase:'idle'}` for the same visual state.

### N4. `onQueued`'s `position` is dead API surface at the only call site
`AcquireOptions.onQueued(waiting, position)` is documented and carefully computed
(`input-lease.ts:26–27`, `:54–60`), but the sole consumer ignores the position and keeps only a
boolean (`agent-driver.ts:271–287`, `announcedWait`). PLAN Phase C wanted queued agents to read
"`<name>` waiting"; either consume it or drop it.

### N5. The "waiting cleared" signal depends on a flag the release path just overwrote
In the driver, `announcedWait = waiting` is set by the `onQueued` callback
(`agent-driver.ts:276–277`), and the release path fires `onQueued(false, 0)` right before resolving
(`input-lease.ts:78`), so `announcedWait` is already `false` when the acquire resolves and the
driver's own explicit `onLeaseWait(false)` (`:283–287`) is **skipped**. Invisible today only
because the orchestrator ignores `false` anyway (M4) — the two mechanisms will fight once M4 is
fixed.

### N6. `IPC.TEXT_TURN` / `IPC.CHAT_MARK_READ` have no main-process handler
`preload/index.ts:124–128` exposes `markChatRead(agentId)` and `sendTextTurn(agentId, text)`, but
no `ipcMain` registration exists for either channel (verified across `src/main`). Agent-typed turns
and per-agent read state are therefore unreachable from the panel — `agentId` routing is voice-only
today, which is also why C1's trigger path is the *only* way to start a background run. (Known
REVIEW3 item #6; it now blocks half the multi-agent UX.)

### N7. Stale single-runtime comments now contradict the code
- `index.ts:840–843` — "Any other agent can't be mid-run yet — Phase A has one runtime" (it can;
  see M6).
- `companion-manager.ts:1124–1127` — "including a running agent loop, whose `AbortController` dies
  here" (true for `main` only; see M2/C2).
- `agent-orchestrator.ts:423–430` — "Physical input is serialized by the driver's input lease;
  reasoning runs concurrently" (true, but the lease identity is `'main'` for everyone; see C3).

---

## Verified clean (checked, no defect found)

- **Abort reaches a queued lease wait.** `acquireInputLease` handles an already-aborted signal and
  an abort while queued (`input-lease.ts:119–133`), removing the waiter and rejecting with
  `'input lease wait aborted'`; the driver maps that to `stopped` (`agent-driver.ts:456–462`) and
  still releases in its `finally` (`:463–466`). No waiter can win and *then* be rejected: the
  winner is `detach`ed (timer cleared, listener removed) **before** it is resolved (`:75–80`).
- **Release is genuinely idempotent** (`released` guard, `:68–71`), and the fast path cannot
  double-grant (`holder === null && queue.length === 0`, `:97–100`).
- **No nested/self-deadlock inside a batch.** `acquireInputLease` has exactly one importer
  (`agent-driver.ts`); `auto-typer.typeText` does not take the lease, so a `type` action cannot
  wait on its own batch's hold. (The *unleased* callers are M2 — the opposite problem.)
- **Post-`await` gates in the run loop are consistently ordered**: `isCurrent()` is re-checked
  after every await before any emit or side effect (`agent-orchestrator.ts:198`, `:214`, `:275`,
  `:285`, `:338`), and the per-step controller is derived from the turn signal with the
  already-aborted case handled up front (`:240–249`) and its listener removed in `finally`
  (`:272–273`) — the step timer cannot leak across attempts.
- **`interruptibleDelay`'s forward reference to `onAbort` is safe** — the `setTimeout` callback
  cannot run before the `const` is initialized, and `{ once: true }` prevents double-firing
  (`agent-driver.ts:81–94`).
- **Abort during a physical batch stops it between actions**, the lease is still released
  (`agent-driver.ts:300–305`, `:463–466`), and a mid-combo `key` action cannot leave a modifier
  held (`:391–403`).
- **Per-agent persistence is correct where it is wired**: `chatHistory.append(this.id, …)` +
  `usageStore.recordAgentMessage(this.id)` + `AgentStatus.agentId` on every emit
  (`agent-orchestrator.ts:145–149`, `:394–400`), and the chat store's migration stamps legacy
  entries with `main` (`chat-history-store.ts`).
- **The intent of `LocalTurnControl` withholding `setVoiceState` is right** — the defect is the
  caller-side lifecycle (C1), not the interface shape.
- **Renderer-side agent awareness is ahead of main's**: statuses are keyed per agent, the chat tab
  filters by `agentId`, and `OverlayApp` / `StreamApp` / `HomeTab` all *try* to attribute actions —
  they guess only because main never sends the field (C3).

---

## Triage

| Order | Item | Why first |
|---|---|---|
| 1 | **C1** | Guaranteed, bricks always-on listening for any user with 2+ agents; small lifecycle fix. |
| 2 | **C3** | Guaranteed mis-attribution today, and the `agentId` plumbing is the prerequisite for C4's fencing token — land them together. |
| 3 | **C2** | Orphaned-run race: a live run `"zapi stop"` cannot reach, still moving the cursor. |
| 4 | **C5** | Foreground answer corruption + cross-agent prompt contamination (needs a contract change). |
| 5 | **C4 + M8** | Lease liveness: holder watchdog, retry, `detach` on timeout. |
| 6 | **C6, M1, M2** | Stop-path and concurrency edges (routine double-fire, unleased typing). |
| 7 | **M3–M7, M9, M10, N1–N7** | Status/affordance and contract cleanups — cheap, user-visible polish. |

### Symbol → line map — **refreshed post-drift (authoritative)**

`companion-manager.ts` and `agent-orchestrator.ts` numbers are current as of the re-verification
pass; `input-lease.ts` / `agent-driver.ts` are unchanged from the first read.

| Symbol | File | Lines |
|---|---|---|
| `AgentTurnControl` | `agent-orchestrator.ts` | 29–50 |
| `LocalTurnControl` (no `setVoiceState`) | `agent-orchestrator.ts` | 53–73 |
| `AgentRuntime.stop` (aborts **and** nulls) | `agent-orchestrator.ts` | 142–149 |
| `AgentRuntime.emit` | `agent-orchestrator.ts` | 151–155 |
| `AgentRuntime.run` — head / `running = true` / `try` | `agent-orchestrator.ts` | 163 / 171 / 205 |
| `runAgentActions` call (hooks **without** `agentId`) | `agent-orchestrator.ts` | 340–363 |
| `onLeaseWait` handler (ignores `false`) | `agent-orchestrator.ts` | 356–361 |
| run `finally` (unconditional `running = false`) | `agent-orchestrator.ts` | 393–410 |
| `recordExchange` → shared context / summary on the global channel | `agent-orchestrator.ts` | 417 / 429–431 |
| `AgentOrchestrator.runtimeFor` / `runTask` / `stop` / `getStatus` | `agent-orchestrator.ts` | 469–475 / 478–480 / 486–494 / 496–498 |
| `acquireInputLease` / `makeRelease` / `notifyWaiters` / `detach` | `input-lease.ts` | 92–137 / 67–84 / 54–60 / 62–65 |
| lease timeout path (skips `detach`) | `input-lease.ts` | 112–117 |
| `runAgentActions` — lease + abort + echo + finally | `agent-driver.ts` | 262–305 / 434–466 |
| `buildAgentDeps` (main turn binding / `LocalTurnControl`) | `companion-manager.ts` | 244–290 (249, 267) |
| `stopAgent` (unconditional `stopSpeech`) | `companion-manager.ts` | 434–450 |
| `resetFromMicError` (the only 'idle' safety net) | `companion-manager.ts` | 468–495 |
| `handleVadUtterance` voice-state gate | `companion-manager.ts` | 852–878 (873) |
| `processVadUtterance` (`'processing'` set / guards) | `companion-manager.ts` | 906–984 (929, 939–979) |
| `startScene` (`clearSceneTimers` first) | `companion-manager.ts` | 1027–1028 |
| `startRecording` (turn bump / abort) | `companion-manager.ts` | 1136–1186 (1140) |
| `stopRecordingAndProcess` post-turn `finally` | `companion-manager.ts` | 1187–1265 (1249) |
| `processUserText` — `agentLive` / dictation `typeText` / **agent trigger** / talk `'processing'` | `companion-manager.ts` | 1304 / 1354 / **1374–1391** / 1400 |
| talk turn `currentAbort` install / clear | `companion-manager.ts` | 1433 / 1482 |
| `completeTalkTurn` — `recordExchange` / `startScene` / `typeText` / `'idle'` | `companion-manager.ts` | 1507 / 1564 / 1583 / 1608 |
| `resolveAgentTarget` | `companion-manager.ts` | 1642–1660 |
| `runRoutineTask` (busy guard / turn bump) | `companion-manager.ts` | 1711–1727 (1695, 1702) |
| `announceCompletion` (pre-`await` voice gate) | `companion-manager.ts` | 1831–1843 (1838) |
| `showTransientBanner` / `maybeAnnounceAgentDone` / `runAgentLoop` | `companion-manager.ts` | 1850–1866 / 1874–1878 / 1880–1882 |
| `setVoiceState` | `companion-manager.ts` | 2137–2139 |
| `RoutineScheduler.tick` (fires all due routines) | `routines.ts` | 65–83 |
| `lastAgentStatus` slot / tray Stop gating | `index.ts` | 58–59 / `rebuildTrayMenu` |

**Nothing was modified in `src/`.** Only `REVIEW4.md` was created by this pass.

