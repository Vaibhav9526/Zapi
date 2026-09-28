# Feature adoption — HeyClicky → ZAPI

A parity matrix: what the HeyClicky bundle ships, what ZAPI has, and what the gap
is. Read with the two source surveys that produced the left-hand column —
[SFX-SURVEY.md](SFX-SURVEY.md) for media, [CLICKY-SKILLS.md](CLICKY-SKILLS.md) for
the skill shapes, [APP-GUIDES-SURVEY.md](APP-GUIDES-SURVEY.md) for the guide
anatomy, and [PROMPT-GAP.md](PROMPT-GAP.md) for the prompt contract.

**Left column source:** `D:\Work\ZAPI\heyclicky-extracted\HeyClicky\HeyClicky.app\Contents\Resources\`
(build `main-internal-release-build`, commit `99f33ebc`, per `ClickyBuildInfo.plist`).
**Right column source:** this repo at `ZAPI 1.2.1`.

## Status vocabulary

| Status | Meaning |
|---|---|
| **adopted** | Implemented and shipped |
| **partial** | The idea landed; the surface is narrower than theirs |
| **deferred** | Deliberately not built, with a reason |
| **n/a** | Their capability doesn't transfer (platform, or product model) |

---

## The matrix

### Agent model

| HeyClicky | ZAPI | Status | Note |
|---|---|---|---|
| Persistent named agents ("You ARE Script Buddy"), one voice per thread | `AgentProfile` (`id`/`name`/`kaomoji`/`color`), one `AgentRuntime` each | **adopted** | Profiles live in `FlickySettings.agents`, so they ride the settings channel |
| Per-agent workspace directory, every artifact kept inside it | `agent-workspace.ts`: `userData/workspaces/<slug>/` holding `AGENTS.md`, `output/`, `tmp/` | **adopted** | `workspaceDir` sanitizes the id via `sanitizeAgentSegment` |
| `AGENTS.md` as self-maintained **MEMORY** — the agent rewrites its own notes, dated and pruned | `[MEMO:…]` → `parseMemos` → `appendMemo` writes `- YYYY-MM-DD: fact` under `## Notes`; `readMemory` re-injects it | **adopted** | See the row below — this is a full round trip, not a stub |
| Multiple background agent threads alive at once | `AgentOrchestrator` caches a runtime per id; `input-lease` serializes physical input | **adopted** | Reasoning is parallel, input is serialized — same model, different primitive |
| File ownership: new artifacts never leave the owning agent's workspace | `outputDir(agentId)` is both the workspace target and the artifact store's write target; `uniquePath` never overwrites | **adopted** | |

#### MEMORY, in detail

The round trip is complete, which is why this is `adopted` rather than `partial`:

| Step | Where |
|---|---|
| The model emits `[MEMO:one durable fact]` | `AGENT_PROMPT` (`prompts.ts`) teaches the tag, caps it at 1–6 per reply, forbids secrets/tokens, and says a memo is a note to your future self that is never spoken |
| Parse, deduped, flattened, capped at 6 × 200 chars | `parseMemos` in `element-detector.ts` |
| Append `- YYYY-MM-DD: fact` under `## Notes`, oldest 40 dropped, exact duplicates rejected | `appendMemo` in `agent-workspace.ts` |
| Read back and injected ahead of every step's prompt as `Agent memory:\n…` | `readMemory`, wired in `companion-manager` — a memo written on step N is visible on step N+1 |
| The `[MEMO:]` family is added to `TAG_STRIP_REGEX` | `element-detector.ts` — a memo never reaches TTS or chat history |

Two honest limits. **Memory rides only in agent mode** — the `talk` path does not
read it, because there is no agent turn to attach it to. And `parseMemos` strips
`[FILE:]` blocks first, so a memo planted inside a file the model just wrote is
treated as data, not an instruction — the same guard the `[ACT:]` path uses.


### Skills and guides

| HeyClicky | ZAPI | Status | Note |
|---|---|---|---|
| 25 per-app `*.md` guides + ~15 bundled workflow skills | 5 app guides in [app-guides/](app-guides/README.md) | **partial** | Docs written, **no runtime injection** — nothing reads them yet |
| Every skill is a router: `Use When` / `Do Not Use When` | Frontmatter `name`/`description` in the template the survey proposes | **partial** | Template agreed, not shipped |
| Structured routing: "use `clicky-repo-operator` for GitHub" | `AGENT_PROMPT` + `[ACT:*]` DSL | **deferred** | Single DSL, no skill dispatch table |
| Approve-before-irreversible, reversible-as-preapproved | `AGENT_PROMPT` instructs no destructive actions unless asked | **partial** | Instruction-level only; no second confirmation gate at runtime |

### Capability surface

| HeyClicky | ZAPI | Status | Note |
|---|---|---|---|
| Composio MCP — hosted connector marketplace, Gmail/Drive/Notion/Linear/… | BYOK keys only (Anthropic/OpenAI/Ollama/Groq/ElevenLabs/Fish) | **n/a** | Different product model: no hosted marketplace to join |
| `cua-driver` — background, no-foreground Computer Use | `agent-driver` (nut-js) + `input-lease` | **deferred** | Windows has no background-input primitive; the lease is our substitute |
| Per-app guides route the agent to the right tool | app-guides as docs | **partial** | Same as above |
| Suggestion / proactive next-step cards | `suggestion-engine` + `suggestion-store`, permanent dismissals | **adopted** | Open-loop regex rather than a question mark |
| Scheduled routines | `RoutineScheduler`, interval + daily `HH:MM` | **adopted** | **Ahead of parity** — their shipped release states Remote Tasks / crons are *not* included |
| Agent file deliverables | `[FILE:name.ext]` → `artifact-store.writeArtifact`, `inferKind` | **adopted** | New writes land in the workspace `output/` dir; `userData/artifacts/<agentId>/` is now **legacy**, kept exported only so older rows stay locatable for reveal-in-Explorer |
| OpenAI Realtime voices (10 `realtime-voice-preview-*.mp3`) | ElevenLabs / Fish TTS, `speakReplies` | **n/a** | No Realtime provider on our side |
| 14 TTS `voice-preview-*.mp3` shipped for auditioning | Per-voice preview synthesizes on demand | **n/a** | We generate the clip instead of shipping it — same affordance, no asset weight |
| Image / video / slide generation | — | **deferred** | Their contract explicitly says these are not in the release either |

### Media

Inventory from `SFX-SURVEY.md`: **43 files — 17 `.wav`, 25 `.mp3`, 1 `.m4a`,
~10.6 MB**. ZAPI ships **4 `.wav`**, synthesized by `scripts/gen-sfx.mts`.

| Moment | HeyClicky | ZAPI | Status |
|---|---|---|---|
| Agent launch / done / needs-you | `agent-launch`, `agent-done`, `agent-needs-you` | all three, same names | **adopted** |
| Agent close | `agent-close` | — | **partial** |
| Utterance heard | — | `heard` | **adopted** (ours only; fired from `onVadAccepted`) |
| Chat send/receive/open/close | `clicky-text-*` (4) | — | **deferred** |
| Question / surprised / connection | `clicky-question`, `clicky-surprised`, `connection-question` | — | **deferred** |
| Skill up / down | `skill-up`, `skill-down` | — | **deferred** — moot until a skills runtime exists |
| Boot / reveal / hatching / tapback | `reveal-boot`, `home-reveal`, `hatching`, `tapback-thumbs-up` | — | **deferred** |
| Voice previews | 25 `.mp3` | generated on demand | **n/a** |
| Ambience | `ff.m4a` (5.7 MB, 52% of the payload) | — | **deferred** |

Wiring: `IPC.PLAY_SFX` → `sendToOverlays` → `SFX_URLS` in `OverlayApp.tsx`.

### Window and capture behavior

| HeyClicky | ZAPI | Status | Note |
|---|---|---|---|
| `ScreenshotManager` excludes the floating HUD from captures | `win.setContentProtection(true)` on every overlay | **adopted** | `windows.ts`; the comment cites their ScreenshotManager directly |
| Scene/beat routed to the owning display | Broadcast to all overlays, each renderer culls to its own bounds | **adopted** | Broadcast is a deliberate divergence — see AUDIT2 |
| Glass / vibrancy HUD | — | **n/a** | macOS aesthetic; Windows equivalents (Mica/Acrylic) unused |
| Tray-only presence, no taskbar window | Tray + panel, same posture | **adopted** | |

### Prompt contract

See [PROMPT-GAP.md](PROMPT-GAP.md) for the full diff against `prompts.ts`. Their
`ClickyModelInstructions.md` is a 106-line behavior contract; ours is the
`BASE_PROMPT` and `AGENT_PROMPT` templates in `prompts.ts` (the file is ~165 lines
including the tone table and `buildSystemPrompt`). Their P1 eager-doer, P2
verify-after-act, and the closed confirm set **landed** — `prompts.ts` now
instructs instruction-as-approval and "the next screenshot shows what happened".

| Their contract clause | Ours | Status |
|---|---|---|
| Eager doer, not a drafter; the instruction *is* the approval | ✅ landed | **adopted** |
| Verify after acting; read state back | ✅ landed | **adopted** |
| Confirm only for delete / overwrite-unsolicited / send / spend | ✅ closed confirm set | **adopted** |
| MEMO: agent maintains dated, pruned notes; never secrets; don't re-ask what notes already answer | ✅ `[MEMO:…]` taught in `AGENT_PROMPT` with all three rules | **adopted** |
| Never report success from a return value | ❌ no per-action verification in the loop | **deferred** — the biggest single gap this bundle exposes |
| Structured route first, GUI last-mile | Single `[ACT:*]` route | **partial** |

---

## Where we are ahead

Worth stating plainly, because a parity doc that only lists gaps misreads the
relationship:

- **Routines.** Their shipped contract says scheduled/background automation is not
  in the release; we ship an interval + daily scheduler that posts into an agent's
  chat and skips itself when the user is mid-turn.
- **Multi-agent from the start.** One agent id was a singleton for us until the
  orchestrator extraction; their model is per-thread from the beginning.
- **The input lease.** Their answer to "two agents, one cursor" is *don't run them
  concurrently*. Ours is an explicit FIFO mutex with a visible `waiting` phase, so
  the queue is observable rather than avoided.
- **Generated audio.** 4 files instead of 43; no 5.7 MB ambience track to ship.

## Where we are behind

Ranked by how much it costs a user:

1. **No skills runtime.** 5 app guides and a template are sitting on disk with
   nothing reading them. The injection point is `prompts.ts` + `agent-orchestrator.ts`.
2. **No per-action verification.** Their nine-of-fifteen skills end in a verification
   section; our loop re-captures a screenshot but never asserts anything about it.
3. **No skill dispatch** (`Use When` / `Do Not Use When`), so nothing yet says
   "that's not me".
4. **Thin SFX coverage** — 4 of 17 wav moments.
5. **Memory is agent-mode only.** The round trip is complete, but the talk path
   never reads `AGENTS.md`.

---

## The three source populations, and how the surveys map to them

The bundle has three distinct markdown sets, and the two existing surveys cover
two of them. Not interchangeable, and **not additive**:

| Population | Location | Count | Survey |
|---|---|---|---|
| App guides | `Resources/*.md` (flat, alongside the contract) | 25 | [APP-GUIDES-SURVEY.md](APP-GUIDES-SURVEY.md) |
| Workflow skills | `Resources/ClickyBundledSkills/<name>/SKILL.md` (one dir per skill) | 15 | [CLICKY-SKILLS.md](CLICKY-SKILLS.md) |
| The shipped contract | `Resources/ClickyModelInstructions.md` | 1 file, 106 lines | [PROMPT-GAP.md](PROMPT-GAP.md) |

`ClickyBundledSkills/` holds one directory per skill: `clicky-artifacts`,
`clicky-build-preview`, `clicky-creative-studio`, `clicky-dev-setup-doctor`,
`clicky-email-assistant`, `clicky-google-workspace`, `clicky-repo-operator`,
`clicky-research-report`, `cua-driver`, `doc`, `frontend-design`, `obsidian`,
`pdf`, `spreadsheet`, `vercel-deploy`. Most are a single `SKILL.md`; `cua-driver`
carries four extra files (`README.md`, `RECORDING.md`, `TESTS.md`, `WEB_APPS.md`)
and `vercel-deploy` adds `ATTRIBUTION.md` + `LICENSE.txt`.

The two surveys are **complements, not a total**. 25 guides + 15 skills = two
different things: the first is app-shaped UI automation reference, the second is
workflow routing. A "we have read 40 of their docs" reading is wrong.

Two names in the contract are **not** skill directories: `composio` and the
`computer-use` MCP server are runtime integrations, and `jev-use` is an optional
third-party MCP server. Neither ships in the bundle — which is consistent with the
contract stating that dedicated browser MCPs are not bundled in this release.

