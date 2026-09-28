# ZAPI

A screen-aware AI companion for **Windows**. Hold a hotkey and talk — Zapi sees your screen, answers out loud, draws arrows / circles / highlights right on your display to point things out, and can take the wheel and drive your mouse + keyboard when you ask it to.

> **Inspired by [Clicky](https://www.clicky.so/)** by [Farza](https://github.com/farzaa) ([github.com/farzaa/clicky](https://github.com/farzaa/clicky)), and forked from **[Flicky](https://github.com/jvaught01/flicky)**.
> Clicky is the original idea — a macOS-only Swift app. Flicky reimagined it in Electron; ZAPI continues that lineage as a **Windows-first** companion. All credit for the original concept, the pointing-cursor interaction, and the "vibe" goes to Farza. If you're on a Mac, go check out the original — it's great.

---

## What ZAPI does

- **Talk** — push-to-talk or always-on listening (a local VAD in the overlay segments utterances, so you can just start speaking).
- **Dictation mode** — transcribed speech is typed into whatever field is focused instead of being sent to the model.
- **Draws on your screen** — responses can carry an ordered scene of cues: the companion cursor points at UI elements, and the overlay sketches arrows, circles, boxes, highlights, freehand paths, and handwritten labels over your real desktop.
- **Agent computer control** — turns starting with the agent trigger ("zapi agent", "hey agent") run a screenshot→act loop that clicks, types, scrolls, and drags on your behalf, with a live step counter and a stop switch in the stream window.
- **Multiple agents** — create named agents, each with its own face, color, chat history, and scheduled routines. Say "zapi agent scout: check the build" and the request lands on Scout's card instead of the default one. Only one agent drives the mouse at a time; the others queue up visibly instead of fighting over the cursor.
- **File deliverables** — when an agent produces something worth keeping (a sheet, a note, a script), it hands it over as a file in your ZAPI data folder — one folder per agent — rather than pasting a wall of text into chat.
- **Mind** — pick **Anthropic Claude** (Opus / Sonnet 4.6) or **OpenAI** (GPT-5, GPT-5 mini, GPT-4o, or a custom model id) on the fly; local OpenAI-compatible endpoints (Ollama) work too.
- **Voice** — **Fish Audio** or **ElevenLabs** text-to-speech, with per-voice speed and stability sliders.
- **Ear** — **Groq** Whisper Large v3 / v3 Turbo or **OpenAI** transcription.
- **Stream window** — a transparent, always-on-top mirror of the live Q/A with the scene cue rail and agent status.
- **Long-running context** — local chat history plus auto-compaction into a rolling summary near a configurable token budget, so one conversation can run forever.
- **Provider key management** — separate, encrypted local storage for each provider's API key with one-click validation.

---

## New to ZAPI?

**Start here → [docs/QUICKSTART.md](docs/QUICKSTART.md)** — a plain-language first-run guide for Windows: where the tray icon is, which keys to add, the three ways to talk to it (talk / dictation / agent), hotkeys, named agents, routines, and where the files it produces land. Includes a demo you can run with no API keys at all.

---

## Running locally

Requires [Bun](https://bun.sh) (or npm) and Node 20+. Windows is the supported platform.

```bash
bun install
bun run dev
```

That starts the TypeScript watcher for the main process and Vite for the renderer. Launch the Electron app from a separate terminal once the dev servers are up:

```bash
bun run start
```

## Building installers

```bash
bun run package          # current platform
bun run package:win      # Windows .exe (NSIS)
```

Releases are also produced automatically by GitHub Actions on every `v*` tag — see [`.github/workflows/build.yml`](.github/workflows/build.yml).

## Configuration

You'll need API keys for the providers you want to use:

- **Anthropic** or **OpenAI** — mind (reasoning)
- **Fish Audio** or **ElevenLabs** — voice (text-to-speech)
- **Groq** or **OpenAI** — ear (speech-to-text)

Add them in the panel under **Mind**, **Voice**, and **Ear**. Keys are stored locally with platform-appropriate encryption — they never leave your machine except in API calls to the relevant provider.

## License

MIT — see [LICENSE](LICENSE).

The original Clicky project is the intellectual seed for this work; ZAPI descends from it through Flicky and is an independent implementation that does not bundle or redistribute Clicky's source. If you like what's here, please also star [Farza's repo](https://github.com/farzaa/clicky).
