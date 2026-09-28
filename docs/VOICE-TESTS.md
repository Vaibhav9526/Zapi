# Voice Routing Test List

Manual, human-in-the-loop adversarial tests for the **voice routing pipeline** — the path a spoken
utterance takes before it becomes a model call, a dictation, or nothing at all.

**Status:** test list only. **No source files were modified.**
**How to use:** say the phrase out loud (or fire a PTT turn), then confirm the outcome against the
**Expected** column. A failure here is a *routing* bug, not a model bug — every phrase below is
matched by regex before any model is involved.

---

## 0. The pipeline, in evaluation order

`companion-manager.ts:processUserText` runs these branches **in this order**. Order matters more
than anything else on this page: an earlier branch swallows the text and later ones never see it.

| # | Branch | Gate | File:line |
|---|---|---|---|
| 0 | **VAD wake gate** | always-on only; needs a wake token | `companion-manager.ts:889` |
| 1 | **Agent voice stop** | `agentEnabled` + voice state `acting` + `STOP_COMMAND` | `:1309` |
| 2 | Drop-if-agent-live | `acting` + not a stop command | `:1318` |
| 3 | Dictation toggles | `^(hey zapi,? )?(start\|begin) dictat` / `^stop dictat` | `:1326` |
| 4 | **Voice self-settings** | `fromVoice` + **fewer than 8 words** | `:1342` |
| 5 | Dictation | `forcedDictation \|\| dictationEnabled` | `:1351` |
| 6 | **Agent trigger** | `fromVoice` + `agentEnabled` + `extractAgentTask` | `:1376` |
| 7 | Talk turn (model call) | fallthrough | `:1393` |

Two consequences to internalise before you start:

- **Self-settings beat dictation and beat the agent.** Branch 4 precedes 5 and 6, so
  `mute routines` still changes a setting while dictation is on.
- **Dictation beats the agent.** Branch 5 precedes 6, so with dictation on *every* utterance is
  dictated and the agent trigger is unreachable (test **D1**).

---

## 1. Setup

| Prereq | Value | Why |
|---|---|---|
| Voice speed | anything in 0.7–1.2 | clamped at `companion-manager.ts:2063` |
| Agent mode | **on** (default) | branch 6 is gated on `agentEnabled` |
| Always-on | **off** for groups A–I, **on** for group J | different gate entirely |
| Dictation | **off** for groups A–C, E–I, **on** for D | different gate |
| Profiles | create `Scout`, plus `Path` and `Pathfinder` | group F, longest-name-first |

Listen for the spoken confirmation (`slower.`, `routines muted.`, …) — that is the proof the
settings branch fired rather than the model answering you.

---

## 2. Group A — Self-settings: voice speed (correct triggers)

Every accepted spelling of each speed rule. All apply instantly and answer out loud.

| # | Say | Expected | Result |
|---|---|---|---|
| A1 | "talk slower" | `voiceSpeed` −0.15, clamped ≥0.7 | ☐ |
| A2 | "speak slower" | same | ☐ |
| A3 | "talking slower" | same (`(?:ing)?`) | ☐ |
| A4 | "speak more slowly" | same | ☐ |
| A5 | "slow down" | same (separate literal) | ☐ |
| A6 | "talk faster" | `voiceSpeed` +0.15, clamped ≤1.2 | ☐ |
| A7 | "speak quicker" | same (`quicker`) | ☐ |
| A8 | "speak more quickly" | same | ☐ |
| A9 | "speed up" | same (separate literal) | ☐ |
| A10 | "zapi talk slower" | same — wake lead stripped | ☐ |
| A11 | "hey zapi talk slower" | same | ☐ |
| A12 | "okay zapi talk slower" | same (`okay ` allowed) | ☐ |

**Clamp check:** press A1 eight times in a row from 1.0. It must stop at 0.7 and keep confirming
`slower.` without going lower — an unbounded decrement is a clamp failure.
---

## 3. Group B — Self-settings: spoken replies & routines (correct triggers)

| # | Say | Expected | Result |
|---|---|---|---|
| B1 | "stop talking" | `speakReplies` off | ☐ |
| B2 | "quit announcing" | same (`announcing` accepted) | ☐ |
| B3 | "stop speaking" | same | ☐ |
| B4 | "be quiet" | same (`shush` / `shh` siblings) | ☐ |
| B5 | "shush" | same | ☐ |
| B6 | "start talking" | `speakReplies` on | ☐ |
| B7 | "keep speaking" | same (`keep`) | ☐ |
| B8 | "talk again" | same (`unmute` / `speak up` siblings) | ☐ |
| B9 | "unmute" | same | ☐ |
| B10 | "mute routines" | `routinesMuted` true | ☐ |
| B11 | "mute my routines" | same (` my`) | ☐ |
| B12 | "silence the routines" | same (` the`) | ☐ |
| B13 | "unmute routines" | `routinesMuted` false | ☐ |
| B14 | "unmute my routines" | same | ☐ |

**B1–B5:** with `speakReplies` off the confirmation still reaches the stream window but not the
speaker — the silence is the proof. Verify the *setting* changed rather than waiting for a voice.

---

## 4. Group C — Self-settings: always-on listening (correct triggers)

| # | Say | Expected | Result |
|---|---|---|---|
| C1 | "always listen" | `alwaysOnEnabled` true | ☐ |
| C2 | "listen always" | same | ☐ |
| C3 | "always on" | same | ☐ |
| C4 | "keep listening" | same | ☐ |
| C5 | "start always listening" | same | ☐ |
| C6 | "stop listening" | `alwaysOnEnabled` false | ☐ |
| C7 | "stop always listening" | same | ☐ |
| C8 | "don't listen" | same (`don'?t`) | ☐ |
| C9 | "listening off" | same | ☐ |
| C10 | "always-on" | same (hyphenated literal) | ☐ |

**C10 is the sharpest one here.** The rule lists a hyphenated variant beside the spaced ones, which
is a transcription-unfriendly shape — it works only if the ASR happens to emit the hyphen. Worth
checking against your actual engine.

---

## 5. Group D — Dictation vs talk disambiguation

Set **dictation ON** for D1–D3, **OFF** for D4.

| # | Dictation | Say | Expected | Result |
|---|---|---|---|---|
| D1 | on | "zapi agent open notepad" | **dictated verbatim**, no agent run | ☐ |
| D2 | on | "the meeting starts at three" | dictated | ☐ |
| D3 | on | "talk slower" | **setting changes**, not dictated | ☐ |
| D4 | off | "the meeting starts at three" | normal talk turn | ☐ |
| D5 | either | "start dictation" | `dictationEnabled` on, says "dictation on." | ☐ |
| D6 | either | "stop dictating" | `dictationEnabled` off, says "dictation off." | ☐ |
| D7 | either | "hey zapi start dictation" | same (this rule alone allows a wake lead) | ☐ |

**D1 is the important one.** Branch 5 sits above branch 6, so a phrase that *would* trigger the
agent is instead typed into whatever has focus. With dictation on, "zapi agent, open notepad"
yields the literal string `zapi agent open notepad` typed into your editor — not an automation.
This is by construction, not a bug, but it is the most surprising behaviour in the pipeline and
should be confirmed deliberately.

**D1 vs D3** is the ordering table in miniature: self-settings survive dictation, agent triggers do
not.

---

## 6. Group E — Agent trigger: correct routing

Agent mode ON, dictation OFF, always-on OFF.

| # | Say | Expected task / behaviour | Result |
|---|---|---|---|
| E1 | "zapi agent open notepad" | task `open notepad` | ☐ |
| E2 | "hey zapi agent, open notepad and type hello" | task `open notepad and type hello` | ☐ |
| E3 | "zapi agent mode: open calculator" | task `open calculator` (`mode` stripped) | ☐ |
| E4 | "agent open settings" | task `open settings` (bare `agent`, lowercase) | ☐ |
| E5 | "agent, open the browser" | task `open the browser` (punctuation separator) | ☐ |
| E6 | "zapi open notepad" | task `open notepad` — **name alone triggers** | ☐ |
| E7 | "hey zapi open the settings app" | task `open the settings app` | ☐ |
| E8 | "zapi, take a screenshot" | task `take a screenshot` | ☐ |
| E9 | "hey agent open notepad" | task `open notepad` (`hey` greeting) | ☐ |
| E10 | "yo zapi open notepad" | task `open notepad` (`yo` greeting) | ☐ |
| E11 | "flicky open notepad" | task `open notepad` | ☐ |
| E12 | "clicky open notepad" | task `open notepad` | ☐ |

**E6 is a large surface.** `AGENT_NAME_LEADS` (`element-detector.ts:414`) fires on the name plus
*any* trailing text — so every "zapi …" PTT utterance is an agent command, not a question.
"zapi what does this button do" will try to **click** the button. Confirm that is intended; see G3.

**E3:** in `agent mode: X` the word `mode` belongs to the trigger, not the instruction
(`element-detector.ts:417`).

**E11/E12 do not match the wake gate** — `flicky` / `clicky` are valid *agent trigger* names but are
**not** wake tokens (test J2e).

---

## 7. Group F — Multi-word and overlapping agent names

Create profiles `Scout`, `Path`, `Pathfinder`, `Ms Rivera`. `resolveAgentTarget`
(`companion-manager.ts:1642`) matches names **anywhere** in the transcript, **longest first**.

| # | Say | Expected profile | Result |
|---|---|---|---|
| F1 | "zapi agent pathfinder: open notepad" | **Pathfinder**, not `Path` | ☐ |
| F2 | "zapi agent path: open notepad" | **Path** | ☐ |
| F3 | "zapi agent scout: open notepad" | **Scout**, task `open notepad` | ☐ |
| F4 | "hey zapi agent ms rivera, open the shared drive" | **Ms Rivera**, task `open the shared drive` | ☐ |
| F5 | "zapi agent ms rivera open the shared drive" | **Ms Rivera**, task still contains `ms rivera` | ☐ |
| F6 | "zapi agent nobody: open notepad" | **main** — unknown name falls back | ☐ |
| F7 | "zapi agent scout open notepad" | **Scout**, task still contains `scout` | ☐ |

**F1 is the one that matters.** If it routes to `Path`, longest-name-first sorting is broken.

**F5/F7 vs F3/F4:** the `name:` lead is stripped from the task; a bare `name task` routes to the
right profile but leaves the name in the text the model receives. Not a routing bug — but if you
want a clean instruction for the model, prefer the colon form.

**F6:** an unrecognized name must fall back to `main` rather than silently dropping the request.

---

## 8. Group G — Agent trigger: false-positive bait

Each must fall through to a **normal talk turn**. Any of these taking the mouse is high-severity —
the user gets an automation they never asked for.

| # | Say | Expected | Result |
|---|---|---|---|
| G1 | "tell me about agent smith the insurance guy" | **TALK** | ☐ |
| G2 | "what is my agent doing right now" | **TALK** — `agent` not leading | ☐ |
| G3 | "zapi what does this button do" | **AGENT-RUN** — confirm intended (see E6) | ☐ |
| G4 | "my agent said the build is broken" | **TALK** | ☐ |
| G5 | "flicky is an old name for this app" | **TALK** — `flicky` *is* a trigger name | ☐ |
| G6 | "user agent strings are so annoying" | **TALK** | ☐ |
| G7 | "call the agent and ask about the policy" | **TALK** | ☐ |
| G8 | "tell sarah to do it for me" | **TALK** — mid-sentence mention | ☐ |
| G9 | "agent smith approved the expense report" | **AGENT-RUN** — ⚠ finding **B2** | ☐ |

**G1 vs G9 is the sharpest contrast on this page, and G9 currently fails.** Both are about a person
named Smith. `AGENT_WORD_LEADS` is meant to suppress the person's-title reading
(`element-detector.ts:438`), but the guard is `!/[,.!;:]/.test(sep) && /^[A-Z]/.test(word)`:

| Input | separator | next word capitalised? | Result |
|---|---|---|---|
| `agent Smith approved…` | `" "` | yes | suppressed → TALK ✅ |
| `Agent Smith approved…` | `" "` | yes | suppressed → TALK ✅ |
| `agent smith approved…` | `" "` | **no** | **triggers** ❌ |
| `agent, Smith approved…` | `", "` | yes | **triggers** ❌ |

Two holes. First, transcripts are lowercased by most ASR engines, so the capitalisation test — the
only thing doing the work — sees `smith` and waves it through. Second, the guard is skipped entirely
whenever the separator contains punctuation, so `agent, Smith` triggers even with perfect
capitalisation. **ASR output is lowercase far more often than not, so treat G9 as the real-world
case.** If it takes the mouse on your machine, that is a true false positive.

---

## 9. Group H — Self-settings: false-positive bait

Each must become a **talk turn**, not a setting. All contain a real trigger phrase.

| # | Say | Expected | Result |
|---|---|---|---|
| H1 | "can you talk slower when you read long articles" | **TALK** — 9 words, gate shut | ☐ |
| H2 | "why did you stop talking to me earlier" | **TALK** | ☐ |
| H3 | "tell me about routines you run in the morning" | **TALK** | ☐ |
| H4 | "what are my routines and when do they fire" | **TALK** | ☐ |
| H5 | "mute the music playing right now" | **TALK** — `routines?` is anchored | ☐ |
| H6 | "i always listen to podcasts in the car" | **TALK** | ☐ |
| H7 | "always on time management is hard" | **TALK** | ☐ |
| H8 | "be quiet everyone is trying to work" | **TALK** | ☐ |
| H9 | "talk slower please" | **TALK** — trailing word breaks the `$` anchor | ☐ |
| H10 | "stop listening to that theory and check the build" | **TALK** | ☐ |

**The <8-word gate is what saves H1, H3, H4 and H10** — they contain genuine trigger phrases but
exceed the word budget. Confirm the gate itself: say **"zapi agent pathfinder: open the notepad and
then summarise what you find for me"** (11 words, contains `zapi agent`). It must *not* be captured
by a settings rule — but note it **will** trigger the agent (E6), which is the other thing to check.

**H9 is a genuine usability trap.** "talk slower please" is the most natural way a person would say
it, and it costs a full model round-trip that changes nothing. The rules are anchored `$`, so any
politeness or filler after the phrase kills it. Low severity, but it reads as "the feature is
broken."

---

## 10. Group I — Agent trigger with no task

Should ask rather than guess: the user hears **"what should i do?"** and no automation runs.

| # | Say | Expected | Result |
|---|---|---|---|
| I1 | "zapi agent" | "what should i do?" | ☐ |
| I2 | "agent" | same | ☐ |
| I3 | "hey zapi agent" | same | ☐ |
| I4 | "zapi" | **TALK**, not the ask | ☐ |
| I5 | "hey zapi" | **TALK** | ☐ |

**I4/I5 are the asymmetry.** A bare wake name yields an *empty* task under `AGENT_NAME_THEN_AGENT`,
so it hits the ask branch. But bare `zapi` alone only matches `AGENT_NAME_LEADS` if something
follows — with nothing after it, group 1 falls through and the turn is treated as talk. `zapi` and
`zapi agent` therefore behave differently despite sounding identical. Not harmful, just confusing.

---

## 11. Group J — Always-on wake gate

Turn **always-on ON**. These apply only in this mode.

### J1 — Addressed utterances (should route)

| # | Say | Expected | Result |
|---|---|---|---|
| J1a | "zapi talk slower" | self-setting fires (wake stripped → `talk slower`) | ☐ |
| J1b | "zapi agent open notepad" | agent runs, task `open notepad` | ☐ |
| J1c | "ok zapi what is this button" | **TALK** — see ⚠ **B1** | ☐ |

### J2 — Background chatter (must be silently dropped)

Nothing should happen: no reply, no screenshot, no agent.

| # | Say | Expected | Result |
|---|---|---|---|
| J2a | "can you pass the salt" | dropped — no wake token | ☐ |
| J2b | "i think this meeting is about pricing" | dropped | ☐ |
| J2c | "turn off the kitchen light" | dropped | ☐ |
| J2d | "she said the deadline is friday" | dropped | ☐ |
| J2e | "flicky open notepad" | **dropped** — ⚠ **B3** | ☐ |

### J3 — Wake-token forms

| # | Say | Expected | Result |
|---|---|---|---|
| J3a | "hey zapi what is this" | addressed | ☐ |
| J3b | "okay zapi what is this" | addressed (`okay`) | ☐ |
| J3c | "what is this error zapi" | addressed — token anywhere in the phrase | ☐ |
| J3d | "zappy what is this" | addressed (`zappy` is a wake token) | ☐ |
| J3e | "zapi" alone | dropped — wake token only, nothing left | ☐ |
| J3f | "hi zapi open notepad" | **dropped** — ⚠ **B4** | ☐ |

### J4 — Hands-free stop, mid-run

Start an agent run (say "zapi agent open notepad"), then while it drives:

| # | Say | Expected | Result |
|---|---|---|---|
| J4a | "stop" | **stops the loop**, says "stopped." | ☐ |
| J4b | "zapi stop" | same | ☐ |
| J4c | "hey zapi stop" | same | ☐ |
| J4d | "enough" / "never mind" | same (`STOP_COMMAND`) | ☐ |
| J4e | "zappy stop" | **does NOT stop** — ⚠ **B5** | ☐ |
| J4f | "cancel" / "abort" | same | ☐ |
| J4g | any other speech mid-run | dropped, no competing turn | ☐ |

---

## 12. Findings from building this list

These fell out of reading the routing order and were confirmed by exercising the regexes directly.
They are **not** instructions to change anything — they are the behaviours a tester should expect,
so a "failure" can be triaged as bug-or-intent.

| # | Severity | Finding |
|---|---|---|
| **B1** | Medium | **Always-on strips the wake token before `extractAgentTask` runs.** `"zapi open notepad"` is an `AGENT-RUN` under PTT (E6) but becomes `"open notepad"` — a plain **talk turn** — under always-on. Only `"zapi agent …"` survives, because the bare `agent` still leads after stripping. Name-only triggers are effectively PTT-only. |
| **B2** | **High** | **Lowercase transcripts defeat the "agent Smith" title guard.** See G1 vs G9. ASR output is usually lowercase, so the capitalisation test does not hold — and the punctuation-separator branch skips the guard entirely. This is the one genuine false-positive route in the list. |
| **B3** | Low | **`flicky` / `clicky` are agent trigger names but not wake tokens.** `"flicky open notepad"` triggers under PTT (E11) and is silently dropped under always-on (J2e). `zappy` is the reverse — a valid wake token that is *not* an agent trigger name. |
| **B4** | Low | **The wake gate does not accept `hi`.** `normalizeVadUtterance` allows `hey\|ok\|okay`, while `GREETING` in `extractAgentTask` also allows `hi` and `yo`. `"hi zapi open notepad"` is dropped in always-on. |
| **B5** | Low | **`STOP_COMMAND` does not accept `zappy` / `flicky` / `clicky`** — only `zapi` / `zappi`. `"zappy stop"` will not stop a run even though `"zappy what is this"` does wake it (J3d). |
| **B6** | Info | **Self-settings beat dictation; dictation beats the agent.** Branch order 4 → 5 → 6. `mute routines` works while dictating (D3), but `zapi agent …` is dictated verbatim while dictation is on (D1). |

---

## 13. Suggested run order

Fastest to slowest, stopping early on failure:

1. **Groups A + B + C** (always-on off, dictation off) — pure self-settings, no side effects on
   the mouse. ~30 phrases; validates the whole settings surface and the wake-lead stripping.
2. **Group I** — agent trigger with no task. Cheap, runs no automation, confirms the ask branch.
3. **Group H** — self-setting bait. Confirms the <8-word gate before you risk anything.
4. **Group E** — agent correct routing. The mouse starts moving here; keep a real task in view.
5. **Group G** — agent bait, **G1 first, then G9**. If G9 takes the mouse, stop and file B2.
6. **Group F** — multi-word names. Create the profiles first.
7. **Group D** — dictation. Toggle deliberately; D1 is the surprising one.
8. **Group J** — always-on. Last: it needs a live mic, and J4 needs a running agent.

---

## 14. Verification

Routing outcomes in the **Expected** column were not guessed. A throwaway script replicated
`extractAgentTask` (`element-detector.ts:425`), `normalizeVadUtterance`
(`companion-manager.ts:889`), `STOP_COMMAND` (`:903`), the self-setting body normaliser (`:2051`),
all twelve self-setting regexes (`:2064-2103`), the branch order of `processUserText`
(`:1280-1400`), and `resolveAgentTarget` (`:1642`) against a stub profile list — then ran every
phrase on this page through it.

Spot-checks that shaped the findings: `agent smith approved…` triggers while `agent Smith approved…`
does not (B2); `"zapi open notepad"` routes differently under PTT versus always-on (B1);
`pathfinder:` beats `path` (F1); an 11-word phrase containing `zapi agent` passes the self-settings
gate but still reaches the agent (H).

**No source file was modified.** `docs/VOICE-TESTS.md` is the only file added; the verification
scripts were temporary and have been deleted.

To re-run: rebuild the harness from `companion-manager.ts:1280-1400` and
`element-detector.ts:388-446`, then `npx tsx` it. The repo's existing `scripts/agent-dryrun.mts`
and `scripts/parse-smoke.mts` are the natural homes for these as regression tests.

