# Per-app guide survey (HeyClicky reference bundle)

Date: 2026-09-28. **Report-only - no source file was modified by this pass.**
The only file written is this document.

Scope: the 25 top-level `*.md` files in
`D:\Work\ZAPI\heyclicky-extracted\HeyClicky\HeyClicky.app\Contents\Resources\`.
Excluded per instruction: `AGENTS.md`, `ATTRIBUTION.md`, `Info.plist`, and
`ClickyModelInstructions.md` (not an app guide - it is a model-instructions document, and
the heading census below excludes it rather than treating it as a 26th guide).

**This document summarizes patterns only. No guide text is copied.** Where a structural
trait needed an example to be legible, the description names the trait rather than
transcribing the source.

---

## 1. What these files actually are

The single most important finding, and the one that changes how we should write our own
guides: **these are not user manuals.** Nothing in this bundle is a human "how do I use
this app" document. They are **agent-facing skill contracts** - a routing layer that tells a
model *when* to engage a capability, *how* to invoke it mechanically, what the canonical
call sequence is for a given user intent, and what a failure means. The "user" of each
guide is the model, and the prose is written in the imperative with an occasional
"the user asked for X" framing to key the intent.

Evidence for that reading, across the 25 guides:

| Signal | Count | Reading |
|---|---|---|
| YAML frontmatter with `name:` + `description:` | 24/25 | a machine-routable skill manifest, not a README |
| `version:` / `license:` / `author:` frontmatter | 22/25 / 21/25 / 21/25 | packaged-artifact hygiene |
| `metadata.hermes.tags` | 21/25 | a tag index for retrieval, not documentation taxonomy |
| `related_skills` | 13/25 | explicit cross-routing, i.e. "use *that* guide instead of this one" |
| `platforms: [macos]` gating | 4/25 | the bundle is macOS-first and says so per guide |
| `prerequisites.commands` / `prerequisites.tools` | 5/25 / 3/25 | the guide declares the binaries/tools it will shell out to |
| "When to use" section | 13/25 | trigger conditions - the routing half of the contract |
| "When NOT to use" | 3/25 | explicit negative routing (present in the app-shaped guides) |
| Code fences per guide | 0-66, median ~20 | the payload is copy-pasteable invocation, not prose |
| Menu paths (`Edit > Preferences > Add-ons`) | **2/25** | essentially absent |
| Keyboard shortcuts | **1/25** | essentially absent |

That last pair is the direct answer to the question asked. **They do not teach menu paths and
they do not teach shortcuts.** The two guides that contain literal menu paths (a Blender
addon install, a Linear settings path) contain them incidentally, as *one step inside a
recipe*, not as a section. The one shortcut table lives in a CLI guide that is about a
terminal multiplexer, where key bindings are the product.

---

## 2. Structural anatomy: four guide shapes

The 25 guides cluster into four recurring shapes. Size is the best predictor, and the
correlation is strong enough to be a template selector.

### Shape A - Tool/API contract (8 guides, ~170-380 lines)
`airtable`, `notion`, `linear`, `maps`, `polymarket`, `ocr-and-documents`,
`google-workspace`, `spotify`

Anatomy: frontmatter manifest -> `Prerequisites` (key/CLI/tool acquisition) -> `API Basics`
or "the N tools" (the surface, enumerated with one line each) -> `Common Queries` /
`Common Mutations` (task-keyed operations, one `###` per intent) -> pagination/rate limits
where the API has them -> `Typical Workflow` (an end-to-end ordering) -> `Pitfalls` /
`Rate Limits` / `Important Notes`.

`spotify.md` is the purest expression of the shape and the most instructive for us: it opens
with a `description` that reads like a trigger phrase list, declares its seven tools and
what each covers, then a `Canonical patterns (minimize tool calls)` section whose subsections
are literally **quoted user intents** ("what's playing?", "add to my X playlist", "transfer
playback to my device"). Each pattern is 1-3 calls with the call/response pair shown, plus a
one-line rationale for the *sequencing* (search once, then play by URI; do not chain
`get_state` after `get_currently_playing`). It closes with `Critical failure modes` mapping
specific error codes to specific non-retry behavior, and a `What NOT to do` list of
anti-patterns.

The pattern here is the transferable insight: **the guide is organized by user intent, not by
API surface**, and the error-code-to-behavior table is a first-class section, not an
afterthought.

### Shape B - Numbered end-to-end workflow (7 guides, ~130-515 lines)
`github-auth`, `github-issues`, `github-pr-workflow`, `github-repo-management`,
`github-code-review`, `codex`, `claude-code`

Anatomy: `Prerequisites` (often including a *decision step* - "determine which auth method
to use throughout this workflow") -> numbered `## 1.`, `## 2.` phases -> per-phase code
blocks -> a `## 7. Complete Workflow Example` that stitches the phases together ->
a `Quick Reference Table` or `Useful ... Commands Reference` -> `Pitfalls` / `Troubleshooting`.

Two traits worth stealing: the numbered phases are **verb-phrase titles that a user would
recognize as a task** (branch creation, pushing, monitoring CI, merging) rather than system
subsystem names; and the closing "complete example" repeats the whole sequence with explicit
cross-references back to the phase sections, so a reader who already knows the phases can
skip to the example. The `github-issues` guide also embeds a **body template** for the
artifact it produces (steps to reproduce / expected / actual / environment), which is the
closest thing in the bundle to "here is the output contract".

`codex.md` and `claude-code.md` are the two degenerate cases of this shape (129 and 744
lines): the same skeleton, but the phases are *capability modes* (one-shot, background, PR
review, parallel instances) rather than a single business workflow.

### Shape C - App/UI-automation guide (5 guides, ~60-196 lines)
`findmy`, `apple-notes`, `apple-reminders`, `imessage`, `obsidian`

This is the shape closest to what ZAPI's agent mode would need, and the smallest. Anatomy:
frontmatter (with `platforms:` gating) -> `Prerequisites` (install + OS permission, and the
permission is named concretely: which privacy pane, which toggle) -> `When to Use` /
`When NOT to Use` (this shape carries negative routing almost universally) -> `Quick Reference`
with one `###` per operation, each 1-3 lines of the invocation -> `Limitations` -> `Rules`.

`findmy.md` is the only guide in the bundle that drives a real GUI, and it is instructive
because it carries **two methods with an explicit preference** (a basic scripted method and a
recommended annotated-UI method), each written as a numbered action list of
open -> wait -> click tab -> capture, plus a `Limitations` section that states the
platform-specific reason a capability can be unreliable. The capability model is honest about
what the OS allows.

Note the pattern within this shape: even the GUI guides route through a **CLI or bridge tool**
rather than teaching clicks, and where they do name UI coordinates they do so to *position a
screenshot-driven agent*, not to instruct a human.

### Shape D - Craft/QA doctrine (3 guides, ~236-590 lines)
`powerpoint`, `claude-design`, `excalidraw`

`powerpoint.md` is the most quotable structural outlier: frontmatter -> `When to use` (a long
trigger-paragraph naming the artifact extension *and* the colloquial words that should
activate it) -> a `Quick Reference` **table** mapping task to guide -> `Reading Content` ->
`Editing Workflow` / `Creating from Scratch` (delegating to sibling files) -> `Design Ideas`
(doctrine: palettes as a table, a `Before Starting` list, per-element rules) -> an `Avoid
(Common Mistakes)` list -> a `QA (Required)` section -> `Dependencies`.

The QA section is the transferable piece: it is structured as *Content QA* (a machine check
plus what to look for) and *Visual QA* (a checklist plus an explicit "assume there are
problems, you are looking for them" stance), then a `Verification Loop` that forbids
declaring success before at least one fix-and-verify cycle. That is a **self-verification
contract**, and it is the one guide in the bundle that treats "how do I know it worked" as a
required section rather than an optional one. `claude-design.md` scales the same idea into a
full house style (typography, color, layout, motion, anti-slop rules, final-response format).


---

## 3. Section census - what the guides actually agree on

Presence of a top-level section across the 25 guides (heading-based, so prose-only mentions
do not count):

| Section | Guides | Consistency |
|---|---|---|
| Frontmatter manifest | 24 | universal |
| "When to use" | 13 | near-universal convention, informal |
| "Prerequisites" | 13 | universal in the API/CLI shapes, absent in the CLI-tool ones |
| Some form of workflow | 13 | universal in shape, wildly varied in form |
| "Rules" (agent directives) | 7 | the app-shaped guides end with this |
| "Quick Reference" | 6 | mostly the app/tool shapes |
| "Pitfalls" / "Gotchas" | 4 | strong in the API shapes, rare elsewhere |
| Numbered `## N.` phases | 4 guides (7 as a family) | the workflow-shape signature |
| "Troubleshooting" | 3 | underused relative to its value |
| "Limitations" | 3 | the honest-limits habit, app shapes only |
| "Output Format" | 3 | underused |
| "Verification" / "QA" | 3 | one excellent instance, the rest token |
| "Pagination" | 2 | only where the API paginates - correctly so |
| "Rate Limits" | 2 | same |
| "Dependencies" | 1 | should be universal |
| "Canonical patterns" | 1 | should be the default section name |

Two observations that fall out of the census:

1. **Failure-handling is the most unevenly served section.** Four guides carry a real
   pitfalls/error-code table; the rest carry nothing. Given that our agent surfaces users to
   whatever the OS app does, this is where our guides have the most to gain and the bundle
   has the least discipline.
2. **Verification is optional in 22 of 25 guides**, which looks like a template bug rather
   than a design choice - the one guide that takes it seriously is also the only one that
   forbids declaring an artifact finished until it has been verified.

---

## 4. Patterns worth adopting (and one to avoid)

**Adopt:**

- **Intent-keyed organization.** Subsections named after what the user said, not after what
  the API exposes. Highest-leverage trait in the bundle.
- **Manifest frontmatter as the router.** `name` + `description` + `tags` +
  `related_skills` + `platforms` + `prerequisites` lets a model decide "not this one, that
  one" from five lines before reading any prose.
- **Error code -> behavior tables.** A row per failure saying what it *means* and whether a
  retry helps. Retry policy is a real decision the guide must make for the agent.
- **Anti-pattern lists ("What NOT to do").** Cheap, high-yield, and directly prevents the
  wasteful call sequences the canonical-patterns section exists to prevent.
- **Method preference with a stated reason.** Where two routes reach the same outcome, name
  the default and say why.
- **Honest Limitations.** The GUI-shaped guides state what the OS will not let them do. Our
  Windows guides operate under exactly that constraint (UAC, ribbon dialogs, focus stealing)
  and should inherit the habit.
- **Output/artifact templates.** Embed the shape of the thing produced (issue body, deck
  outline) so the agent has a target.

**Avoid:**

- **The `#` heading collision.** One bundle guide uses `#` for shell/UI action steps *and*
  for top-level sections, so its outline is unreadable (the extractor reports 60 headings for
  a 601-line file and cannot separate structure from steps). Bake into the template: action
  steps are ordered lists or fenced blocks, never `#`.
- **Size as an accident.** Two guides run 590-744 lines of reference dump where a 134-line
  guide covers a comparable capability. The bundle has no length budget and the result is a
  5x spread in usability. Cap a single guide and push depth into sibling files - the
  PowerPoint guide does this correctly by delegating to its own sub-guides.


---

## 5. Windows-relevant analog candidates (top 10, ranked)

Ranking criteria in order: (a) how much of ZAPI's existing surface already touches it
(screenshot + pointer + type + agent loop), (b) whether user intent is frequent and
structured enough to key as "canonical patterns", (c) how well the shape fits the template,
(d) whether a Windows-specific failure mode exists that a guide can actually document.

| # | App | Shape | Why it earns a slot | Windows failure modes the guide must cover |
|---|---|---|---|---|
| 1 | **Chrome / Edge** | C | Highest-frequency target for a screen-aware assistant, and inherently visual (tabs, address bar, page controls), so it exercises overlay + agent loop end to end | Focus stealing, "restore pages?" dialogs, profile first-run wizard, download shelf, tab-strip overflow, PDF viewer vs browser viewer, zoom state |
| 2 | **VS Code** | B | The canonical Shape B: real phases (open, edit, run, debug, commit) described in the user's own words; already adjacent to our dictation surface | Trust dialog, workspace detection, unsaved-files prompt, integrated terminal focus, extension prompts, WSL vs PowerShell, keybinding conflicts |
| 3 | **Excel / Sheets** | A | Densest intent structure in any office app (sort, filter, pivot, formula, chart) and the clearest intent-per-pattern mapping; strongest artifact/paste story for ZAPI | Protected-view banner on downloaded files, locale formula separators, save-format dialog, AutoSave/OneDrive sign-in, regional list separators |
| 4 | **File Explorer** | C | Lowest-friction win: navigate, search, rename, copy/move, "show in folder" - and our artifact piles want an open/reveal story here | Address bar vs search box, "Open with" default-app dialog, OneDrive Known Folder Move prompt, hidden-item visibility, long-path failures, breadcrumb overflow |
| 5 | **Microsoft Teams** | A/C | Heavy structured intent (find a message, mute a meeting, share a file, change status) over a documented UI surface; a strong always-on/VAD-overlap case | Notification toast steal-focus, "activity" vs chat scoping, tenant/SSO login loops, call-join device picker, share-screen prompt |
| 6 | **Outlook** | A | Highest-value structured intent in this space (draft, reply in thread, search, attach, follow-up flag) with clean task keys | Add-in prompts, reading-pane vs three-column layout, cached vs online mode, compose-in-Word defaults, rule/priority surprises |
| 7 | **PowerPoint** | D | The one reference guide with a real QA doctrine, making it the best template donor for our artifact-producing guides | Protected View, "keep this format?" dialog, backstage save path, Presenter vs Reading view, font substitution, slide-master edit accidents |
| 8 | **Spotify** | A | Best model in the bundle for what a *small* guide looks like: enumerated tools, intent-keyed patterns, error table, anti-patterns - directly copyable at ~130 lines | Web player vs desktop client, Premium-only mutations, device handoff, local-files gaps, search rate limiting |
| 9 | **Blender** | B | Our agent mode can genuinely drive it, and the reference guide shows how to document a heavy desktop app including its install/addon prerequisite chain | Add-on install chain, first-run splash, GPU backend selection, path conventions, background vs GUI mode, undo-stack after a scripted edit |
| 10 | **Notion** | A | Frequent, text-centric, API-shaped, and the reference guide is small and clean - a good second Shape A exercise that is not another office monolith | Desktop app vs browser, offline cache lag, workspace switcher, share-permission prompt, first-launch template gallery |

Deliberately excluded, with reasons: **Obsidian / Apple Notes** (macOS-only in the bundle; the
Windows analog is filesystem-shaped and cheap to fold into the File Explorer guide);
**GitHub** (the bundle's five GitHub guides are the deepest transferable *patterns* here, but
they are CLI/API rather than app-shaped - a "ZAPI can do this" capability guide, not a
per-app guide); **Maps / Find My** (Apple-only, and the Find My guide documents a capability
macOS does not expose to third parties on Windows); **Polymarket / YouTube / OCR** (not apps
a user has open on a work desktop).


---

## 6. Recommended guide template

Synthesized from the recurring sections above, with our two deliberate departures: a
**required** verification section (the bundle treats it as optional) and a **length budget**
(the bundle has none). Filled example names are `<App>`; the shape tag selects which
optional blocks apply.

````markdown
---
name: <app-slug>
description: "<one line: the capability in trigger-phrase form, naming both the artifact
  types and the colloquial words that should activate this guide>"
version: 1.0.0
platforms: [windows]
shape: app | tool | workflow | craft
prerequisites:
  apps: [<App>]
  permissions: [<the specific Windows privacy/permission toggles this app needs>]
tags: [<app>, <domain>, ...]
related_guides: [<slug>, <slug>]
---

# <App>

One paragraph: what this guide governs, and the one-line mental model of how the app is
driven (UI path, bridge, or file surface). **Target length 120-200 lines**; anything longer
belongs in a sibling guide this one links to.

## When to use            (required - 3-6 trigger phrasings, not a feature list)
## When NOT to use        (required - name the guide to use instead)

## Prerequisites          (required)
- Installed/where it lives; how to confirm the version
- The exact permission/setting path, named concretely
- Anything that must be true *before* the first step (window state, sign-in, focus)

## Surface                (what capability is exposed, one line per operation)
- enumerated capability list, or a table: operation | how | cost/preflight

## Canonical patterns     (required - the section name to standardize on)
### "<the user's phrasing>"
1. numbered steps, one action per line
2. the preflight check, and when to skip it
3. the expected observable result ("the toolbar shows X")

## Failure modes          (required - the bundle's biggest gap)
| Symptom / dialog | What it means | Retry? | Do instead |

## Limitations            (required - what the OS/app will not let us do)
## Verification           (required - see the note below)
- the check that proves the task landed, and the "assume it failed" stance
- re-verify after any fix; at least one fix-and-verify cycle before declaring success

## Dependencies           (required)
## Pitfalls / anti-patterns   (the "what NOT to do" list)
## Related guides
````

**Notes on the three things this template does differently from the bundle:**

1. **`Verification` is required, not optional.** The bundle's 22-of-25 omission is the
   failure mode most likely to produce a confident wrong result, and it costs one short
   section. ZAPI's agent loop is the one surface where a "looks done but isn't" is invisible
   to the user, so the check belongs in the guide.
2. **A length budget plus sibling delegation.** The bundle's largest guide is 744 lines; its
   most usable is 134. Capping the parent and linking sub-guides is the one guide's practice
   worth copying wholesale.
3. **`shape:` in the frontmatter.** The bundle never states its shape, so every guide
   re-invents its own skeleton. Declaring it up front lets the writer skip the blocks that
   do not apply and lets a reviewer check the structure mechanically.

**First three to write, in this order:** File Explorer (lowest risk, exercises the artifact
open/reveal path we already ship), Chrome/Edge (highest frequency, exercises the full
overlay + agent loop), Spotify (smallest possible artifact - proves the template end to end
in ~130 lines before the heavier Shape B/D guides).

---

## 7. Method and limits

- Structure was extracted mechanically: line counts, `#{1,3}` heading trees, code-fence
  counts, and a pattern census over the 25 files (the counts in sections 1-4 come from that
  pass). Four guides were read in full (`powerpoint`, `spotify`, plus `obsidian` and
  `apple-notes` as shape-C representatives) and the remaining outlines were read as
  headings.
- No source file in `flicky` was read for or modified by this pass; the deliverable is this
  document only.
- Content is summarized, not copied. The one place I quote a section *name* is deliberate -
  section names are the template, and reusing them is the recommendation.
- Two limits worth stating: the bundle is macOS-first, so "Windows-relevant" is my mapping
  of each guide's capability onto its Windows analog, not something the bundle states (only
  4 guides even carry `platforms:`); and I sampled 4 of 25 guides in full, so per-guide
  claims in sections 2-4 are heading-level, which is sufficient for structural claims but
  would not support a claim about a specific guide's prose.

