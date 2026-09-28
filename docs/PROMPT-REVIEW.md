# Prompt-Quality Audit — `prompts.ts` vs `element-detector.ts`

**Scope:** `src/main/services/prompts.ts` (`BASE_PROMPT`, `AGENT_PROMPT`) checked against every tag
the parser in `src/main/services/element-detector.ts` actually accepts.
**Status:** audit only — **no source files were modified.** Everything below is a recommendation.
**Companion doc:** `docs/DSL.md` is the parser-side reference and is accurate on syntax; this document
is the prompt-side gap list.

---

## 0. Method

Three questions per tag family:

1. **Documented?** — does a prompt line exist that the model can pattern-match the tag from?
2. **When?** — does the phrasing tell the model *which situation* warrants the tag, not just its shape?
3. **Space-safe?** — does the coordinate instruction match what `shotToDisplay` actually do?

Coordinate truth, from source:

```ts
// element-detector.ts:69-78
scaleX = sc.displayBounds.width  / sc.imageWidth
scaleY = sc.displayBounds.height / sc.imageHeight
x' = sc.displayBounds.x + px * scaleX
y' = sc.displayBounds.y + py * scaleY
```

with `MAX_DIMENSION = 1568` (`screen-capture.ts:10`) applied to the **long edge of the image**,
and captures sorted so the cursor's display is `screen0` (`screen-capture.ts:153`).

Every behavioural claim in section 2 was **executed against the real parser**, not inferred from
reading the regex. See section 5.

---

## 1. Coverage matrix

### Talk mode — scene cues (`SCENE_TAG_REGEX`, `element-detector.ts:54-66`)

| Tag | In `BASE_PROMPT`? | Shape correct? | "When to use" stated? |
|---|---|---|---|
| `[POINT:x,y:label:screenN]` | yes — line 19 | yes | strong (guides section) |
| `[ARROW:x1,y1:x2,y2:screenN:label?]` | yes — line 20 | yes | thin |
| `[CIRCLE:x,y:rx,ry:screenN:label?]` | yes — line 21 | yes | overlaps BOX/HILITE |
| `[BOX:x,y:w,h:screenN:label?]` | yes — line 22 | yes | overlaps HILITE/CIRCLE |
| `[HILITE:x,y:w,h:screenN:label?]` | yes — line 23 | yes | overlaps BOX/CIRCLE |
| `[PATH:x1,y1;...:screenN:label?]` | yes — line 24 | yes | >=2 vertices undocumented |
| `[WRITE:x,y:screenN:text]` | yes — line 25 | yes | thin |
| `[CLEAR]` | yes — line 26 | yes | yes |
| `[TYPE:text]` | yes — lines 47-54 | yes | strong |

**All 9 talk-mode tags are documented.** The gap is not presence — it is precision (F2, F3) and
coordinates (F6).

### Agent mode — actions (`ACT_TAG_REGEX`, `element-detector.ts:208-220`)

| Tag | In `AGENT_PROMPT`? | Shape correct? | "When to use" stated? |
|---|---|---|---|
| `[ACT:click:x,y:screenN]` | yes — line 69 | yes | yes — rules line 82 |
| `[ACT:dclick:x,y:screenN]` | yes — line 70 | yes | **absent** |
| `[ACT:rclick:x,y:screenN]` | yes — line 71 | yes | **absent** |
| `[ACT:move:x,y:screenN]` | yes — line 72 | yes | **absent** (hover has a purpose) |
| `[ACT:drag:x1,y1:x2,y2:screenN]` | yes — line 73 | yes | **absent** |
| `[ACT:type:text]` | yes — line 74 | yes | yes — line 84 |
| `[ACT:key:combo]` | yes — line 75 | yes | partial |
| `[ACT:scroll:dir(:N)?]` | yes — line 76 | yes | **absent** |
| `[ACT:wait:ms]` | yes — line 77 | yes | yes — line 85 |
| `[ACT:done(:summary)?]` | yes — line 78 | bare form undocumented | yes — line 87 |
| `[ACT:fail(:reason)?]` | yes — line 79 | bare form undocumented | yes — line 87 |

**All 11 action kinds are documented.** Five of them have no usage guidance (F4).

### File writes (`FILE_TAG_REGEX`, `element-detector.ts:295`)

| Tag | In a prompt? | Parser status | Consumer |
|---|---|---|---|
| `[FILE:name.ext]` ... `[/FILE]` | **nowhere** | shipped | `agent-orchestrator.ts:303` -> `artifact-store.ts:235` |

**This is the headline gap.** The feature has *already landed* in code — it is not speculative —
## 2. Findings

### F1 — Critical: the `[FILE:...]` tag family is completely undocumented

`parseFileTags` is exported and **actively called** in the agent loop:

```ts
// agent-orchestrator.ts:302-314
const fileIds: string[] = [];
for (const file of parseFileTags(fullText)) {
  const artifact = artifactStore.writeArtifact(this.id, file.filename, file.content);
  fileIds.push(artifact.id);
  runArtifactIds.push(artifact.id);
}
```

It is also already accounted for in the run's liveness accounting — a reply that carries *only* a
file block counts as a productive step and resets the tagless-strike counter
(`agent-orchestrator.ts:320-327`). The plumbing explicitly anticipates the model emitting it.

Meanwhile `TAG_STRIP_REGEX` (`element-detector.ts:26-27`) already has a dedicated leading branch so
the body is swallowed whole and never read aloud by TTS — the code is ready for a model that emits
it, but nothing ever tells the model to.

**Consequences today:**
- A model that *does* produce a file block has it silently consumed and written to disk with no
  spoken acknowledgement, no filename in chat, and no user-visible indication it happened.
- A model asked to "write me a CSV" has no way to comply, and will instead paste the CSV inline as
  prose — which lands in TTS, chat history, and the context manager as a wall of text.
- `docs/DSL.md` does not document it either, so that doc's claim on line 7 that "this document
  describes what it implements today" is now inaccurate.

**Constraints the prompt must convey** (none are guessable by the model):

- The block form is *mandatory* — `[/FILE]`, or end-of-reply, terminates it. Content needs **no**
  backslash-escaping, which is the entire point of the block vs. the inline payload convention.
- The filename slot is `[^\]\n]*` — **no** `]` and **no** newline. Verified: a newline inside the
  opening tag makes the regex fail to match at all, so the whole block is silently lost
  (not merely truncated — see section 5).
- `sanitizeFilename` (`artifact-store.ts:72-88`) discards everything before the last `/` or `\`,
  kebab-cases, caps the stem at 64 chars, and requires the extension to be `[A-Za-z0-9]{1,10}`.
  Extension then drives the artifact *kind* via `KIND_BY_EXT` (`artifact-store.ts:90-99`) — a
  `.csv` renders as a sheet, `.md` as a doc, `.ts` as code, anything unknown as `other`.
  Emitting a real extension is therefore load-bearing, not cosmetic.
- **Agent mode only.** `parseFileTags` is called from `agent-orchestrator.ts` and nowhere else.
  `companion-manager.ts` (talk mode) imports `parseTypeTags`, `parseScene` and `TAG_STRIP_REGEX`
  but **not** `parseFileTags`. A `[FILE:]` block in a talk turn would be swallowed by
  `TAG_STRIP_REGEX` and its content silently destroyed. **Documenting it in `BASE_PROMPT` would be
  actively harmful** — this is the one place where "document the tag" and "put it in the prompt"
  are different decisions.

### F2 — High: integer-vs-decimal grammar is undocumented, and the failure is silent

`N = \d+(?:\.\d+)?` accepts decimals. But several slots are pinned to bare `\d+`:

| Slot | Regex | Source |
|---|---|---|
| `CIRCLE` centre `cx,cy` | `\d+` | `element-detector.ts:58` |
| `BOX` top-left `x,y` | `\d+` | `element-detector.ts:59` |
| `HILITE` x,y | `\d+` | `element-detector.ts:60` |
| `WRITE` x,y | `\d+` | `element-detector.ts:62` |

`BASE_PROMPT` says nothing about this. A model that emits
`[CIRCLE:614.5,300.5:46,28:screen0:exponent]` — natural, given it was just told coordinates are
continuous — hits a tag where `\d+` matches `614`, then expects `,` but finds `.`. **The match
fails and the cue is silently dropped.** Verified against `parseScene`: the decimal form returns
`null` while the integer form parses (section 5).

"Malformed tags are skipped" is a deliberate resilience property, but it converts a trivial model
formatting slip into an unexplained missing annotation with no error surfaced anywhere. By
contrast `POINT`, `ARROW`, `PATH` and all `ACT` pointer slots *do* tolerate `.5`.

**Fix:** state the rule once, in the shared coordinate preamble (S1).

and it is invisible to the model. Details in F1.

---
### F3 — High: `POINT`'s label cannot contain `:` or `]` — and the examples don't show it

```ts
// element-detector.ts:56
\[POINT:(?<px>N),(?<py>N):(?<plabel>[^:\]]+):screen(?<pscr>\d+)\]
```

`POINT` is the **only** tag whose label slot is not escape-aware. Every other free-text slot
(`WRITE`, `ACT:type`, `ACT:done`, `ACT:fail`, and the optional labels on `ARROW`/`CIRCLE`/`BOX`/
`HILITE`/`PATH`) uses `ESCAPED = (?:[^\]\\]|\\.)*`, where `\]` is the documented escape.

The prompt establishes `\]` as *the* escaping convention for `WRITE`, then repeats it for `TYPE`
and `ACT:type` — but never says the convention does **not** apply to `POINT`. Since `POINT` is the
highest-traffic tag (the entire GUIDES section is built on it), a model reusing its learned
convention emits `[POINT:412,38:click File\: New:screen0]`, which **fails to match and drops the
step the user was going to follow** — verified in section 5. This is the worst-case failure in the
audit: a well-intentioned escape silently deletes user-facing guidance.

Conversely, nothing tells the model that the optional labels on `ARROW`/`CIRCLE`/`BOX`/`HILITE`/
`PATH` *are* escape-aware, so it is both over-encouraged to escape in `POINT` and under-encouraged
to use labels on those five at all.

### F4 — Medium: five `ACT` kinds are listed without any usage guidance

`AGENT_PROMPT`'s rules block covers aiming, batching, focus-before-type, post-menu waits,
destructiveness and done/fail. Nothing tells the model when `dclick`, `rclick`, `move`, `drag`, or
`scroll` are the right tool. The failures this predicts are concrete:

- **No `move`** -> the model cannot hover to open a menu-on-hover, reveal a tooltip, or dismiss an
  overlay. `move` exists precisely for these and is otherwise dead capability.
- **No `dclick` guidance** -> file managers and "open this dialog" targets get single-clicked.
- **No `rclick` guidance** -> "right-click the tab and close it" becomes a hunt through the menu bar
  instead of one context menu.
- **No `drag` guidance** -> resizing a window or dragging a scrollbar falls back to repeated
  `click`s at coordinates that don't move.
- **No `scroll` guidance** -> `scroll` and `key:pageup`/`key:pagedown` are redundant to a model that
  doesn't know both exist, and the choice between them becomes arbitrary. `N` defaults to 3 and is
  clamped 0-100 (`agent-driver.ts:407`); the prompt documents the default but not the clamp.

### F5 — Medium: `AGENT_PROMPT` never says drawing is unavailable in agent mode

`buildSystemPrompt` swaps the whole DSL by mode (`prompts.ts:112`) — agent mode gets `AGENT_PROMPT`
and **no cue documentation at all**. A model that has seen a talk-mode turn in its own conversation
history can legitimately emit `[CIRCLE:...]` or `[POINT:...]` to indicate a target. Those tags are
stripped by `TAG_STRIP_REGEX` before display and ignored by `parseAgentActions` entirely, so the
model receives **no feedback at all** and will likely repeat the mistake on every subsequent step
until it burns the step budget (`agentMaxSteps`, default 15).

One sentence — "in agent mode you don't draw; act on the screen instead of pointing at it" — closes
this.

### F6 — Medium: coordinate instructions omit the 1568 cap and per-display origins

`BASE_PROMPT` line 16 is the entire coordinate contract:

> every drawing tag uses screenshot pixel coordinates (origin is the top-left corner, x goes right,
> y goes down) and names the screenshot it belongs to with :screenN (screen0 = the first image,
> which is the screen the cursor is on).

It is **correct** — origin, axis direction and the `screen0` sort guarantee all match source. Two
things are missing:

**(a) No dimension bound.** Nothing tells the model coordinates must fall inside the image. The
1568 cap (`screen-capture.ts:10`) exists precisely so that *model coordinate space ==
`imageWidth`/`imageHeight`* — if the model over-shoots, `shotToDisplay` maps it off-display. On
Windows `agent-driver.ts:311-312` clamps to the display union, so the click silently lands at a
corner instead of the target; in talk mode there is no clamp and the cue is drawn outside the
visible area. The per-image label from each provider does supply the exact dimensions
(`claude-api.ts:67`, `openai-api.ts:90`, `ollama-api.ts:288` — all three identical), so the model has
the information; the prompt just never points at it as a hard constraint.

**(b) No statement that each `screenN` has its own independent origin.** `shotToDisplay` adds
`displayBounds.x/y`, i.e. each display is authored against in *its own* local space. On a
multi-monitor layout where the second display sits at `x: 1920`, a model reasoning in "desktop
coordinates" will emit `x=1930` for `screen1` and land 1930 display-pixels to the right of the
target — a failure that looks like the automation "not working" and is very hard to diagnose from
a transcript. Verified in section 5: `pixel (0,0)` on `screen1` correctly maps to `x=1920`, which
is exactly the offset a desktop-space model would forget to account for.

This matters more for agent mode than talk: **agent mode uses `captureAllDisplays()`**
(`agent-orchestrator.ts:214`), so multiple `screenN` values are the normal case, while talk mode's
`captureDisplays()` defaults to `cursorOnly: true` and usually sends exactly one image.

### F7 — Medium: every provider's image label hardcodes "POINT tags", wrong in agent mode

The three providers emit a byte-identical label:

```ts
// claude-api.ts:67, openai-api.ts:90, ollama-api.ts:288
`[screen${i}] image is ${W}x${H} pixels. top-left is (0,0), bottom-right is (${W},${H}).
 use these pixel coordinates for POINT tags.${isCursorScreen ? ' (this is the active screen...)' : ''}`
```

In agent mode the model is being told to use coordinates **for a tag family that does not exist in
its prompt**. `AGENT_PROMPT` does independently state the right thing (line 68), so this is
contradictory rather than fatal — but it is the *last* thing in context before the image and
directly competes with the instruction to use `[ACT:...]`.

Note these labels carry no `mode` parameter; `buildSystemPrompt` knows the mode but the label
builders do not. This is a `prompts.ts`-adjacent fix and is listed as such (S5).

### F8 — Low: bare `[ACT:done]` / `[ACT:fail]` parse but are undocumented

```ts
// element-detector.ts:216-217
\[ACT:done(?::(?<donetext>ESCAPED))?\]
\[ACT:fail(?::(?<failtext>ESCAPED))?\]
```

Both the bare and payload forms are valid — verified: `parseAgentActions` returns
`done:undefined, done:ok, fail:undefined, fail:stuck` for the four variants, and
`agent-orchestrator.ts:259` even special-cases `/^\[ACT:done/` for exactly this.
`AGENT_PROMPT` only shows the payload forms. Not a defect — but if a model emits the bare form and
you ever want to diagnose a "said nothing" failure, the prompt gives you no way to know the form
was intentional. Harmless to leave; noted for completeness.

### F9 — Low: minor precision nits

- **`PATH` needs >=2 vertices, and one bad vertex kills the whole line.**
  `element-detector.ts:159` returns `null` below 2 points and `:156` bails on any non-finite
  vertex. Verified: `[PATH:1,2;;3,4:screen0]` is dropped entirely, not partially drawn. The
  prompt's `x1,y1;x2,y2;x3,y3;...` example implies >=3 but never states either rule.
- **Label escaping is documented only for `WRITE`.** The optional labels on `ARROW`/`CIRCLE`/`BOX`/
  `HILITE`/`PATH` and the payloads of `ACT:done`/`ACT:fail` are all escape-aware and none say so.
- **`[ACT:key:...]` is `[^]]+` verbatim — no unescaping** (`element-detector.ts:213`). The prompt
  repeats `\]` escaping for `type` but the key slot takes it literally. `DSL.md:113` also notes
  modifiers are re-ordered to lead.
- **Batch limit mismatch, benign but confusing.** `AGENT_PROMPT` says "up to 4 action tags";
  `agent-driver.ts:78` enforces `MAX_ACTIONS_PER_BATCH = 30`. The prompt is the *de* facto limit
  and the driver is the safety net — worth a comment so nobody "fixes" the prompt to 30.
- **`TONE_STYLES` appends to both prompts** (`prompts.ts:113-114`). `concise` says "respond in 1
  short sentence unless the user explicitly asks for more", which sits slightly at odds with
  `AGENT_PROMPT`'s "nothing else — no markdown, no explanations". Low impact, but `concise` is the
  default-ish tone and the two constraints are stated by two different prompts.
- **Talk mode cannot use `[FILE:]`.** Called out in F1 as a *do-not-document-in-`BASE_PROMPT`*
  trap; repeated here so it isn't lost.

---

## 3. Suggested prompt edits

> **Not applied.** Copy-paste blocks for `prompts.ts`; line numbers refer to the current file.
> All edits keep the existing all-lowercase register of the prompts.

### S1 — `BASE_PROMPT`: replace the coordinate preamble (line 16)

Fixes **F2**, **F3**, **F6(a)**.

```
every drawing tag uses screenshot pixel coordinates measured against the image it names —
origin is that image's top-left corner (0,0), x goes right, y goes down, and the bottom-right
corner is the image's own width and height. never emit a coordinate outside those bounds, and
never use desktop coordinates: each screenshot has its OWN (0,0), so screen0 and screen1 are two
separate coordinate spaces that both start at the top-left. name the image with :screenN
(screen0 = the first image, which is the screen the cursor is on).

coordinate rules:
- POINT x,y, ARROW coordinates, PATH vertices and all radii/sizes may be decimals
- CIRCLE centre, and the x,y of BOX, HILITE and WRITE, must be whole numbers
- use a whole number unless you have a real reason not to — a tag that doesn't parse is dropped
  silently, so the drawing just doesn't appear
```

### S2 — `BASE_PROMPT`: fix the escaping rules

Fixes **F3**, **F9**. Replaces the `PATH` bullet (line 24) and the tail of the `WRITE` bullet
(line 25).

```
- [PATH:x1,y1;x2,y2;x3,y3;...:screenN:label?] — a freehand polyline through the vertices, for
  underlines and arrows of your own shape. at least 2 vertices; if any vertex is malformed the
  whole line is dropped
- [WRITE:x,y:screenN:text] — handwritten-style text anchored at (x,y). everything after the screen
  slot is the text

text escaping: inside any text slot except POINT's label, a backslash escapes the next character,
so a literal ] is written \]. POINT's label is the exception — it can contain neither : nor ], and
is dropped outright if you do.
```

### S3 — `AGENT_PROMPT`: replace the actions block (lines 68-79)

Fixes **F4**, **F5**, **F6(a,b)**, **F9**. Replace lines 68-79 wholesale, leaving the `rules:`
block that follows.

```
actions (coordinates are screenshot pixels measured against the image you name: origin is that
image's top-left corner, bottom-right is that image's width and height, and every screenshot has
its own (0,0) — never use desktop coordinates. screenN picks which image, screen0 = first image):

clicking and pointing
- [ACT:click:x,y:screenN] — move to (x,y) and left click. the default for anything you'd click
- [ACT:dclick:x,y:screenN] — move and double click. use for files and folders in a file manager,
  and for dialog "open" buttons that need two clicks
- [ACT:rclick:x,y:screenN] — move and right click. prefer this over hunting the menu bar whenever
  the task names a context-menu action ("right-click the tab and close it")
- [ACT:move:x,y:screenN] — hover without clicking. use to open a menu-on-hover, reveal a tooltip,
  or dismiss an overlay before you click through it
- [ACT:drag:x1,y1:x2,y2:screenN] — drag from (x1,y1) to (x2,y2), always releasing. use to move or
  resize a window, drag a slider, or drag a scrollbar thumb

keyboard
- [ACT:type:text] — type the text into whatever is focused (escape a literal ] as \])
- [ACT:key:combo] — press a key or combo, e.g. [ACT:key:enter] [ACT:key:ctrl+s] [ACT:key:ctrl+shift+t]
- [ACT:scroll:up:N] [ACT:scroll:down:N] [ACT:scroll:left:N] [ACT:scroll:right:N] — N wheel notches;
  N is optional (defaults to 3, max 100). use for lists, feeds and long pages; pageup/pagedown are
  fine too but pick one
- [ACT:wait:ms] — pause up to 5000 ms while the ui settles

finishing
- [ACT:done:summary] — the task is complete; say what you did
- [ACT:fail:reason] — you're blocked; say why

you do not draw in agent mode — there are no arrows, circles or highlights here. every reply acts
on the screen directly, so never emit a drawing tag or a POINT tag.
```

### S4 — `AGENT_PROMPT`: add the `[FILE:...]` block

Fixes **F1**. Append after the actions block, before `rules:`. **Agent mode only** — do not put
this in `BASE_PROMPT` (F1: talk mode has no `parseFileTags` caller and would silently discard the
content).

```
FILES:
when the task's deliverable is a file — a csv, a markdown doc, a script, a config — emit it as a
block instead of pasting it into your spoken line:

[FILE:budget.csv]
month,amount
jan,42
feb,51
[/FILE]

- the [/FILE] closing tag is required; everything between the two tags is the file, written verbatim
- content needs NO escaping — commas, quotes, brackets and even other tags all go in as-is
- the opening tag carries a plain filename on ONE line, no path separators and no ] in it —
  use report.md, budget.csv, deploy.sh. the extension decides how the file is shown to the user,
  so use a real one (.csv .md .txt .json .ts .py)
- one block per file; emit several blocks if the task needs several files
- you can emit a file in the same reply as the action that produced it, or on its own step
- say one short line about what you wrote, then the block. never read the contents aloud
```

### S5 — provider image label (all three providers, one string)

Fixes **F7**. The label builders need `mode` threaded through; the wording becomes:

```ts
const use = options.mode === 'agent' ? 'ACT tags' : 'POINT and drawing tags';
text: `[screen${i}] image is ${sc.imageWidth}x${sc.imageHeight} pixels. top-left is (0,0), bottom-right is (${sc.imageWidth},${sc.imageHeight}) — stay inside those bounds. use these pixel coordinates for your ${use}.${sc.isCursorScreen ? ' (this is the active screen — user cursor is here)' : ''}`
```

This is the only suggested change outside `prompts.ts`. It's called out separately because the
alternatives — threading `mode` into three providers, or hardcoding a neutral phrase like
"for your action tags" — are a real design call, and I'd rather flag it than bury it.

### S6 — `docs/DSL.md`: add a `## File writes` section

Not a prompt edit, but required for that doc's own accuracy claim (line 7). Minimum content:
`FILE_TAG_REGEX` shape, the terminates-on-`[/FILE]`-or-end-of-reply fallback, `trimBlockEdges`
newline policy, `sanitizeFilename` constraints, `inferKind`'s extension table, and the fact that it
is **agent-mode only** (`agent-orchestrator.ts:303`) with no talk-mode caller.

---

## 4. Priority

| # | Finding | Severity | Fix | Files |
|---|---|---|---|---|
| F1 | `[FILE:...]` undocumented, already live in agent mode | Critical | S4, S6 | `prompts.ts`, `DSL.md` |
| F2 | int-vs-decimal slots undocumented, silent drop | High | S1 | `prompts.ts` |
| F3 | `POINT` label can't contain `:`/`]`; escape rule inverted | High | S2 | `prompts.ts` |
| F4 | 5 `ACT` kinds lack usage guidance | Medium | S3 | `prompts.ts` |
| F5 | agent mode never says drawing is unavailable | Medium | S3 | `prompts.ts` |
| F6 | no 1568 bound; per-display origins unstated | Medium | S1, S3 | `prompts.ts` |
| F7 | provider label hardcodes "POINT tags" | Medium | S5 | 3 api files |
| F8 | bare `[ACT:done]`/`[ACT:fail]` undocumented | Low | note only | — |
| F9 | nits (PATH vertices, key verbatim, batch limit, tone clash) | Low | S2, S3 | `prompts.ts` |

**Good news:** every tag family the parser accepts in talk mode and in agent mode is *present* in
the prompts, and the shapes are accurate against the current regexes. The `screen0`-is-the-cursor-
screen claim in `BASE_PROMPT:16` matches the sort in `screen-capture.ts:153`, and the coordinate
preamble matches `shotToDisplay` exactly. There is no drift between the documented coordinate space
and the implemented one — the deficiencies are in *precision*, plus the one shipped-but-unmentioned
feature, not in the contract itself.

**Suggested sequencing:** S1-S3 are pure prompt text and touch nothing else — do them together.
S4 is the highest-value single edit but should land with S6 so the docs don't contradict the
prompt. S5 is independent and can be its own PR.

---

## 5. Verification

Claims were **executed against the real parser**, not inferred by reading regexes. A throwaway
script imported `parseScene` / `parseAgentActions` / `parseFileTags` / `parseTypeTags` /
`TAG_STRIP_REGEX` directly from `src/main/services/element-detector.ts` under `tsx`, with a
single-capture fixture (1600x900 image, 1920x1080 display at origin) and a two-display fixture
where the second display sits at `x: 1920`. Actual output:

```
=== F2: decimals on an int-only slot ===
parsed   [CIRCLE:614,300:46,28:screen0:ok]
DROPPED  [CIRCLE:614.5,300.5:46,28:screen0:decimals]
DROPPED  [WRITE:10.5,20:screen0:x]
DROPPED  [BOX:10.5,20:5,5:screen0]

=== F3: POINT label is the only non-escape-aware slot ===
escaped-colon POINT  -> null
plain POINT           -> {"kind":"point","x":494.4,"y":45.6,"text":"click File","screenIndex":0,"step":1,"total":1}
escaped-bracket WRITE-> {"kind":"write","x":12,"y":24,"text":"a ] b","screenIndex":0}

=== F6: per-display anchors via shotToDisplay ===
[ 'point screen0 -> x=0 y=0', 'point screen1 -> x=1920 y=0' ]

=== F8: bare vs payload done/fail ===
[ 'done:undefined', 'done:ok', 'fail:undefined', 'fail:stuck' ]

=== F9: PATH vertex rules ===
ok 2pts  [PATH:1,2;3,4:screen0]
DROPPED  [PATH:1,2:screen0]
DROPPED  [PATH:1,2;;3,4:screen0]

=== F1: FILE blocks against the real parseFileTags ===
"[FILE:budget.csv]..."        -> [{"filename":"budget.csv","content":"month,amount\njan,42"}]
"[FILE:notes.md]..."          -> [{"filename":"notes.md","content":"see [CIRCLE:1,2:screen0] and a ] bracket"}]
"[FILE:truncated.csv]..."     -> [{"filename":"truncated.csv","content":"row,1"}]
"[FILE:bud\nget.csv]..."      -> []
"[FILE:]..."                  -> []
"[FILE:../../etc/passwd.csv]" -> [{"filename":"../../etc/passwd.csv","content":"x"}]

=== F1: strip regex keeps file bodies out of TTS ===
"here you go."
"done.  trailing"

=== F1: TYPE still works, and FILE never leaks prose ===
[ 'hello ] world' ]
```

Notes this output produced that changed the report:

- **F1 corrected.** The `[^]\n]` filename slot does not *truncate* the filename — a newline makes
  the whole `[FILE:...]` fail to match, so the block is lost entirely. The report now says so.
- **F1 extended.** `parseFileTags` returns `../../etc/passwd.csv` verbatim; stripping the path is
  `sanitizeFilename`'s job in `artifact-store.ts`, which runs on the value *after* parsing. Worth
  knowing the parser is not the security boundary — the store is.
- **F6 confirmed concretely.** `pixel (0,0)` on `screen1` maps to `x=1920`. That offset is exactly
  what a model reasoning in desktop coordinates gets wrong.
- **F2/F3/F8/F9 all behaved as documented.**

### Reproducing

The verification script was temporary and has been deleted; `git status` shows `docs/` as the only
addition. To re-run, write a `.mts` that imports from `src/main/services/element-detector.ts` and
execute `npx tsx <file>`. The repo already has similar harnesses under `scripts/`
(`parse-smoke.mts`, `scene-pipeline.mts`, `artifact-smoke.mts`) — `artifact-smoke.mts` is the
natural home for an F1 regression test once S4 lands.

### Audit integrity

- Files read: `src/main/services/prompts.ts` (116 lines), `src/main/services/element-detector.ts`
  (382 lines), plus `screen-capture.ts`, `agent-driver.ts`, `agent-orchestrator.ts`,
  `artifact-store.ts`, `claude-api.ts`, `openai-api.ts`, `ollama-api.ts`, `shared/types.ts`,
  `docs/DSL.md`.
- Call-site claims (`parseFileTags` agent-only, `captureAllDisplays` agent-only) were verified by
  recursive search across `src/**/*.ts{,x}`, not by reading a single file.
- **No source file was modified.** `docs/PROMPT-REVIEW.md` is the only file added; the temporary
  verification scripts were removed.

