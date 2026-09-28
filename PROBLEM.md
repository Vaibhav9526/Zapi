# ZAPI — Problem Statement & What We're Solving

One-page statement of *why this project exists*. For *what it does*, see
[FEATURES.md](FEATURES.md); for *how it's built*, see [AGENTS.md](AGENTS.md).

---

## The problem

**Software got smart, but the desktop got dumber.** Every AI assistant today lives
inside a text box. You are standing in front of a screen full of context — a
dashboard, an error dialog, a form, a spreadsheet, a PDF — and the assistant can
see none of it and touch none of it.

That creates four compounding frictions.

### 1. The description tax

Because the model can't see your screen, *you* have to compress a visual scene
into words: *"the panel on the right, third dropdown, the one under the grey
header, it says something about tokens."* Slow, lossy, and often impossible. The
workaround — screenshot, paste, "what's wrong here?" — is clunky enough that most
people just don't bother.

### 2. The translation tax

Even when the model *knows* the answer, *you* still have to perform it. "Click
Settings → Integrations → Add" means you read four words and then hunt for four
things with your mouse. The AI's output is text; your work is motor control.
Nothing connects the two.

### 3. The context-switch tax

Help isn't in the place you need it. The tutorial is in another tab, the docs in
another window, the answer in a chat app. Every question costs a trip out of your
workspace and back.

### 4. The AI can't act

Even a perfectly-informed answer still ends with you doing the clicking.
Assistants are advisers, never doers.

---

## What we're solving

**Make the desktop itself the interface.** ZAPI treats the screen as input,
speech as output, the overlay as an output *surface*, and the mouse + keyboard as
an action channel. The assistant stops being a chat box and becomes something
standing next to you at your machine.

| Friction | What ZAPI replaces it with |
|---|---|
| Describing your screen | It **sees** it — screenshots every turn, cursor display first, all monitors |
| Reading directions and hunting for UI | It **points** — the companion cursor flies to the actual button; ink draws arrows, circles, boxes, highlights, and handwritten notes onto your live desktop |
| Translating an answer into actions | It **acts** — agent mode drives the real mouse and keyboard through a screenshot→act loop until the task is done |
| Typing what you said | Dictation puts your words straight into the focused field |
| Leaving your workspace to find a tutorial | *"How do I export this as a PDF?"* produces a **numbered, annotated walkthrough drawn on the thing itself** — the answer is overlaid on the screen you're already looking at |
| Context lost between sessions | Long-running memory with automatic compaction, plus scheduled routines that run work on their own |

---

## The strategic unlock

Every other "AI in your app" solution integrates **per app** — a plugin here, an
API there, a copilot in one product only. ZAPI works at the **pixel and
peripheral layer**, which means it works with *every* app, including the fifty
closed-source, scriptless, legacy internal tools you actually spend your day in.

Nothing to integrate with. That's the whole thesis.

---

## Why this specific project exists

The original idea — a screen-aware companion that points at things — was
**Clicky**, and it was macOS-only Swift. [Flicky](https://github.com/jvaught01/flicky)
rebuilt it in Electron. ZAPI takes that lineage **Windows-first**, targeting
parity with [heyclicky.com](https://www.clicky.so/).

The problem statement therefore includes an **availability gap**: the most-used
desktop OS in the world had the least access to this interaction model.

---

## What "done" looks like

Three verbs, all working end-to-end on any app, hands-free:

- **Ask** — *"what's wrong with this?"* → spoken answer + ink on the actual elements
- **Show** — *"how do I do this?"* → step-by-step numbered walkthrough drawn on your screen
- **Do** — *"zapi agent, fix it"* → it clicks, types, scrolls, and drags until it's
  done, with a live step counter and a stop switch

---

## What we deliberately are *not* solving (yet)

**The honest boundary.** ZAPI drives the **one real cursor**, so physical input
cannot be parallelized. Multiple agents can reason concurrently, but they queue on
a global input lease for clicking and typing. True background input
(SendMessage / UI Automation — acting without stealing your pointer) is a separate
investigation, explicitly out of scope rather than hand-waved.

Likewise, a proactive "suggestions engine" is deferred until there's a real
activity signal to base it on.

---

## The one-sentence version

> AI assistants are blind advisors that live in a text box. **ZAPI makes one that
> can see your screen, point at it, speak about it, and do the work on it — on any
> app, on Windows.**
