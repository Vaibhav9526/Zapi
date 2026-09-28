# Documentation index

Every markdown document in the repo, and what it's for. If you're looking for
something and it isn't here, it doesn't exist.

**Read these three first:** [README](../README.md) (what ZAPI is) →
[QUICKSTART](QUICKSTART.md) (how to use it) → [AGENTS.md](../AGENTS.md) (how it's
built).

---

## Start here

| Doc | Purpose |
|---|---|
| [../README.md](../README.md) | What ZAPI is, how to install and configure it, credits |
| [../AGENTS.md](../AGENTS.md) | Architecture for contributors: layout, commands, conventions, gotchas |
| [QUICKSTART.md](QUICKSTART.md) | Plain-language first-run guide for a Windows user — no code knowledge needed |
| [DSL.md](DSL.md) | The tag DSL reference: scene cues, `[ACT:*]`, `[FILE:]` blocks, the trigger grammar, the input lease |
| [../PROBLEM.md](../PROBLEM.md) | One page on *why* the project exists |

## Reference

| Doc | Purpose |
|---|---|
| [FEATURE-ADOPTION.md](FEATURE-ADOPTION.md) | HeyClicky → ZAPI parity matrix — adopted / partial / deferred / n-a, plus where we're ahead and behind |
| [../FEATURES.md](../FEATURES.md) | heyclicky.com feature-parity audit — DONE / PARTIAL / MISSING per feature |
| [../scripts/verify-report.md](../scripts/verify-report.md) | What the verification scripts cover and how to read their output |

## App guides (agent-facing reference)

Per-app notes for driving Windows apps from screenshots. Written for a vision +
keyboard/mouse agent, not a human. **Runtime injection landed**: the agent loop
probes the foreground window each step (`active-window.ts`) and prefixes the
step prompt with `Focused app: <name>` + the matching guide excerpt.

| Doc | Purpose |
|---|---|
| [app-guides/README.md](app-guides/README.md) | Index + the three cross-app rules + how to add a guide |
| [app-guides/explorer.md](app-guides/explorer.md) | File Explorer — address bar vs search box, select/rename/properties |
| [app-guides/vscode.md](app-guides/vscode.md) | VS Code — Quick Open, project search, terminal, the trust dialog |
| [app-guides/chrome.md](app-guides/chrome.md) | Chrome / Edge — tabs, omnibox, DevTools, the overlays that steal clicks |
| [app-guides/excel.md](app-guides/excel.md) | Excel — Go To, formulas, fill, Protected View, the legacy-save dialog |
| [app-guides/settings.md](app-guides/settings.md) | Windows Settings — `ms-settings:` URI table beats sidebar clicking |

## Reference surveys (the HeyClicky bundle)

Read-only teardowns of `heyclicky-extracted\HeyClicky\HeyClicky.app\Contents\Resources\`.
These are the source material the app guides and the adoption matrix are built on.

| Doc | Purpose |
|---|---|
| [APP-GUIDES-SURVEY.md](APP-GUIDES-SURVEY.md) | The 25 per-app guides: four structural shapes, a section census, a recommended template |
| [CLICKY-SKILLS.md](CLICKY-SKILLS.md) | The 15 bundled skills, distilled — router-not-worker, approve-before-irreversible, verify-after-act |
| [PROMPT-GAP.md](PROMPT-GAP.md) | Their shipped `ClickyModelInstructions.md` vs our `prompts.ts`, with a landing-status table |
| [SFX-SURVEY.md](SFX-SURVEY.md) | The 43-file media set (17 wav / 25 mp3 / 1 m4a) mapped to lifecycle moments |

## Plans (design docs written before implementation)

| Doc | Purpose |
|---|---|
| [PLAN-multi-agent.md](PLAN-multi-agent.md) | The multi-agent "Clickys" model — why physical input can't be parallelized |
| [PLAN-streaming-stt.md](PLAN-streaming-stt.md) | Live partial transcripts (streaming STT) — research + spec, pricing to re-verify |
| [PLAN-clinepass-endpoint.md](PLAN-clinepass-endpoint.md) | Custom OpenAI base URL for ClinePass / OpenAI-compatible endpoints |
| [PLAN-api-ui.md](PLAN-api-ui.md) | Mind-tab rework: a single API section, ClinePass-first, drop the local-AI picker |
| [PLAN-glass-ui.md](PLAN-glass-ui.md) | Glass UI redesign — macOS-style translucent surfaces, traffic-light chrome, squircle icon set |

## Audits (read-only passes over the tree)

| Doc | Purpose |
|---|---|
| [../AUDIT.md](../AUDIT.md) | Cross-owner handoff — items one owner owes another, with landing status |
| [../AUDIT2.md](../AUDIT2.md) | `SCENE` / `SCENE_CUE` routing review; the source of the multi-display `[BREAKING]` finding |
| [ONBOARDING-AUDIT.md](ONBOARDING-AUDIT.md) | Onboarding & first-run flow, step by step |
| [FLOW-AUDIT.md](FLOW-AUDIT.md) | End-to-end trace of typed chat + artifacts through every layer |
| [PROMPT-REVIEW.md](PROMPT-REVIEW.md) | `prompts.ts` vs `element-detector.ts` — which tags the parser accepts but the prompt never teaches |
| [VOICE-TESTS.md](VOICE-TESTS.md) | Manual adversarial test list for the voice routing pipeline |

## Code reviews

| Doc | Purpose |
|---|---|
| [../REVIEW.md](../REVIEW.md) | The big refactor — scene DSL, agent loop, always-on VAD, dictation |
| [../REVIEW2.md](../REVIEW2.md) | Main-entry review: `index.ts` + `windows.ts` |
| [../REVIEW3.md](../REVIEW3.md) | Preload + IPC contract, typings, security surface |
| [../REVIEW4.md](../REVIEW4.md) | Agent runtimes: concurrency, input lease, voice isolation, agentId routing |
| [../REVIEW5.md](../REVIEW5.md) | New-feature services: artifacts, suggestions, routines, `[FILE:]` |

## Verification status

| Doc | Purpose |
|---|---|
| [../REPORT.md](../REPORT.md) | The current verification record — what passed, what's known-open, per-wave findings |

---

## Not indexed here

`.claude/skills/*.md` (four files) are Claude Code skill definitions — agent
workflow config, not project documentation. `landing/` is the marketing site and
has its own content. `node_modules/`, `dist/`, and `release/` are build output.

Every other markdown file in the repo is listed above — this file excepted.

---

## Conventions across this folder

- **Audits and reviews are read-only.** They state that in their header and must
  keep doing so. If a finding was fixed, mark it struck through rather than
  editing the finding itself — the audit is a snapshot, and editing it destroys
  the record of what was true when it ran.
- **Plans are pre-implementation.** Once a plan ships, its status line is the
  thing to update; the body stays as written.
- **Cite by symbol, not only line number.** Several of these trees were being
  rewritten *while* the passes ran (audits for this repo explicitly flag it), so
  line numbers drift. `ONBOARDING-AUDIT.md` and `FLOW-AUDIT.md` both carry a
  "tree state" banner saying so — follow their lead.
- **Report-only means report-only.** Several docs here were produced by passes
  explicitly scoped to not modify source. If you fix something they flagged, say
  so in the report rather than silently editing the code underneath it.
