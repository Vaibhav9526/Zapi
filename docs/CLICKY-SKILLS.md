# Clicky bundled skills — distilled index

**Source:** `HeyClicky.app/Contents/Resources/ClickyBundledSkills/` (15 skills, read in full).
**Purpose:** reference material for designing ZAPI's own equivalents. This is a *distilled
index* — our own phrasing of each workflow's load-bearing rules, not their prose. Do not copy
their text into prompts; copy the **shape**.

**Read this first — three cross-cutting lessons** that pay off more than any individual skill:

1. **Every skill is a router, not a worker.** All 15 carry an explicit *Use When / Do Not Use
   When* pair. Nearly every entry point is written as "defer to skill X for that". The skills
   are a *dispatch table* first and a procedure second. Any equivalent we build should be
   able to say "that's not me" as cheaply as it says "here's what I'll do".
2. **The recurring safety kernel is approve-before-irreversible, with reversible-as-preapproved.**
   Reversible actions (label, archive, mark-read, a write the user just asked for) run
   immediately; anything irreversible (send, delete, spend, submit, publish) needs a second
   confirmation naming the exact target. Appears in email, workspace, cua-driver, creative,
   and vercel. This is a cleaner rule than ZAPI's current all-or-nothing agent.
3. **"Never report success from a return value."** Nine of fifteen skills end in a
   *verification* section, and the recurring instruction is to **read the state back** and admit
   when verification wasn't possible. ZAPI's agent loop currently has no per-action
   verification at all — this is the single biggest gap this bundle exposes (see
   [Gap analysis](#gap-analysis-vs-our-stack)).

**Feasibility tags** (against our Windows/Electron stack, **no MCP, no Composio, no macOS**):

| Tag | Meaning |
|---|---|
| ✅ | **Adopt now** — expressible as prompt/contract changes over capabilities we already ship. |
| 🟡 | **Needs new capability** — requires a runtime piece we'd have to build (shell, Python, UIA, git, HTTP). |
| ⛔ | **Blocked** — depends on Composio/MCP connectors or macOS-only primitives. |

---

## Cross-cutting invariants (the reusable payload)

These recur across skills and are the parts worth lifting regardless of which skill we
reimplement.

| # | Invariant | Where it appears | Note for us |
|---|---|---|---|
| K1 | **Irreversible = confirm; reversible = go.** Name the exact target in the confirm. | email, workspace, creative, vercel, cua-driver | Adopt verbatim as our agent action policy. |
| K2 | **Read back after every write; a `success: true` is not evidence.** | email, workspace, doc, pdf, spreadsheet, cua-driver | Directly relevant to our `[FILE:]`/artifact path. |
| K3 | **Report a missing capability; never silently downgrade, never disguise "not shipped" as "auth failed".** | creative, dev-doctor, research, workspace, cua-driver | We ship no image/video/deck generation — we should *say so*. |
| K4 | **Cheapest, least-invasive path first; escalate only when it actually fails.** | cua-driver (AX → pixel), research (fetch → GUI), build-preview (static file → server) | Shape for our driver's escalation ladder. |
| K5 | **Chat is the deliverable by default; a file is an export you produce only when asked.** | research-report, creative, artifacts | Reverses the "always write a file" instinct. Pairs with our artifact store. |
| K6 | **The user's in-flight work is read-only context.** Never steal focus, switch tabs, or overwrite without asking. | cua-driver, artifacts, repo-operator, doc | Our real-cursor driver is the *opposite* posture — see C2 in the cua entry. |
| K7 | **If you cannot verify, say what you checked and what remains.** | everywhere, explicitly | Anti-hallucination rule; pairs with K2. |
| K8 | **End with a concrete handle** — absolute path, URL, or id. | artifacts, build-preview, vercel | Cheap, and makes the next turn addressable. |

## The shared template

Fourteen of fifteen follow one shape: `front-matter trigger` → *Use When* → *Do Not Use When* →
*Primary Path* → *Fallbacks* → *Safety* → *Artifacts* → *Verification*. `cua-driver` is the
outlier (platform manual, ~950 lines). If we ship skills, this skeleton is a good default —
it forces the two things teams skip: the *defer* clause and the *verification* clause.

---

## A. Artifact & delivery skills

### clicky-artifacts — ✅ **Adopt now** (we already have ~80% of this)
**Trigger:** Open / reveal / find / export / rename / move / organize a file Clicky already
produced; the "where did it save?" / "open it again" class of request.
**Not** for creating the content — defer to the workflow that owns the artifact.

**Invariants**
- Always finish with the absolute path, even when open/reveal failed.
- Never overwrite an existing file unless replacement was explicitly requested.
- Destructive ops (delete, overwrite, bulk move, folder cleanup) get explicit confirmation first.
- Prefer a real path over a guess; if the path is *inferred*, label it as inferred.
- Verify existence **and nonzero size** before claiming a file exists.
- Use the format-specific skill (pdf/doc/spreadsheet) as an implementation detail, not a peer.
- When several candidates match, take the newest and say how many there were.

> **We already ship this**: `services/artifact-store.ts` + `ARTIFACT_OPEN`/`ARTIFACT_REVEAL`.
> REVIEW5 found the gaps against this exact contract (no size verification, unlisted surplus
> files, an aborted turn leaving orphans). This skill is the spec we were already half-writing to.

### clicky-build-preview — 🟡 **Needs new capability** (the *defaults* are free)
**Trigger:** Build, launch, preview, iterate on a website / app / dashboard / landing page /
HTML file / frontend component; "I want a visible working thing, not only code".
**Not** for repo/PR/CI work, toolchain failure, or just locating an existing file.

**Invariants**
- **Decide the delivery format first.** If one self-contained HTML file can show it, do that —
  a `file://` open beats a dev server. Called the *default*, not the fallback.
- A foregrounded `npm run dev` dies when the shell call returns, so the URL you report is
  already dead. Start servers detached, then **poll until they actually answer**.
- **Never report a URL you have not seen respond.** If the poll fails, show the log and the
  real error instead of the URL.
- Pin `--host` + `--port` so the URL you report is the one actually bound; reuse an existing
  listener rather than spawning a duplicate.
- No unrelated refactors; no overwriting user files.
- Don't hijack the user's browser to prove a preview works — hand back the path/URL.

> **Windows note:** `nohup`/`disown`/`lsof` are POSIX. The *invariant* (detached + polled +
> never report an unverified URL) is portable; the commands are not. We have no shell execution
> today, so the shippable half is the single-file-HTML default — which pairs perfectly with our
> existing `[FILE:]` → artifact path.

### clicky-creative-studio — ✅ **Adopt now** (as routing + honesty rules)
**Trigger:** Broad creative routing — image/photo, brand/logo/moodboard, motion/video, existing
decks, design critique, UI polish, social graphics/carousels. Output should be visual and saved.
**Not** for implementing a site/app, or for opening an existing creative file.

**Invariants**
- **Route to the medium that yields a reliable artifact**; don't turn everything into an image prompt.
- **If a route is not shipped, report the missing capability** — and don't call it an auth
  problem if it's intentionally absent. Offer a document/PDF/spreadsheet/frontend alternative.
- Keep real text, charts, and precise UI in code/document layers, not in generated images.
- **Social copy is chat text at its natural published length** — never a document, no headings,
  no rationale, no alternate versions unless asked.
- Ask before posting, sending, or modifying any third-party account.
- No external brand assets or personal imagery beyond what the user supplied/approved.

> We ship no image/video/deck generation. K3 means we should state that plainly instead of
> producing a Markdown file and implying it was a poster.

---

## B. Environment & repository skills

### clicky-dev-setup-doctor — 🟡 **Partial** (we already do the health-check half)
**Trigger:** Diagnose/fix a broken dev environment — toolchains, runtimes, API keys, package
managers, localhost, MCP, auth, Supabase, Cloudflare, Codex/Claude Code, terminals.
**Not** for repo feature work, PRs, CI review, or building a preview.

**Invariants**
- **Check status before changing anything** — versions, env files, processes, ports, auth, logs.
- Explain the failure in plain language (the audience is often non-technical).
- Apply the **smallest safe fix**, or hand back the exact next command.
- **Re-run the failing command to verify.** A fix you didn't re-run isn't a fix.
- Never overwrite `.env` or secrets; never touch production unasked; no destructive package or
  DB resets without confirmation.
- If permissions/auth are missing, name the exact missing permission and the next setup action.

> We already own a narrow slice: the mic-permission probe, the missing-TTS-key warning, the
> one-shot onboarding key guidance. The transferable habit is **"re-run the failing check to
> verify"** — our permission banner doesn't re-probe.

### clicky-repo-operator — 🟡 **Needs new capability** (no git integration in ZAPI)
**Trigger:** Repo and GitHub work — clone/open, inspect codebases, explain structure, branch,
commit, push, open PRs, review diffs, respond to review comments, debug CI/Actions failures.
**Not** for building a visible app from scratch, local setup issues, or opening a generated file.

**Invariants**
- **Local checkout truth first**, then remote connectors for PRs/issues/CI.
- Classify the request before acting: orientation / code change / commit-push-PR / review
  follow-up / CI fix.
- **Never discard user changes** without explicit instruction.
- **Summarize which files are included** before any commit/push/PR.
- No force-push unless the user asked *and* understands the risk.
- Clone/open only after confirming the target repo.
- Explain Git state in plain language when the user is nontechnical.
- If tests were skipped, say why.

> Not shippable without a git runtime, but "local truth first" and the never-discard rule are
> good hygiene for any file-mutating skill we add.

### clicky-research-report — ✅ **Adopt now** (the *shape*; we lack the sources)
**Trigger:** Research a topic / market / competitor set / product / person and deliver findings
— in the chat reply by default, as a Markdown/PDF/DOCX/CSV file **only when asked**.

**Invariants**
- **The chat reply is the deliverable.** A file is produced only when asked for, or when the
  result genuinely cannot live in chat (dozens of rows to sort, something to share/print).
- Restate the target operationally first: question, scope, geography/timeframe, output format.
- Gather via search/fetch/HTTP/API **before** any GUI work; outline facts before writing prose.
- Lead with the result; use tables for comparisons; **cite sources inline**.
- **Separate verified fact from inference.** Name source files when there are no URLs.
- The file is an *export of* the findings, never a substitute for them.
- List only the final report in the artifact set; scratch/notes stay out.
- If no output format was named, deliver in chat and *offer* a file as the next step.

> Our `suggestion-engine.ts` is already a research-report in miniature: chat digest → model →
> structured cards, with the "no file unless asked" default. The missing piece is provenance —
> a card's `reason` is model-inferred with no source attached.

---

## C. Connector-backed skills (Composio/MCP — blocked, but their *policy* is gold)

### clicky-google-workspace — ⛔ **Blocked** (needs Composio) · policy ✅ adoptable
**Trigger:** Gmail read/search, drafts and approved sends, Calendar events, Drive, Docs, Sheets,
unread mail, and day-planning.

**Invariants**
- **The suite is not one connector.** The user connects each service separately; never ask for
  "Google Workspace" as a single integration.
- **Never run OAuth, browser sign-in, or raw token flows from inside the agent**, and **never
  ask the user to paste** OAuth secrets, cookies, API keys, or refresh tokens.
- Reads are fine after auth. **Writes the user asked for execute directly** — the request is the
  approval. Confirm explicitly only for **delete/archive, overwrite-not-asked, or spending money**.
- Sending email needs explicit approval of exact recipients, subject, body, and attachments.
- **Read back every write** and confirm the change landed; a create can return success and still
  be title-only.
- Exact tool-schema field names matter and are not interchangeable across versions (two named
  field-mismatch gotchas are called out explicitly).
- When replacing content shorter than what's there, clear the range or write a fresh tab.
- Paginate / narrow / filter before escalating to visible UI.
- If a specific tool is unavailable, name the missing capability — **don't silently switch to
  browser automation.**

### clicky-email-assistant — ⛔ **Blocked** (needs Composio) · policy ✅ adoptable
**Trigger:** Draft, rewrite, summarize, triage, prepare replies/outreach; Gmail/Outlook/Mail
tasks; thread summaries; sequences; sends requiring elevated permission plus approval.

**Invariants**
- **Reversible triage is pre-approved** (label, archive, mark-read) — the request is the approval.
- **Draft first. Require explicit approval only before send / reply / delete.**
- "Send it" counts as approval **only if the exact draft, recipient, and account were already
  shown in the current task context.**
- Before sending, show recipient, subject, body summary, account, and attachments.
- **Never report a draft or send as done from a `successful: true` alone** — confirm the fields,
  the send result, or a read-back; otherwise report uncertainty.
- **Don't invent thread facts.** Quote or summarize only available context.
- Outreach = staged drafts + a tracking table, never a blast.
- Resolve exact tool schemas once rather than guessing field aliases.
- If auth or send permission is missing, say what's missing and **stop retrying** — don't pretend
  it sent, and don't run OAuth yourself.

> **The most adoptable skill in the bundle for ZAPI**, because we need no connector to adopt the
> *policy*. Our agent has `agentEnabled` as an on/off switch; a confirm-before-irreversible tier
> (send / delete / purchase / submit) above the existing reversible actions is a direct port of K1.

---

## D. Platform skill

### cua-driver — ⛔ **Blocked as a driver** (macOS-only) · ✅ **highest-value lesson**
**Trigger:** Drive native macOS apps and browser UI through a local computer-use MCP server —
snapshot accessibility state, act on element tokens, stay backgrounded, verify each action.
**Not** for building an app, or as a substitute for a missing connector.

**Invariants (the transferable ones)**
- **Snapshot before AND after every single action.** The post-action read *is* the verification.
- **Read the action's own honesty fields first** (what actually ran / whether it was verified /
  effect), and re-snapshot when they don't already prove it. Confirmed-and-verified is real
  evidence; `unverifiable` and `suspected_noop` are not.
- **"If nothing changed, the action failed silently — say so, don't assume success."**
- **Never reuse a handle across a re-snapshot** — every snapshot supersedes the previous one.
- **Prefer the structured rung over raw coordinates**; pixel input is the escalation, and its
  coordinates must come from *this* turn's capture, never from a remembered frame.
- **Consent first**: observation is always allowed, input is refused until the user approves the
  turn — and if refused, **do not retry or route around it**; finish the turn with a request block.
- **Stop before irreversible actions** (purchase, send, delete, submit, account change) unless
  the user approved that exact step.
- **Never launch apps autonomously**; confirm unless the request clearly implies it.
- **If a needed capability isn't exposed, stop and say so** instead of pretending.
- **The user's own windows/tabs are read-only context** — open your own window to work in, and
  say so in the final reply.
- Split multi-window work into one goal per window; keep planning and recovery yourself.

> **Why it's the most valuable entry here:** HeyClicky solved exactly our problem — one real
> cursor, many things to automate — and solved it by *never touching the user's frontmost app*,
> driving the accessibility tree instead of pixels. **We took the opposite bet**: nut-js moves
> the user's actual cursor and keyboard, with an input lease to keep batches from interleaving.
> That choice costs us the one thing this skill treats as non-negotiable (K6), and it costs us
> the verification story too.
>
> Two concrete ports, no new infrastructure:
> 1. **Per-action verification in `agent-driver.ts`.** We return `executed[]` strings; a
>    verify-then-report step (re-read the screen, or a cheap UIA query on Windows) would let the
>    agent say "that click didn't land" instead of continuing on faith.
> 2. **A confirm tier for irreversible `[ACT:…]` tags.** `ACT:key:ctrl+s` is reversible; a
>    modelled "delete"/"send"/"pay" is not. Tag them in the DSL and require a turn of approval.
>
> Also worth stealing conceptually: the "fast lane" (a typed classifier that picks the next
> element without a model turn) is the same cost argument as our step-timeout/lease design, and
> the behavior matrix (what works when a window is minimized / hidden / off-Space) is the kind
> of table we'd want before shipping any Windows UI-automation driver on UI Automation.

---

## E. Format & authoring skills

### pdf — 🟡 **Needs new capability** (Python + Poppler)
**Trigger:** Read, create, or review PDFs where rendering and layout matter.
**Invariants**
- **Render pages to images and inspect them before delivering**; re-render after every
  meaningful change and repeat until there are zero visual defects.
- Generate with `reportlab`; extract with `pdfplumber`/`pypdf`, but **never trust text
  extraction for layout fidelity**.
- If rendering tools are missing, say so and tell the user to review locally — don't ship blind.
- Watch for clipped/overlapping text, broken tables, black squares, unreadable glyphs.
- **ASCII hyphens only** — no U+2011 or other Unicode dashes.
- Human-readable citations; never leave tool tokens or placeholder strings.
- Intermediates in `tmp/`, finals in `output/`, delete intermediates.

### doc (DOCX) — 🟡 **Needs new capability** (Python + LibreOffice)
**Trigger:** Read/create/edit `.docx` where formatting or layout fidelity matters.
**Invariants**
- **Visual review first** (DOCX → PDF → PNG), re-rendered after each meaningful change.
- If visual review is impossible, extract text and **explicitly call out the layout risk**.
- Deliver client-ready: consistent typography, spacing, margins, hierarchy; no clipped or
  overlapping text, broken tables, or default-template look.
- **ASCII hyphens only.** No placeholders or tool tokens in citations.
- Inspect every page at 100% before delivery; clean up intermediates.

> pdf + doc share an identical discipline: *render → inspect → fix → re-render, and never
> deliver an uninspected page*. That's the discipline to copy, not the Python.

### spreadsheet — 🟡 **Needs new capability** (openpyxl/pandas) · **style rules are ✅ free**
**Trigger:** Create/edit/analyze/format `.xlsx`, `.csv`, `.tsv` with formula-aware workflows.
**Invariants (formulas)**
- Formulas for derived values, never hardcoded results; simple and legible; helper cells for
  complex logic; cell references over magic numbers.
- **No dynamic-array functions** (`FILTER`, `XLOOKUP`, `SORT`, `SEQUENCE`); avoid volatile
  (`INDIRECT`, `OFFSET`); guard against `#REF!`/`#DIV/0!`/`#VALUE!`/`#N/A`/`#NAME?`.
- Recalculate before delivery so cached values exist; the library doesn't evaluate formulas.
- Preserve existing formatting when editing a styled file; never redesign unasked.
- **Text starting with `=` needs a leading apostrophe.**

**Invariants (the "sheet a person reads" rules — the most opinionated and most useful part)**
- A list/shortlist/comparison/tracker is **not a model**. One sheet, best option first and
  highlighted, 5–8 columns chosen for the *decision* rather than every field discovered.
- Every cell is a few words or a number; unknown is `"Quote"` or `"Ask"` — never a sentence
  explaining why it's unknown.
- **One link column; no source columns, no sources tab, no cell comments, no notes sheets.**
- Caveats and conflicting information go in the **chat reply**, briefly.
- A color convention when no style is given: blue = user input, black = formula, green = linked,
  gray = static, orange = caution, red = error, purple = control, teal = KPI anchor.

> The human-sheet rules and the color convention are pure prompt material and would immediately
> improve the CSVs our `[FILE:data.csv]` path produces today.

### frontend-design — ✅ **Adopt now** (pure prompt guidance, zero runtime)
**Trigger:** Build or improve frontend UI — working interface, redesign, polish, layout fixes,
responsive behavior, purposeful animation.
**Not** for static documents, Workspace tasks, or clicking through an existing app.

**Invariants (design)**
- **Match the domain**: SaaS/CRM/dashboards/ops tools are quiet, dense, scannable; games and
  marketing pages may be expressive.
- Avoid generic AI aesthetics — purple gradients, floating blobs, oversized cards, filler copy.
- No cards inside cards; keep page sections full-width, reserving cards for repeated items,
  modals, and real tools.
- Use real controls: icons for icon actions, toggles for booleans, sliders/inputs for numbers,
  tabs for view switching, menus for option sets.
- Text must fit its container on mobile and desktop; **never scale font size with viewport width**.

**Invariants (motion)**
- One strong motion idea beats many scattered animations.
- Animate `transform`/`opacity`, not layout.
- Durations: 100–150 ms immediate feedback, 200–300 ms state change, 300–500 ms layout.
- **Always preserve a non-animated path for reduced-motion users.**

**Workflow invariants**
- Reuse existing framework/component/token conventions before inventing new ones.
- Build the smallest complete working UI; **add polish only after it works**.
- Verify at least one narrow and one desktop viewport; don't turn visual inspection into
  driving a visible app.

> **Cheapest high-value port in the bundle**: every line above is prompt text. We already have
> `services/prompts.ts`; folding the design + motion rules in costs nothing and would make our
> generated HTML/UI artifacts noticeably better.

### obsidian — ✅ **Adopt now** (pure filesystem; we already do fs)
**Trigger:** Read, search, create, edit notes in the configured Obsidian vault.
**Invariants**
- **The vault is a local path, not a connector** — use the configured absolute path, and only
  that one. Don't hunt for other vaults, don't use OAuth or the Obsidian API.
- **Quote paths in shell commands** (vault paths contain spaces).
- Search filenames and content with a fast indexed searcher; read only the notes the task needs.
- **Preserve** wiki links, tags, frontmatter, embeds, and callouts when summarizing or editing.
- **Don't rename or move notes** unless the user asked for organization/renaming.
- Deletes, large rewrites, plugin/config changes, and bulk moves need an explicit plan + approval.
- Prefer focused patches when there's stable context; for anchored appends, replace the anchor
  with anchor-plus-content.
- Follow the vault's existing daily-note pattern; ask before inventing a convention.
- Report note paths (vault-relative when possible) and keep the summary short.

> Highly portable to us: it needs only a configurable directory path, which is exactly our
> `userData`/artifacts settings shape. A "notes vault" setting is a small, self-contained feature.

### vercel-deploy — ⛔ **Blocked** (needs CLI + network + shell)
**Trigger:** Deploy apps/sites to Vercel — "deploy my app", "push this live", "create a preview".

**Invariants**
- **Always deploy as preview unless the user explicitly asks for production.** This is the
  headline rule of the whole skill.
- Check for the CLI **without escalation**; escalate only the deploy command itself when
  sandboxing blocks the network call.
- Give the deploy a long timeout (10 min) because builds are slow.
- On auth failure, fall back to the bundled script; it returns a preview URL plus a claim URL.
- Report both URLs, and **don't curl the deployed URL to verify** — just hand back the link.
- Ask before escalating network permissions.

> The transferable part is the **preview-by-default** rule: any outward-facing, hard-to-undo
> action gets a safe default, and the irreversible variant requires an explicit ask. Same shape
> as K1, applied to deploys.

---

## Feasibility summary

| Skill | Tag | Blocking dependency | Cheapest useful slice for us |
|---|---|---|---|
| clicky-artifacts | ✅ | — | Already built; close the REVIEW5 gaps against it |
| clicky-creative-studio | ✅ | — | K3 honesty rules + "social copy is chat text" |
| clicky-research-report | ✅ | sources (we have none yet) | "chat is the deliverable" + cite/separate-fact shape |
| frontend-design | ✅ | — | **Design + motion rules into `prompts.ts`** |
| obsidian | ✅ | — | A configurable notes-vault path (fs only) |
| cua-driver | ⛔ / ✅ | macOS AX; our driver is the opposite bet | **Per-action verification + confirm tier for `[ACT:]`** |
| clicky-build-preview | 🟡 | shell | Single-file-HTML default via `[FILE:]` |
| clicky-dev-setup-doctor | 🟡 | shell | "Re-run the failing check to verify" |
| clicky-repo-operator | 🟡 | git runtime | "Local truth first" + never-discard hygiene |
| pdf | 🟡 | Python + Poppler | "Never deliver an uninspected page" |
| doc | 🟡 | Python + LibreOffice | Same render-inspect discipline |
| spreadsheet | 🟡 | Python; style rules free | **Human-sheet rules + color convention for our CSVs** |
| clicky-email-assistant | ⛔ | Composio | **K1 confirm-before-irreversible action policy** |
| clicky-google-workspace | ⛔ | Composio | Read-back-after-write; no-OAuth-from-agent |
| vercel-deploy | ⛔ | CLI + network + shell | Preview-by-default for outward-facing actions |

---

## Gap analysis vs. our stack

What this bundle shows we do **not** have yet, ordered by leverage:

| Gap | Evidence in the bundle | Where it would land for us |
|---|---|---|
| **No action verification.** The loop trusts that an action did what it said. | cua-driver's "if nothing changed, it failed silently — say so"; K2 | `agent-driver.ts` returns `executed[]` strings. A verify step (re-screenshot / cheap UIA read) would let the agent report failure instead of continuing. Today REVIEW4 already showed the loop re-plans on faith after a bad batch. |
| **No approval tier.** `agentEnabled` is all-or-nothing. | K1 in email + workspace + creative + vercel | Add an `irreversible` flag to the `[ACT:]` DSL: `click`/`type` stay one-click, but modelled delete/send/pay/submit require a confirm turn. |
| **No skill router.** Routing is implicit (`resolveAgentTarget` + ad-hoc branches). | *Use When / Do Not Use When* in all 15 | A small dispatch table mapping utterance → skill id, with an explicit "not me → defer to X". |
| **No "I can't do that."** We have no image/video/deck generation and no web research, and nothing says so. | K3 in creative + research + dev-doctor | An explicit capability manifest in the system prompt: here is what ZAPI *cannot* do, and here is the honest substitute. |
| **Verification habits are absent on the write path.** | K2 in artifacts + workspace | Our artifact write loop already re-checks nothing; `clicky-artifacts` wants existence + nonzero size, and a surfaced path on failure. |
| **Triggers are duplicated in the trigger word.** | The routing rule in `docs/PLAN-multi-agent.md` | Fine as-is, but the bundle's pattern (one skill owns a domain, others defer) is more robust than a keyword list. |

## What we already have that this bundle validates

- **`artifact-store.ts` + `ARTIFACT_*` IPC** is a direct implementation of `clicky-artifacts`.
  REVIEW5's findings are, in effect, the diff between our version and the skill's contract.
- **The input lease** (`input-lease.ts`) is our version of cua-driver's `delivery_mode:
  "background"` — the same underlying requirement (never interleave two actors on one real
  input device), solved by serialization instead of targeting.
- **`suggestion-engine.ts`** already does the "chat-first, no unasked file" discipline.
- **`routines.ts`** already matches the bundle's "coalesce missed runs, never backfill" instinct.

## Open questions for our equivalents

1. **Do we want per-agent skills?** The bundle has one global skill table. With per-agent
   runtimes, a Scout agent producing a spreadsheet and Zapi answering a question probably want
   different defaults.
2. **How do skills reach the renderer?** Our skills would live in `services/` and be injected by
   `prompts.ts`; the panel would need a surface to show "skill: clicky-artifacts → will write
   2 files" the way cua-driver's consent card shows Allow/Not now.
3. **Confirm tiers and the input lease interact**: a confirm turn is a turn boundary, and our
   lease is released between turns — good, but a confirm must not re-run the action it approved
   (REVIEW4 C2 is the shape of that bug).
4. **Windows-specific**: `cua-driver` is macOS-only because of AX/TCC/Spaces. Our equivalent of
   its *verification* discipline would lean on UI Automation (UIA) rather than pixels — which is
   the one architectural decision worth revisiting if UI automation ever becomes a product goal.

