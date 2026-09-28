# Zapi Tag DSL

The model emits markup tags inline with its spoken reply. `src/main/services/element-detector.ts`
parses them out of the raw response, converts screenshot coordinates to display coordinates, and
`TAG_STRIP_REGEX` removes every tag before text reaches TTS, chat history, or the stream window.
Four families: **scene cues** (talk mode), **`[TYPE:]`** (type-for-user), **`[ACT:*]`** (agent
mode), and **`[FILE:]` blocks** (agent deliverables).

The same file is the single source of truth — this document describes what it implements today.

## Coordinate space

- The model sees JPEG screenshots (`screen-capture.ts`, max 1600 px on the longest edge) and emits
  **screenshot pixel** coordinates, origin top-left.
- `screenN` is a 0-based index into the screenshot array sent with the request. Captures are sorted
  so `screen0` is the display the user's cursor is on.
- The parser maps each coordinate back to **display-space logical pixels** (DIPs):

  ```
  x' = displayBounds.x + px · (displayBounds.width  / imageWidth)
  y' = displayBounds.y + py · (displayBounds.height / imageHeight)
  ```

  so points line up across DPI scaling and multi-monitor layouts. Sizes (w, h, radii) get the same
  scale factor with no origin offset.
- A tag referencing a `screenN` with no matching screenshot is dropped.
- In **agent mode**, `agent-driver.ts` additionally multiplies display-space coords by the display's
  `scaleFactor` on Windows before handing them to nut-js — libnut works in physical pixels while
  Electron reports bounds in DIPs.

### Numeric grammar

Most coordinate slots accept `N = \d+(?:\.\d+)?` (decimals are allowed — the model occasionally
emits `.5`). The slots that take **integers only** are `CIRCLE` center (cx, cy), `BOX`/`HILITE`
x, y, and `WRITE` x, y. `PATH` is looser still: its vertex list is any run of `[\d.,;\s]+`, and
each `x,y` pair goes through `parseFloat`, so decimals and stray whitespace are tolerated there.

### Escaping

Free-text slots marked "escape-aware" match `(?:[^\]\\]|\\.)*`: a backslash escapes the next
character, so a literal `]` inside text is written `\]`. Unescaping replaces `\X` with `X` for any
character X.

`POINT`'s label is **not** escape-aware — it is `[^:\]]+` and cannot contain `:` or `]`.
`[ACT:key:...]` takes `[^\]]+` verbatim (no unescaping).

Malformed tags are skipped individually — one bad cue never fails the whole parse.

## Talk mode — scene cues

Parsed by `parseScene(text, screenshots) → Scene | null` (null when zero cues). Cue order is tag
order; the main process replays them as timed beats (`SCENE` once, then `SCENE_CUE` per index —
see "Beat pacing" below).

| Tag | Slots | Produces |
|---|---|---|
| `[POINT:x,y:label:screenN]` | x,y `N`; label `[^:\]]+` (required) | `point` cue — companion cursor hops to the point with the label as its caption |
| `[ARROW:x1,y1:x2,y2:screenN:label?]` | coords `N`; label optional, escape-aware | `arrow` cue — stroke (x,y)→(x2,y2) with arrowhead |
| `[CIRCLE:cx,cy:rx,ry:screenN:label?]` | cx,cy ints; rx,ry `N`; label optional | `circle` cue — ellipse ring centered at (cx,cy) |
| `[BOX:x,y:w,h:screenN:label?]` | x,y ints; w,h `N`; label optional | `box` cue — rounded rect at top-left (x,y) |
| `[HILITE:x,y:w,h:screenN:label?]` | x,y ints; w,h `N`; label optional | `hilite` cue — translucent marker over the region |
| `[PATH:x1,y1;x2,y2;…:screenN:label?]` | `;`-separated `x,y` vertices (digits/dots/whitespace tolerated); **any** unparseable vertex kills the whole cue; needs ≥2 points | `path` cue — freehand polyline; `x`,`y` on the cue = first vertex |
| `[WRITE:x,y:screenN:text]` | x,y ints; text is the escape-aware tail slot | `write` cue — handwritten-style label anchored at (x,y) |
| `[CLEAR]` | none | `clear` cue — wipes accumulated strokes mid-scene |

Behavioral rules in `parseScene`:

- `point` cues are auto-numbered 1..k **among themselves** (`cue.step` / `cue.total`) so step UIs
  keep working even when draw cues are interleaved.
- Non-point cues get no step number.
- A `Scene` with zero cues is returned as `null`, not `{cues: []}`.

### Beat pacing (companion-manager `startScene`)

Each cue is emitted as a beat after the cumulative dwell of the cues before it:

| Cue kind | Dwell |
|---|---|
| `point` | `clamp(1800 + 80 · labelChars, 2600, 5500)` ms |
| draw cues (arrow/circle/box/hilite/path/write) | `min(1100 + 40 · textChars, 2000)` ms |
| `clear` | 300 ms |

After the last beat the finished scene holds **+4 s**, then `SCENE_CUE(null)` and `SCENE(null)`
are emitted. Starting a new turn clears pending timers and immediately emits `scene(null)`.

The scene is routed to the single overlay whose display contains the first cue's anchor point;
`SCENE(null)` clears are broadcast so stale ink never lingers. The stream window always receives
both channels for its cue rail.

### `[TYPE:text]` — type-for-user

Parsed separately by `parseTypeTags` (escape-aware body). Not drawn; instead:

- `settings.autoTypeEnabled` and the OS permission present → `auto-typer.ts` types it into the
  focused field via nut-js.
- Otherwise the text lands on the clipboard and a `TYPE_FULFILLED` toast tells the user to paste.

One tag per requested text; the model is instructed to only emit it when the user explicitly asks
for text to be entered.

## `[FILE:name.ext]…[/FILE]` — agent deliverables

The one tag family whose **body matters**, so it is a block rather than a payload:

```
here's the budget table.
[FILE:budget.csv]
month,amount
jan,42
feb,57
[/FILE]
```

Parsed by `parseFileTags(responseText) → FileWrite[]` (in order). The body is free-form text
between an opening and a closing tag, which is exactly why it isn't a payload slot: a CSV row,
a markdown doc, or a fenced code block contains brackets, quotes, and the *other* tags, and
requiring `[/FILE]` means none of it needs the `\]` escape convention every inline slot uses.

Grammar and edge cases:

- The filename slot is `[^\]\n]*` and is `.trim()`ed; an empty name is a malformed tag and is
  skipped (like a malformed draw tag — a partial set of deliverables beats none).
- `trimBlockEdges` drops exactly **one** newline at each edge of the body. The tag and its
  closing bracket sit on their own lines in any well-formed block, and trimming more would eat
  the blank lines and leading indentation markdown depends on.
- An **unclosed** block runs to end-of-text: the content between the open tag and the cut is
  still file content, and recovering it beats discarding the deliverable. The strip path uses
  the identical `(?:\[\/FILE\]|$)` fallback, so parse and display can never disagree about where
  a block ends. A stray `[/FILE]` with no opener is swallowed on its own.
- `TAG_STRIP_REGEX` strips the whole block, body included — a CSV read aloud character by
  character would be worse than no deliverable. The block branch is a shared source string
  (`FILE_BLOCK_SRC`) reused by `TAG_STRIP_REGEX` and `stripFileBlocks` so they can't drift,
  but each regex is its own `/g` instance: two callers sharing one global regex keep independent
  `lastIndex` cursors and silently truncate each other's scans.

### File content is data, never instructions

`stripFileBlocks(responseText)` removes **only** the blocks, leaving every other tag in place.
File content is a payload the user will save, not a script — without that strip, an
`[ACT:key:enter]` inside a python file the model wrote would be parsed and executed against the
user's real machine, a `[TYPE:...]` inside a note would reach the clipboard, and a `[POINT:...]`
inside a markdown doc would animate the overlay.

**The strip is not the caller's job.** `parseAgentActions`, `parseScene`, and `parseTypeTags` all
run their regexes over `stripFileBlocks(text)`, so *every* consumer is covered — including the
talk-turn path, which hands the same response to the scene and `[TYPE:]` parsers. The agent loop
also strips before calling, so the action path is guarded twice: a future caller (or a refactor
that reaches for the raw string) cannot quietly reintroduce the hole. Any parser added to this
file must do the same.

`parseFileTags` is the one exception: it reads the blocks on purpose, and the body it returns is
verbatim — never unescaped, never tag-parsed, never treated as a nested block.

### From filename to disk

`parseFileTags` yields in-memory `FileWrite`s; `artifact-store.writeArtifact(agentId, filename,
content)` is what persists one, and it owns everything security-relevant:

- `sanitizeFilename` is a **total** function - every input, including `''`, `'..'`, `'CON.txt'`, a
  4 kB name, or a name in a script it doesn't cover, yields a writable name instead of throwing.
  It keeps only the **last** path segment (so `../` and `..\` cannot survive), slices the
  extension off *before* mapping characters (so a fully non-ASCII stem becomes `untitled.csv`
  rather than a bare `csv`), maps anything outside `[A-Za-z0-9._-]` to a dash, caps the stem at 64
  chars for Windows' 255-char limit, keeps only the *last* extension (`report.2024.csv` stays
  intact), and prefixes Windows device names - checked against the **first dot-segment** of the
  finished name, because Win32 reserves `con.csv` just as it reserves `con`.
- `uniquePath` picks `name-2.csv` over an existing `name.csv` - a re-run of the same task must
  never silently overwrite a file the user already opened or edited. Past 999 collisions it falls
  back to a clock-stamped name, so it always returns a free path.
- A `path.dirname` assertion after resolution refuses any path that somehow escaped the target
  directory.
- The file lands in `userData/artifacts/<agentId>/`, where the agent segment is itself sanitized
  (`sanitizeAgentSegment`) so a hand-typed profile id can't traverse either.

### Kinds inference

`Artifact.kind` (`'sheet' | 'doc' | 'image' | 'code' | 'other'`) is derived from the extension
by `inferKind` — the model never declares it. A hallucinated `.csv` is still a sheet; an
extension that isn't in the table is `'other'` rather than a guess. So the prompt only has to
ask for a sensibly-named file, and the icon on the agent's card still reads right.

```
[FILE:notes.md]   → doc     [FILE:report.pdf]  → doc     [FILE:diagram.png] → image
[FILE:budget.tsv] → sheet   [FILE:app.tsx]     → code    [FILE:notes.qqq]   → other
```

## Agent mode — `[ACT:*]` tags

Parsed by `parseAgentActions(text, screenshots) → AgentAction[]`, executed in order by
`runAgentActions` in `agent-driver.ts`. Pointer coordinates use the same screenshot-px →
display-space mapping as scene cues (plus the win32 `scaleFactor` step described above).

| Tag | Slots | Action |
|---|---|---|
| `[ACT:click:x,y:screenN]` | x,y `N` | move + left click |
| `[ACT:dclick:x,y:screenN]` | " | move + double click |
| `[ACT:rclick:x,y:screenN]` | " | move + right click |
| `[ACT:move:x,y:screenN]` | " | hover only |
| `[ACT:drag:x1,y1:x2,y2:screenN]` | " | press at (x1,y1), drag to (x2,y2), always releases the button |
| `[ACT:type:text]` | escape-aware | types into whatever is focused |
| `[ACT:key:combo]` | raw `+`-separated | presses the combo; modifiers are re-ordered to lead (see key names below) |
| `[ACT:scroll:dir(:N)?]` | dir ∈ up/down/left/right; N int, default 3, clamped 0–100 | wheel notches |
| `[ACT:wait:ms]` | int | pause, clamped to 5000 ms |
| `[ACT:done(:summary)?]` | escape-aware | ends the run, `done` + summary message |
| `[ACT:fail(:reason)?]` | escape-aware | ends the run, `failed` + reason |

Key names understood by `agent-driver.ts` (`mapKey`): `ctrl`/`control`, `shift`, `alt`/`option`,
`win`/`meta`/`cmd`/`command`/`super`, `enter`/`return`, `esc`/`escape`, `space`/` `, `tab`,
`backspace`, `delete`/`del`, `insert`/`ins`, `up`/`down`/`left`/`right`, `home`, `end`,
`pageup`/`pgup`, `pagedown`/`pgdn`, `capslock`, `printscreen`/`prtsc`, `f1`–`f24`, single letters
`a`–`z`, digits `0`–`9` (mapped to numpad keys). Unknown names fail the action (logged, batch
continues).

Execution semantics in `runAgentActions`:

- 140 ms gap between actions; `done`/`fail` short-circuit the batch.
- A failing action is logged into `executed` and the batch continues — one stale click target
  doesn't abort the plan.
- nut-js unavailable → `{ failed: true, message: 'automation unavailable' }`, never throws.
- A batch that touches physical input takes the **global input lease** first (skipped when the
  batch is only `done`/`fail`), so two agents can never interleave clicks and typing on the one
  real cursor. See "Concurrency" below.

### The loop around it

The loop lives in `AgentRuntime.run` (`agent-orchestrator.ts`), not in `companion-manager` —
`companion-manager` only builds the deps for the `'main'` runtime. Per step it:

- re-captures every display (a capture failure is logged, not fatal; zero screens *is* fatal);
- streams one completion with a 90 s per-step timeout and **one** retry with a nudge prompt
  (provider aborts resolve silently, so the timer's own flag is what distinguishes a timeout
  from an interrupt), and the whole run dies at 10 min wall-clock;
- parses the reply with `parseAgentActions`, then appends the raw model output as an assistant
  turn plus the driver's `result:` line as a user turn — that feedback is how the model learns a
  click missed or a window didn't open;
- sleeps ~700 ms so the UI settles before the next capture; `agentMaxSteps` caps the run.

Two consecutive steps with **zero** action tags fail the run with "model isn't emitting actions".
`[ACT:done]` / `[ACT:fail]` count as actions, so only a truly tag-free reply strikes — that's the
DSL-deaf-model guard for providers that chat pleasantly while the driver executes nothing.

### Phases — `AgentStatus.phase`

`AgentPhase = 'idle' | 'thinking' | 'waiting' | 'acting' | 'done' | 'failed'`, always stamped
with an `agentId`. `thinking` → `acting` per step; `done`/`failed` carry the final summary;
`idle` is published by `stop()` so a card clears immediately instead of waiting for the loop to
unwind.

**`waiting` is not a step of the plan** — it's the input lease. While this agent is queued behind
another agent's physical actions, the driver's `onLeaseWait(true)` flips the status to `waiting`;
the moment the lease is won the batch proceeds. The overlay and stream window both rank
`waiting` above `thinking` (and `acting` above both), so a queued agent looks queued instead of
broken. A queued notice arriving after an abort is dropped — it must not resurrect a stopped card.

## Agent trigger — `extractAgentTask(transcript)`

Decides whether a transcript routes to the agent loop instead of a talk turn. Returns the task
text, or `null` when no trigger matched. An **empty string is still an agent turn** — the manager
replies "what should i do?" rather than guessing.

**The transcript must START with the summon.** There is no mid-sentence match: a stray mention
("tell Sarah to do it for me", "what is my agent doing") must never silently take the mouse. Three
anchored paths, tried in order, all case-insensitive:

1. **Name then "agent"** — `^(?:greeting)?(?:zapi|zappi|flicky|clicky)[,.! ]+agent\b[,.! ]*(.*)$`.
   Unambiguous, so the separator stays loose: "zapi agent, X", "hey zapi agent X", "agent mode: X".
2. **Bare "agent" leads** — `^(?:greeting)?agent\b([,.!;: ]*)(.*)$`. After a bare `agent` the
   separator must be punctuation, end-of-input, or whitespace continuing lowercase; a
   whitespace-only separator followed by a **capital** letter reads as a person's title
   ("agent Smith approved") and is not a trigger. So "agent, X" and "agent open settings" fire,
   "agent Smith approved" does not. (This one check lives in JS, not the regex — the `/i` flag
   case-folds `[A-Z]` inside a character class.)
3. **Name leads an imperative** — `^(?:greeting)?(?:zapi|zappi|flicky|clicky)[,.! ]+(.*)$`. Any
   bare "zapi, take X" or "hey zapi do X" is a task. It is the loosest path, which is why it is
   last.

On paths 1 and 2 a captured task starting with the word `mode` has it stripped ("agent mode: X"
→ "X") — that word belongs to the trigger phrase, not the instruction. Path 3 is already
unambiguous enough to skip the guard.

`settings.agentEnabled` gates the whole branch; an untriggered transcript is a normal talk turn.

### Which agent — `resolveAgentTarget(transcript, task)`

Routing happens after the trigger, in `companion-manager`. Profile names are matched **anywhere**
in the transcript, longest name first (so "Path" can't shadow "Pathfinder"), and a leading
`"<name>:"` left in the task by the parser is stripped — `"zapi agent scout: open notepad"`
arrives as the task `"scout: open notepad"` and must reach Scout's card as `"open notepad"`. An
unrecognized name falls back to `'main'` so the utterance still does something.

## Concurrency — one cursor, many agents

`input-lease.ts` is the rule that makes multi-agent safe: nut-js drives the ONE real cursor and
keyboard, so the lease is a FIFO mutex taken for a whole action batch (not per action —
interleaving mid-batch is exactly what it exists to prevent). Agents *reason* in parallel inside
their own `AgentRuntime`s; only physical actions serialize.

A wait rejects after 60 s (`input lease wait timed out`) so a stuck holder can't deadlock every
other agent, and aborts immediately on the caller's turn signal. Release is idempotent, because
the driver releases from a `finally` path.

## Worked examples

### Talk turn — user: "explain this diagram"

```
the throughput is bottlenecked at the queue — watch the left side. [CIRCLE:410,260:120,60:screen0:input queue] [ARROW:530,268:690,268:screen0:single worker drain] [HILITE:690,240:150,60:screen0:worker] [WRITE:700,320:screen0:1 msg / 40 ms] [PATH:410,330;530,345;690,335:screen0]
```

Parsed to five cues (circle → arrow → hilite → write → path) replayed as beats; the spoken text is
the sentence minus the tags.

### Agent turn — user: "zapi agent, open notepad and type hello"

`extractAgentTask` → `"open notepad and type hello"`. A plausible first model reply:

```
opening notepad. [ACT:key:win] [ACT:wait:600]
```

next screenshot lands, then:

```
launching it from search. [ACT:type:notepad] [ACT:wait:400] [ACT:key:enter] [ACT:wait:800]
```

then once Notepad is focused:

```
typing the greeting. [ACT:type:hello] [ACT:done:notepad is open with hello typed]
```

`done` ends the run; the summary is what gets spoken and stored in chat history.

### Deliverable turn — user: "zapi agent scout: log January and February spend in a csv"

`extractAgentTask` → `"scout: log January and February spend in a csv"` →
`resolveAgentTarget` → `{ agentId: 'scout', task: 'log January and February spend in a csv' }`.
The final reply looks like:

```
done — saved the table.
[FILE:spend.csv]
month,amount
jan,42
feb,57
[/FILE]
[ACT:done:saved spend.csv]
```

`parseFileTags` yields one `FileWrite` per block; the blocks are stripped from the text before the
`[ACT:*]` parse, so nothing inside the CSV can be read as an action, and the run's spoken/display
text is the summary line minus both families of tags. `writeArtifact('scout', 'spend.csv', …)`
lands it at `userData/artifacts/scout/spend.csv`, `inferKind` labels it a `sheet`, the artifact id
is stamped on the run's single chat entry, and the run's status ends on `done`. A rejected
filename or a full disk logs and continues — the on-screen work is not thrown away over a file.

