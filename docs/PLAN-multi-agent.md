# PLAN — Multi-agent ("Clickys" model) for ZAPI

User-approved scope: **full Clickys model** — multiple named agents, each with
its own chat, task queue, status card, and done-announcements; several agents
thinking/working concurrently.

## Hard constraint (design around it, don't hide it)

Clicky on macOS does background input (no real pointer). ZAPI's nut-js driver
moves the **actual** cursor — physical input cannot be parallelized.

Model: agents reason and stream LLM output **in parallel**, but all physical
actions (click/type/scroll/drag) go through a **global input lease** — one
agent holds it at a time, others get `waiting for input` status. This is the
honest "full model" on Windows without a new driver. (A background-input
driver — SendMessage/UIAutomation — is a separate investigation, not part of
this epic.)

## Phases — dispatch in order

### Phase A — contract + data model (lands first, solo wave)

`src/shared/types.ts` + `src/preload/index.ts` (contract changes — freeze while
this lands):

- `AgentProfile { id, name, kaomoji, color, createdAt, archived }`
- `FlickySettings.agents: AgentProfile[]` — default `[{id:'main', name:'Zapi', ...}]`;
  migration: existing settings get 'main', existing chat history becomes agent 'main'
- All agent/chat IPC gains `agentId`: `AGENT_STATUS` payload carries it,
  `CHAT_SEND`/`CHAT_HISTORY`/`AGENT_STOP` take it; add `AGENT_LIST`,
  `AGENT_CREATE`, `AGENT_RENAME`, `AGENT_ARCHIVE`
- `chat-history-store.ts`: key entries by agentId (`list(agentId)`, `append(agentId, …)`)
- `usage-store.ts`: per-agent counters (agentMessages keyed by agentId, keep totals)

### Phase B — runtime: AgentOrchestrator

- `src/main/services/input-lease.ts` — FIFO mutex; `agent-driver.ts` acquires
  per action batch; emits `AGENT_STATUS {phase:'waiting'}` while queued
- `src/main/services/agent-orchestrator.ts` — `Map<agentId, AgentRuntime>`;
  extract per-agent state out of companion-manager (turnId, AbortController,
  voiceState, agent loop) into `AgentRuntime`; companion-manager delegates
  (agent 'main' keeps mic/VAD dictation ownership — voice turns route to a
  target agent, default 'main' or last-interacted)
- Voice routing rule: `"zapi agent …"` → the agent named in the utterance if it
  matches (`"zapi agent <name>: task"`), else 'main' creates/uses the task card
- Parallel: N runtimes run; only physical actions serialize on the lease

### Phase C — UI

- Panel `HomeTab` → agents list: card per agent (name, kaomoji, status phase,
  last files pile), click → that agent's chat view; "new agent" button
- `StreamApp`: per-agent feed rows (agentId badge) or a picker
- Overlay pill: shows lease-holder `"<name> working… step k/n"`; queued agents
  read `"<name> waiting"`
- Agent creation UX: name + optional persona hint appended to system prompt

### Phase D — routines + announcements

- `src/main/services/routines.ts` — per-agent interval/daily scheduler;
  run result → that agent's chat + done announcement (TTS + overlay bubble,
  skip while user is on a call-equivalent state — keep it simple: respect a
  `routinesMuted` setting)
- "Done" announcement fires for every completion path (typed, voice, routine)

**Deferred (separate epic):** suggestions engine (needs app-activity signal
collection — do not fold into this one).

## Risk notes for the coordinator

- Phase A breaks the frozen contract — land it in a solo wave, then open B+C
  in parallel (B owns main/, C owns renderer + panel)
- companion-manager is a singleton turn pipeline — the AgentRuntime extraction
  is the epic's riskiest move; require the worker to keep 'main' behavior
  byte-identical (existing parse/dev-verify scripts must stay green)
- Keep `agentMaxSteps` per-agent (settings on the profile), default from global
