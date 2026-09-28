# ZAPI — Quickstart

A first-run guide for a Windows user. No code knowledge needed.

Every claim below was checked against the source. Where a feature has a real
limitation, it says so.

---

## 1. Install

**Installer (easiest).** Download `ZAPI-Setup-1.2.1.exe` from this repo's GitHub
Releases page and run it. It's a normal install wizard — not one-click — so you
can pick the folder, and it adds both a desktop and a Start-menu shortcut.

The build is **unsigned**, so Windows SmartScreen will warn the first time. Choose
*More info → Run anyway*.

**From source.** Needs [Bun](https://bun.sh) (or npm) and Node 20+:

```bash
bun install
bun run dev     # starts the TypeScript watcher + Vite in parallel
bun run start   # then run this in a second terminal to launch Electron
```

---

## 2. Find the app

ZAPI has no taskbar window of its own. It lives in the **system tray** — the row
of small icons beside the clock, which you may need to expand (the little `^`) to
see.

- **Click or double-click the tray icon** to open or hide the panel. The panel
  opens by itself on launch, so if you ever lose it, the tray icon is the only way
  back.
- Launching the app a second time **brings the existing panel forward** instead of
  starting a duplicate — the installer shortcut works as a "show me the panel"
  button.

Right-click the tray icon for: Show Panel, Always-on listening, Dictation mode,
Agent mode, Stop agent, Play ink demo, Quit.

**A transparent window over your desktop?** That's normal. ZAPI puts a
click-through overlay on *every* display as a drawing canvas — it's invisible
until ink or the companion cursor appears on it.

---

## 3. Add your keys

Keys are stored only on your machine, encrypted via the OS key store when
available. The panel walks you through Mind / Ear / Voice on first launch, and you
can revisit any of them later under those tabs.

You only need **Mind** to get started. The others are optional.

### Mind — what it thinks *(required for answers)*

| Provider | Where to get the key | Notes |
|---|---|---|
| **Anthropic** | console.anthropic.com → API Keys | Default. Claude Sonnet 4.6 |
| **OpenAI** | platform.openai.com → API keys | GPT-5 default |
| **Local** | — | Ollama / LM Studio / vLLM, no key needed |

On the **OpenAI** tab there's also a **base URL** box. Fill it in for ClinePass or
any other OpenAI-compatible endpoint. Paste it however you like — a trailing
slash or a full `…/v1/chat/completions` path is normalized for you, so you won't
end up with `/v1/v1/`.

### Ear — what it hears

| Provider | Where to get the key |
|---|---|
| **Groq** (default) | console.groq.com → API Keys (`gsk_…`) |
| **OpenAI** | same OpenAI key |

Picks Whisper Large v3 Turbo by default; v3 is also available.

### Voice — what it sounds like

| Provider | Where to get the key |
|---|---|
| **Fish Audio** (default) | fish.audio dashboard |
| **ElevenLabs** | elevenlabs.io → Profile → API Keys (`xi-…`) |

Turn spoken replies off any time with the **Toggle speak replies** switch in the
Voice tab.

---

## 4. Try it without any keys

You don't have to configure anything to see the drawing system work. Right-click
the tray icon → **Play ink demo**.

It plays a canned scene through the exact same scheduler the real drawing uses, so
you see the companion cursor hop, strokes, and highlights on your real desktop —
no API calls, no keys, no cost. It also runs automatically once, right after you
finish first-run setup.

---

## 5. Hotkeys

| Hotkey | Default | What it does |
|---|---|---|
| Push to talk | `Ctrl+Alt+X` | Hold to talk (Windows). Click to toggle instead — see below. |
| Dictation | `Ctrl+Alt+D` | Press once, dictate, press again to send |
| Stop / interrupt | *(any new turn)* | A new turn bumps the counter and kills the one in flight |

Both hotkeys are rebindable — click the shortcut field in the panel and press the
new combination.

**Hold vs toggle.** On Windows the default is **hold**: keep `Ctrl+Alt+X` down
while you speak, release when done. This relies on the OS's key-repeat, so the
app can't always tell a held key from a stuck one. If that misbehaves for you,
switch the push-to-talk mode to **toggle** in the General tab: tap to start
recording, tap again to send. macOS is always toggle because there is no key-up
event to detect.

---

## 6. The three ways to talk to it

### Talk — the default

Hold `Ctrl+Alt+X`, say your question, release. ZAPI takes a screenshot, answers
**out loud**, and may sketch on your screen: the companion cursor hops to the
right button, arrows and circles and highlights appear over the real UI. For a
how-to question it will often emit an ordered list of numbered **point** cues —
follow them one at a time.

**Always-on listening** (tray checkbox, or the General tab) means you don't press
anything at all: a local voice-activity detector in the overlay segments your
speech and ships finished utterances by itself. It only listens to **one** overlay
window — deliberately, since capturing from every display produced garbled
transcripts.

### Dictation — type it where you're working

Toggle **Dictation mode** in the tray, or press `Ctrl+Alt+D`. What you say is
typed into whatever window has focus instead of being sent to the model.

By default the text goes to your **clipboard** and a toast tells you to paste.
Turn on **Auto-type** in the General tab and ZAPI will type it into the focused
field for you. No extra permission is needed on Windows.

One caveat: text that can't be reproduced reliably by keystrokes is sent via the
clipboard instead — anything **multi-line** (a stray Enter would *send* your
message rather than break the line) and anything **non-ASCII** (emoji, CJK,
accents). In those cases it still lands correctly, just through paste.

Dictation is tallied under its **own** counter, not as a conversation — so you
can see how much of a month was real conversation versus typing.

### Agent — it takes the mouse

Say (or type) a task starting with the trigger:

```
zapi agent: open notepad and type hello
```

Also fine: `zapi, open settings` · `hey agent open settings` · `agent: open notepad`

The trigger must be at the **start** of what you say. "tell Sarah to do it for me"
will not take your mouse — the phrase has to lead.

Then ZAPI loops: screenshot → decide the next action → click / type / scroll /
drag → new screenshot. You can watch the live action feed in the stream window
and hit **Stop** at any point.

Agent mode is **on by default** and capped at 15 steps per run (change it in the
General tab). Every action runs through a global queue: if another agent is
already driving the mouse, yours waits and visibly shows *waiting* rather than
fighting for the cursor.

> Not all models follow the tag grammar. If a provider chats back politely but
> nothing happens on screen, ZAPI notices after two tag-free steps and stops the
> run instead of burning the whole step budget.

---

## 7. Named agents

Panel → **Home**. Click **+ new agent**, give it a name (plus an optional face and
accent color). Each agent has its own chat history, usage counters, files, and
routines.

Route a request to a specific one by naming it:

```
zapi agent scout: check the build log
```

The name is matched anywhere in your sentence, longest name first — so "Path"
never shadows "Pathfinder". A name that doesn't match any agent falls back to the
default one, so the request still does something instead of vanishing.

The name is stripped before the model sees it: Scout receives *"check the build
log"*, not *"scout: check the build log"*.

---

## 8. Routines — scheduled runs

Panel → **Home** → the **routines** section → **+**. Each routine has a name, an
owning agent, a schedule, and the task text.

- **Every N minutes**, or
- **Daily at HH:MM**

The result posts into that agent's chat like a normal turn. A due routine is
**skipped** if you're mid-turn — a scheduled task never interrupts you. If a
routine's time of day passes while you're talking, it waits.

Each routine row has an on/off flip and a delete button. To silence the
announcements (the work still happens), say **"mute my routines"** — and
**"unmute routines"** to undo it.

---

## 9. Files ZAPI produces

When a task ends in something worth keeping — a spreadsheet, a note, a script —
the agent hands it over as a **file** rather than pasting a wall of text into
chat.

Files land in your ZAPI data folder, one sub-folder per agent (`main` for the
default one):

```
%APPDATA%\ZAPI Companion\artifacts\<agent-id>\
```

**Click** a file on the agent's card to open it; **right-click** it (or use the
small reveal button) to show it in Explorer.

Two safety notes, because the filename comes from a language model:

- Only the last path segment is kept — a name containing `../` cannot escape the
  folder.
- A re-run of the same task writes `name-2.csv` rather than overwriting a file you
  may already have open.

ZAPI's own data folder is `%APPDATA%\ZAPI Companion` (not `%APPDATA%\zapi`, which
a different installed app also uses). Your settings, keys, chats, and counters live
alongside the artifacts.

---

## 10. Suggestions — what to do next

Panel → **Home** → **suggestions**. Hit refresh and ZAPI asks each agent, based on
its recent conversation, for a few concrete follow-up tasks it could run on its
own. Each card has **Run** and a delete button.

A card you delete **stays deleted** — it will not come back on the next refresh.
Accepting a card runs its task on that card's agent immediately.

---

## 11. Talk to ZAPI about ZAPI

Short spoken commands skip the model entirely and change a setting, answering
with a short spoken confirmation:

| Say | Effect |
|---|---|
| "talk slower" / "speed up" | Voice speed |
| "be quiet" / "talk again" | Spoken replies off / on |
| "mute my routines" / "unmute routines" | Routine announcements |
| "always listen" / "stop listening" | Always-on listening |

---

## 12. The stream window

Panel → **General** → **Stream window**, three modes:

| Mode | Behavior |
|---|---|
| **off** *(default)* | Hidden |
| **while replying** | Appears when ZAPI replies or acts |
| **always** | Always visible |

It's the live Q/A rail with the scene cue list, the agent action feed, artifact
piles, and suggestion cards. Draggable, transparent, always-on-top.

---

## Troubleshooting

**The hotkey does nothing.** Dictation and agent mode each have a tray checkbox —
make sure the matching one is ticked. Separately, Windows reserves some
combinations (`Ctrl+Alt+X` collides with some IME and graphics software), so
rebind in the panel if the key never registers.

**Transcription comes out garbled or stops entirely.** The mic is captured on
exactly **one** display's overlay — deliberately, because capturing on all of them
interleaved the audio into nonsense. If you unplug or disable that monitor, or the
overlay crashes, the mic dies silently. Restart ZAPI to re-arm it. If you have a
headset, make sure Windows itself is set to use it.

**No sound.** Check the **Toggle speak replies** switch in the Voice tab. On a
muted routine, silence is expected — the run happened, only the announcement was
suppressed.

**SmartScreen warning.** The installer is unsigned. *More info → Run anyway*.

To go back over the first-run steps later, delete
`%APPDATA%\ZAPI Companion\zapi-settings.json` while ZAPI is closed and launch it
again — that clears `onboardingComplete` and the wizard runs fresh. It also
resets every other setting, so copy the file somewhere first if you want them
back.

---

## Where things live

| File | What it is |
|---|---|
| `%APPDATA%\ZAPI Companion\zapi-settings.json` | All your settings |
| `%APPDATA%\ZAPI Companion\zapi-keys.json` | Your API keys (encrypted when the OS allows) |
| `%APPDATA%\ZAPI Companion\zapi-chats.json` | Chat history, per agent |
| `%APPDATA%\ZAPI Companion\zapi-usage.json` | Monthly counters |
| `%APPDATA%\ZAPI Companion\artifacts\…` | Files agents produced |

---

Licensed MIT. Descends from
[Flicky](https://github.com/jvaught01/flicky) and inspired by
[Clicky](https://www.clicky.so/) by [Farza](https://github.com/farzaa) — see the
[README](../README.md) for full credits.
