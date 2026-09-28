# SFX + Media Survey — HeyClicky (heyclicky) bundle

**Date:** 2026-09-28
**Scope:** read-only survey of the extracted HeyClicky macOS app bundle. No file in
`D:\Work\ZAPI\flicky` (source or otherwise) was modified by this task; this
document is the only file written.

**Source bundle:** `D:\Work\ZAPI\heyclicky-extracted\HeyClicky\HeyClicky.app\Contents\Resources\`
**Media found:** 43 files — 17 `.wav`, 25 `.mp3`, 1 `.m4a`, **0 `.mp4`**
**Total media payload:** 11,101,751 bytes (~10.6 MB), of which `ff.m4a` alone is 5.7 MB (52%)

All media is flat in `Resources/` (no per-theme or per-platform subdirectories).
Durations/codecs below are from `ffprobe` (not estimated).

---

## 1. Inventory by moment

### 1a. Agent lifecycle (`agent-*`) — 4 files, ~0.8–1.1s each

| File | Size | Duration | Format |
|---|---|---|---|
| `agent-launch.wav` | 153,678 B (150 KB) | 0.80s | pcm_s16le 48kHz stereo |
| `agent-done.wav` | 199,758 B (195 KB) | 1.04s | pcm_s16le 48kHz stereo |
| `agent-needs-you.wav` | 207,438 B (203 KB) | 1.08s | pcm_s16le 48kHz stereo |
| `agent-close.wav` | 215,118 B (210 KB) | 1.12s | pcm_s16le 48kHz stereo |

A deliberate launch → needs-you → done → close quartet. Note the durations
lengthen as the agent's "attention" increases: launch is the shortest, close the
longest.

### 1b. Chat/turn text moments (`clicky-text-*`) — 4 files

| File | Size | Duration | Format |
|---|---|---|---|
| `clicky-text-open.wav` | 134,444 B (131 KB) | 0.70s | pcm_s16le 48kHz stereo |
| `clicky-text-send.wav` | 96,044 B (94 KB) | 0.50s | pcm_s16le 48kHz stereo |
| `clicky-text-receive.wav` | 134,444 B (131 KB) | 0.70s | pcm_s16le 48kHz stereo |
| `clicky-text-close.wav` | 163,244 B (159 KB) | 0.85s | pcm_s16le 48kHz stereo |

An open/send/receive/close cycle for a text turn. `open` and `receive` are
**byte-identical in size** (134,444 B), suggesting a shared source clip, while
`close` (163,244 B) matches `clicky-question.wav` exactly — a reused sting.

### 1c. Persona/emotion (`clicky-*` + connection) — 3 files

| File | Size | Duration | Format |
|---|---|---|---|
| `clicky-question.wav` | 163,244 B (159 KB) | 0.85s | pcm_s16le 48kHz stereo |
| `clicky-surprised.wav` | 96,044 B (94 KB) | 0.50s | pcm_s16le 48kHz stereo |
| `connection-question.wav` | 288,044 B (281 KB) | 1.50s | pcm_s16le 48kHz stereo |

`connection-question` is the longest UI sting in the bundle (1.50s) and is the
only one carrying a distinct name — it is presumably a first-connect/permission
prompt rather than an in-chat question.

### 1d. App lifecycle / reveal — 3 files

| File | Size | Duration | Format |
|---|---|---|---|
| `reveal-boot.wav` | 265,216 B (259 KB) | 1.36s | pcm_s16le 48kHz stereo |
| `home-reveal.wav` | 337,998 B (330 KB) | 1.76s | pcm_s16le 48kHz stereo |
| `hatching.wav` | 1,141,588 B (1,115 KB) | 3.96s | **pcm_s24le** 48kHz stereo |

`home-reveal` is the longest sting (1.76s) — a "the companion came back" moment.
`hatching.wav` is the outlier: 3.96s, 24-bit, ~1.1 MB, more than 3× every other
UI sound. The 24-bit depth (shared only with `skill-down`) marks it as a
higher-fidelity/mastered asset, likely an ambient or character animation bed
rather than a UI blip.

### 1e. Skills toggle — 2 files

| File | Size | Duration | Format |
|---|---|---|---|
| `skill-up.wav` | 151,724 B (148 KB) | 0.79s | pcm_s16le 48kHz stereo |
| `skill-down.wav` | 217,588 B (212 KB) | 0.75s | **pcm_s24le** 48kHz stereo |

`skill-up` (0.79s) and `skill-down` (0.75s) are near-identical in length but
differ in bit depth and file size — same slot in the UI, different mastering.
Both carry a `JUNK` chunk before `fmt ` (an ffmpeg artifact), which is why a
naive RIFF parse mis-reads them.

### 1f. Micro-feedback / shop — 3 files

| File | Size | Duration | Format |
|---|---|---|---|
| `enter.mp3` | 5,821 B (6 KB) | **0.08s** | mp3 48kHz stereo @ 609kbps |
| `eshop.mp3` | 68,221 B (67 KB) | 1.64s | mp3 48kHz stereo @ 334kbps |
| `tapback-thumbs-up.wav` | 99,468 B (97 KB) | 0.50s | pcm_s16le 48kHz stereo |

`enter.mp3` is the smallest file in the bundle and by far the shortest (0.08s) —
a UI key/confirm tick. `tapback-thumbs-up` is an iMessage-style reaction
ack (0.50s, sharing its size profile with `clicky-text-send`/`surprised`).

### 1g. Realtime voice previews — 10 files, 3.58–6.34s, mono 24kHz

| File | Size | Duration | Format |
|---|---|---|---|
| `realtime-voice-preview-marin.mp3` | 42,357 B (41 KB) | 3.58s | mp3 24kHz mono @ 95kbps |
| `realtime-voice-preview-cedar.mp3` | 45,885 B (45 KB) | 3.95s | mp3 24kHz mono @ 93kbps |
| `realtime-voice-preview-ash.mp3` | 51,909 B (51 KB) | 4.43s | mp3 24kHz mono @ 94kbps |
| `realtime-voice-preview-sage.mp3` | 53,709 B (52 KB) | 4.60s | mp3 24kHz mono @ 93kbps |
| `realtime-voice-preview-coral.mp3` | 54,501 B (53 KB) | 4.80s | mp3 24kHz mono @ 91kbps |
| `realtime-voice-preview-verse.mp3` | 55,509 B (54 KB) | 4.94s | mp3 24kHz mono @ 90kbps |
| `realtime-voice-preview-shimmer.mp3` | 57,789 B (56 KB) | 4.99s | mp3 24kHz mono @ 93kbps |
| `realtime-voice-preview-echo.mp3` | 64,029 B (63 KB) | 5.46s | mp3 24kHz mono @ 94kbps |
| `realtime-voice-preview-alloy.mp3` | 74,037 B (72 KB) | 6.11s | mp3 24kHz mono @ 97kbps |
| `realtime-voice-preview-ballad.mp3` | 71,037 B (69 KB) | 6.34s | mp3 24kHz mono @ 90kbps |

Ten named realtime-TTS voices (alloy, ash, ballad, cedar, coral, echo, marin,
sage, shimmer, verse), all mono 24kHz — a telephony-grade rate matching the
realtime speech pipeline, distinct from the 48kHz music-quality UI stings.

### 1h. TTS voice previews — 13 files, 2.37–4.32s, mono 44.1kHz

| File | Size | Duration | Format |
|---|---|---|---|
| `voice-preview-cheerful.mp3` | 38,914 B (38 KB) | 2.37s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-gentle.mp3` | 39,750 B (39 KB) | 2.41s | mp3 44.1kHz mono @ 132kbps |
| `voice-preview-fun.mp3` | 44,347 B (43 KB) | 2.69s | mp3 44.1kHz mono @ 132kbps |
| `voice-preview-smooth.mp3` | 45,601 B (45 KB) | 2.79s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-bright.mp3` | 48,527 B (47 KB) | 2.97s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-kid.mp3` | 48,527 B (47 KB) | 2.97s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-techy.mp3` | 49,363 B (48 KB) | 3.02s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-bubbly.mp3` | 51,035 B (50 KB) | 3.11s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-original.mp3` | 51,035 B (50 KB) | 3.11s | mp3 44.1kHz mono @ 131kbps |
| `voice-preview-expert.mp3` | 51,453 B (50 KB) | 3.16s | mp3 44.1kHz mono @ 130kbps |
| `voice-preview-lumen.mp3` | 55,214 B (54 KB) | 3.39s | mp3 44.1kHz mono @ 130kbps |
| `voice-preview-polished.mp3` | 59,812 B (58 KB) | 3.67s | mp3 44.1kHz mono @ 130kbps |
| `voice-preview-hope.mp3` | 70,261 B (69 KB) | 4.32s | mp3 44.1kHz mono @ 130kbps |

Several are **byte-identical duplicates** of one another — `bright`/`kid`
(48,527 B), `bubbly`/`original` (51,035 B) — meaning the same rendered clip is
reused under two persona names, so the file count overstates the true variety.

### 1i. `ff` — 1 file, 281.50s

| File | Size | Duration | Format |
|---|---|---|---|
| `ff.m4a` | 5,738,026 B (5,604 KB) | **281.50s (4m41s)** | AAC 48kHz stereo @ 163kbps |

The only `.m4a` and the only asset over a megabyte. At 4m41s it is not a UI
sting — it is almost certainly a long ambience/voice asset (e.g. a demo or
narration track) and is 52% of the bundle's media weight. **Not a moment sound;
excluded from the map below.**

---

## 2. The moment → sound map they use

Grouped by the moment each sound serves:

| Moment group | Sounds | Shape |
|---|---|---|
| **Agent lifecycle** | `agent-launch` (0.80s), `agent-needs-you` (1.08s), `agent-done` (1.04s), `agent-close` (1.12s) | ~1s stings, ascending urgency |
| **Text turn** | `clicky-text-open` (0.70s), `clicky-text-send` (0.50s), `clicky-text-receive` (0.70s), `clicky-text-close` (0.85s) | open/send/receive/close bracket |
| **Question / persona** | `clicky-question` (0.85s), `clicky-surprised` (0.50s), `connection-question` (1.50s) | prompting stings |
| **Reveal / boot** | `reveal-boot` (1.36s), `home-reveal` (1.76s), `hatching` (3.96s, 24-bit) | longest, most dramatic |
| **Skill toggle** | `skill-up` (0.79s), `skill-down` (0.75s, 24-bit) | matched up/down pair |
| **Micro-feedback** | `enter` (0.08s), `tapback-thumbs-up` (0.50s), `eshop` (1.64s) | tick / ack / flourish |
| **Realtime voices** | 10 × `realtime-voice-preview-*` (3.58–6.34s, 24kHz mono) | TTS voice picker |
| **TTS voices** | 13 × `voice-preview-*` (2.37–4.32s, 44.1kHz mono) | TTS voice picker |
| *(non-moment)* | `ff.m4a` (281.50s AAC) | long-form asset, not a sting |

Three observable design rules:

1. **Two production tiers.** UI stings are 48kHz/16-bit stereo PCM (lossless,
   for low-latency playback); voice previews are compressed mono (24kHz for
   realtime, 44.1kHz for standard TTS) because they are streamed, not triggered.
2. **Duration encodes importance.** Trivial ack 0.08–0.50s → state change
   0.7–1.1s → reveal 1.4–1.8s → `hatching` 3.96s as the ceremonial outlier.
3. **Clip reuse.** `open`≡`receive` (both 134,444 B) and `close`≡`question`
   (both 163,244 B), plus duplicated voice previews — the set is smaller than
   the file count implies.

---

## 3. Which moments map to events OUR app emits

Our app already has the IPC seam for this, but **it is currently inert.**

### 3a. The existing seam (verified)

- `src/shared/types.ts:662-663` — `PLAY_SFX: 'play-sfx'`, documented as
  *"Main → overlays: play a named ui sound (agent-launch/done/needs-you/question)"*
  — the comment already uses HeyClicky's exact moment names.
- `src/preload/index.ts:137-142` — `onPlaySfx: (cb: (name: string) => void)`
  bridges it into the renderer context.
- **Nothing emits it.** `PLAY_SFX` appears only at those two sites; there is no
  `ipcMain`/`sendToOverlay` producer and no renderer consumer of `onPlaySfx`.
- **No audio assets ship.** `assets/` contains only icons, tray images and
  entitlements; there is no `sounds/` directory and no `.wav`/`.mp3`/`.ogg`
  anywhere in the repo outside `node_modules`.

So the contract exists and the sounds do not. That is the whole gap.

### 3b. Moment → our event mapping

Our agent lifecycle is `AgentPhase = 'idle' | 'thinking' | 'waiting' | 'acting' | 'done' | 'failed'`
(`types.ts:176`), emitted as `AGENT_STATUS` (`index.ts:370`).

| Our event | Our source | Their sound | Verdict |
|---|---|---|---|
| **Agent start** | `AGENT_STATUS` phase `thinking` (`agent-orchestrator.ts:185`) | `agent-launch.wav` (0.80s) | **Direct 1:1.** Fires once per run. |
| **Agent working** | phase `acting` (`agent-orchestrator.ts:333`) | *(none)* | No equivalent — `acting` is a step-level tick, better served by `AGENT_ACTION` (`index.ts:378`) visuals. Do **not** sound per-step. |
| **Agent needs you** | phase `waiting` (`agent-driver.ts:58` documents this flip) | `agent-needs-you.wav` (1.08s) | **Direct 1:1.** The `waiting` phase is literally their "needs-you". |
| **Agent done** | phase `done` (`agent-orchestrator.ts:469`, `companion-manager.ts:1545`) | `agent-done.wav` (1.04s) | **Direct 1:1.** |
| **Agent fail** | phase `failed` (`agent-orchestrator.ts:469`, when `final.done` is false) | *(none)* | **No equivalent — gap.** They have no failure sound at all. Ours needs a distinct error sting; do **not** reuse `agent-done`. |
| **Question prompt** | *(no dedicated event)* | `clicky-question.wav` (0.85s) / `connection-question.wav` (1.50s) | **Partial.** Our `waiting` phase is the nearest hook — it is how we signal "the agent is blocked on you". Reusing it for both needs-you and question would double-fire, so question needs its own trigger (or a sub-state). |
| **Turn open** | `AI_RESPONSE_CHUNK` first chunk (`index.ts:328`) | `clicky-text-open.wav` (0.70s) | **Mappable**, needs edge-detection (first chunk only) to avoid per-token spam. |
| **Turn close** | `AI_RESPONSE_COMPLETE` (`index.ts:332`) | `clicky-text-close.wav` (0.85s) | **Direct 1:1.** Fires once per turn. |
| *(our send)* | `TEXT_TURN` / `TRANSCRIPT_UPDATE` (`index.ts:326`) | `clicky-text-send.wav` (0.50s) | **Mappable** — user-initiated, unambiguous. |
| *(our receive)* | `AI_RESPONSE_CHUNK` arrival | `clicky-text-receive.wav` (0.70s) | Redundant with `text-open`; **pick one** or you double-sound every turn. |

### 3c. Unmapped moments (no ZAPI equivalent — do not build)

`agent-close`, `clicky-surprised`, `reveal-boot`, `home-reveal`, `hatching`,
`skill-up`/`skill-down`, `enter`, `tapback-thumbs-up`, `eshop`, and all 23
voice-preview clips. Some are near-misses worth noting:

- `skill-up`/`skill-down` — we have `ARTIFACT_LIST`/`SUGGESTION_*` toggles, but
  no equivalent enable/disable verb; out of scope.
- `enter` (0.08s) — could key off the PTT shortcut
  (`SUSPEND_/RESUME_PUSH_TO_TALK_SHORTCUT`).
- `reveal-boot`/`home-reveal` — we have a tray + onboarding flow, but no
  "companion came back" event.
- `eshop` — no commerce surface in ZAPI.

---

## 4. ⚠️ We must originate our own chimes — licensing

**None of these 43 files may be copied, extracted, re-encoded, sampled, or
shipped in ZAPI.** They are part of a proprietary macOS app bundle
(`HeyClicky.app`) whose own `ATTRIBUTION.md` states it vendors third-party
material (Hermes Agent skills, MIT-licensed, per NousResearch) and that
backend wiring is "intentionally not included yet" — i.e. it is a closed,
in-progress commercial product. The audio files carry **no open license**; the
MIT notices in that file cover `SKILL.md` documents only, not the `.wav`/`.mp3`
assets.

Reusing the bytes would (a) infringe the rights in those sound recordings, and
(b) pull a proprietary binary blob into a repo whose `build.publish` currently
targets the public `jvaught01/flicky` GitHub repo.

**What to do instead — synthesize/generate our own.** The moment taxonomy above
is the reusable asset; the audio is not. Concretely:

1. **Keep the moment names.** `agent-start`, `agent-done`, `agent-needs-you`,
   `agent-fail`, `question`, `turn-open`, `turn-close`, `turn-send` are a sound
   *design brief*, not their property. Reuse the taxonomy, rename to ZAPI
   vocabulary.
2. **Generate short, original stings.** Sub-1.5s, mono-ok, 44.1–48kHz. A
   programmatic tone/FM-synthesis approach or a commissioned/F0-licensed
   generator both work. Apply a ~10ms fade-in/out on every clip to avoid the
   click that afflicts raw synthesized envelopes.
3. **Ship ours as `assets/sounds/`.** Note `package.json` `build.files` is
   `["dist/**/*", "assets/**/*"]`, so a new `assets/sounds/*.wav` is packaged
   automatically with no build-config change.
4. **Budget realistically.** Their UI stings total ~1.5 MB; ours should land
   well under 200 KB for 7–9 clips (mono 22.05kHz WAV, or MP3/OGG). This keeps
   the `size-report` 500 KB bundle rule clear with room to spare (current dist
   total is 831 KB, largest chunk 189 KB).
5. **Wire the existing `PLAY_SFX` seam** rather than adding a new channel — it
   is already declared, typed, and bridged, and its doc comment already names
   these moments. Emit `sendToOverlay(IPC.PLAY_SFX, 'agent-done')` etc. from
   the `AGENT_STATUS` phase transitions, and add a renderer `onPlaySfx`
   consumer with a settings toggle (respect the existing mute/VAD settings) and
   a per-moment cooldown so rapid phase changes cannot stack.
6. **Do not sound `acting` per step.** Long agent runs would machine-gun the
   speaker; the `thinking`→`waiting`→`done` edges are the meaningful ones.

---

## 5. CodexRuntime directory contents (2 levels)

**Not found.** There is no `CodexRuntime` directory in the extracted bundle or
anywhere under `D:\Work\ZAPI`. The closest references are:

- `Contents/Resources/codex.md` (4,522 B) — a flat markdown skill/instruction
  doc. A search of it for `CodexRuntime`, `runtime`, and `node_modules`
  returned **no matches**, so the runtime is presumably compiled into the
  (absent) Mach-O binary or lives on the install path outside this extraction.
- `Contents/Resources/ClickyBundledSkills/` — 15 skill directories:
  `clicky-artifacts`, `clicky-build-preview`, `clicky-creative-studio`,
  `clicky-dev-setup-doctor`, `clicky-email-assistant`,
  `clicky-google-workspace`, `clicky-repo-operator`, `clicky-research-report`,
  `cua-driver`, `doc`, `frontend-design`, `obsidian`, `pdf`, `spreadsheet`,
  `vercel-deploy`. None contain media files.

The extracted bundle is 27 directories / 104 files, all under
`HeyClicky.app/Contents/` → `Resources/` — there is no `MacOS/` binary directory,
no `Frameworks/`, and no runtime of any kind, so this extraction is
**Resources-only**. `CodexRuntime` may still exist in the real
`HeyClicky.app/Contents/MacOS/` or `Frameworks/` on the install machine.

---

## 6. Summary

- **43 media files, 10.6 MB, 17 wav / 25 mp3 / 1 m4a / 0 mp4.** All flat in
  `Resources/`; no nested media.
- **~20 are UI moment sounds** across 6 moment groups; 23 are TTS voice
  previews; `ff.m4a` (4m41s) is a long-form asset, not a moment sound.
- **6 moments map cleanly onto ZAPI's existing event set** (agent
  start/done/needs-you, turn open/close, user send). Two are partial (question
  prompt; receive) and one is a genuine gap (**agent fail** — they have no
  failure sound, so we must originate one).
- **ZAPI already has the `PLAY_SFX` channel declared and bridged but never
  emitted, and ships zero audio assets.** The wiring gap and the asset gap are
  both still open; the seam at `types.ts:663` / `preload/index.ts:138` is ready.
- **The taxonomy is reusable; the audio is not.** Every chime must be
  synthesized or properly licensed — the HeyClicky files are copyrighted assets
  of a closed product and cannot be copied into ZAPI.

- `reveal-boot`/`home-reveal` — we have a tray + onboarding flow, but no
  "companion came back" event.
- `eshop` — no commerce surface in ZAPI.

---


ack (0.50s, sharing its size profile with `clicky-text-send`/`surprised`).

---
