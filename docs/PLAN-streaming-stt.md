# PLAN — Live partial transcripts (streaming STT)

Status: **research + spec, no code changed.** Written 2026-09-28 against the
current tree (`transcription.ts`, `companion-manager.ts`, `OverlayApp.tsx`,
`audio-capture-worklet.js`). Closes the P2 parity gap: heyclicky shows the
sentence you are saying *while you say it*; we show nothing until the upload
finishes.

Prices and endpoints below were checked on 2026-09-28. STT pricing moves fast —
re-verify before sizing anything.

## TL;DR

1. **Groq has no streaming endpoint.** It is a file-upload API with a **10-second
   minimum bill per request**. Every "streaming with Groq" project in the wild is
   client-side VAD chunking with overlap + word dedup.
2. **OpenAI does**: the Realtime API's dedicated transcription sessions
   (`type: "transcription"` + `gpt-live-transcribe`) stream transcript deltas over
   a WebSocket and take the key we *already* ask users for. It wants **24 kHz**
   PCM; we capture 16 kHz.
3. **Deepgram is the cleanest fit**: WebSocket streaming on `linear16` 16 kHz —
   byte-for-byte our worklet output — with interim results and 200–500 ms
   end-to-end. Costs a new BYOK key slot.
4. **Ship in two tracks.** Track A (Groq chunked partials, no new vendor) buys the
   perceived-latency win this week on the existing key. Track B (Deepgram, then
   OpenAI Realtime behind the existing OpenAI key) is the honest streaming path.
   Local whisper.cpp is a later, packaging-heavy option.

## Where we are today

```
overlay (one display owns the mic)
  AudioWorklet  'capture-processor'  → PCM16 mono 16 kHz Int16Array per 128-frame quantum
     ├─ mode 'vad'  → handleVadChunk() → ships a FINISHED utterance over IPC
     └─ mode 'ptt'  → sendAudioChunk(e.data) → main, every quantum
main
  AUDIO_IPC.AUDIO_CHUNK (index.ts:1047) → companion.handleAudioChunk (companion-manager.ts:2110)
     → provider.sendAudio(chunk)        // memory only, capped at MAX_PCM_BYTES = 960 kB ≈ 30 s
  PTT release → provider.stop()          // buildWav() the whole buffer → POST multipart
  VAD utterance → transcribeWith(type, pcm)  // same upload, no prior sendAudio
```

Facts that matter for this design:

- `TranscriptionProvider` (`transcription.ts:126`) is `{ start, stop, sendAudio, transcribe }`.
  `start()`/`stop()`/`sendAudio()` are PTT; `transcribe()` is the VAD one-shot.
- `TranscriptionResult` (`types.ts:25`) is `{ text, isFinal }` — **the partial
  shape already exists** and `IPC.TRANSCRIPT_UPDATE` already fans a
  `TranscriptionResult` to every window (`index.ts:326`, preload
  `onTranscriptUpdate`).
- `companion-manager.ts:1160` documents, on purpose, that the partial hook was
  removed because "every provider is a file upload". This plan puts a real
  provider behind it — the hook comes back, or is replaced by the sink below.
- 16 kHz is baked in at two places: `OverlayApp.tsx:574` (getUserMedia constraint)
  and `OverlayApp.tsx:583` (`new AudioContext({ sampleRate: 16000 })`).
  Groq (downsamples to 16 kHz internally) and Deepgram want exactly this;
  OpenAI Realtime wants 24 kHz.
- The overlay's VAD is wall-clock based (`performance.now()`) except
  `VAD_VOICED_RUN = 3` *quanta* (`OverlayApp.tsx:53`) — the one knob that is
  rate-sensitive if we move the context to 24 kHz.

## 1. Groq — no streaming endpoint

Groq's speech-to-text surface is exactly two endpoints:

| Endpoint | Usage |
| --- | --- |
| `POST https://api.groq.com/openai/v1/audio/transcriptions` | file or `url` upload |
| `POST https://api.groq.com/openai/v1/audio/translations` | same, English output |

The docs advertise a "Real-time Speed Factor" — 189× on `whisper-large-v3`, 216×
on turbo in the docs table, and 299× for large-v3 in Groq's launch blog. That is
*throughput*, not streaming: a 6-second clip takes a few tens of ms of
**inference, after the upload is finished**, and there is no socket to push audio
into. No websocket endpoint, no `stream=true` partial mode.

The community consensus (LiveKit-style voice agents, the `groq_whisper_stt`
Flutter package, Whisper-Streaming) is pseudo-streaming:

```
VAD → window every 2–3 s with ~500 ms overlap → upload each window
     → prompt-chain the previous transcript → dedupe overlapping words
     → emit { sessionText, isFinal }
```

**The cost trap:** Groq bills a **10-second minimum per request** for ASR. A
3-second window costs the same as a 10-second one. For a 6-second PTT turn with
3 windows: 3 × 10 s = 30 s billed (0.5 min) ≈ **$0.00033** on
`whisper-large-v3-turbo` ($0.04/h) versus **$0.00011** for the single upload we
do today — call it 3–4× per turn. On `whisper-large-v3` ($0.111/h) it is
~$0.0012/turn. Fine at desktop volumes, wrong to leave un-togglable.

Verdict: **not a streaming provider, but a viable interim-text engine** because
it reuses the key slot users already have. `response_format=verbose_json` with
`timestamp_granularities[]=word` gives per-word times, which is what a
LocalAgreement-style commit rule needs.

## 2. OpenAI — real streaming, existing key, 24 kHz

Realtime transcription sessions are a first-class endpoint:

```
POST https://api.openai.com/v1/realtime/transcription_sessions     → client_secret (ephemeral)
wss://api.openai.com/v1/realtime?intent=transcription
```

Session shape (server-side WebSocket, which is what main is):

```json
{ "type": "session.update",
  "session": { "type": "transcription",
    "audio": { "input": {
      "format": { "type": "audio/pcm", "rate": 24000 },
      "transcription": { "model": "gpt-live-transcribe", "delay": "low" },
      "turn_detection": null } } } }
```

- `input_audio_buffer.append` with base64 PCM, `input_audio_buffer.commit` at
  end of turn.
- `conversation.item.input_audio_transcription.delta` → interim text;
  `.completed` → final for that `item_id` (match on `item_id`; cross-turn
  completion ordering is **not** guaranteed).
- `gpt-live-transcribe` does **not** support `server_vad`/`semantic_vad` — turn
  detection is ours (PTT release, or the overlay's existing VAD → `commit`).
  That is a feature for us: one end-of-turn authority, no double-VAD.
- Knobs: `prompt`, `keywords` (product names — exactly the bias trick the Groq
  path already uses with its 224-token `prompt`), `languages`, `delay`
  (`minimal|low|medium|high|xhigh`).
- No word timestamps, no confidence, no diarization on the live path
  (`gpt-4o-transcribe-diarize` is file-only).
- `gpt-transcribe` ($0.0045/min) is the cheaper session model but only transcribes
  **after** a commit — a final, not a partial. `gpt-live-transcribe` is the one
  that streams.

| Model | $/min | Where |
| --- | --- | --- |
| `gpt-live-transcribe` | 0.017 | realtime session, deltas as speech arrives |
| `gpt-realtime-whisper` | 0.017 | realtime session |
| `gpt-transcribe` | 0.0045 | realtime session, post-commit only |
| `gpt-4o-transcribe` | 0.006 | `/v1/audio/transcriptions` (today's path) |
| `gpt-4o-mini-transcribe` | 0.003 | `/v1/audio/transcriptions` |

**The 24 kHz problem, and the cheap fix.** `pcm16` realtime input is 16-bit
**24 kHz** mono. We do not need a resampler: construct the capture context at
24 kHz and the worklet output is natively correct —
`OverlayApp.tsx:574` and `:583` become `sampleRate: 24000`, the provider is told
the rate, and the model downsamples internally anyway. Two knock-ons:
`VAD_VOICED_RUN` 3 → 5 quanta (a quantum is 5.3 ms at 24 kHz vs 8 ms at 16 kHz),
and `MAX_PCM_BYTES` 960 kB → 1.44 MB to keep the 30-second cap. A
`sampleRate` that is provider-dependent is the one piece of real plumbing here,
which argues for keeping 16 kHz capture and resampling per-provider *unless*
OpenAI Realtime graduates to a default — see the recommendation.

**Transport:** Electron 33 ships Node 20.18, which has no unflagged global
`WebSocket`. Add `ws` as a real dependency (it is only transitively present
today) or open the socket from the overlay renderer (Chromium has a native
`WebSocket`, and the audio is already there) — but the renderer route means
handing a decrypted BYOK key to a web context, so `ws` in main is the safer of
the two.

## 3. Deepgram — the cleanest streaming fit

```
wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US
  &encoding=linear16&channels=1&sample_rate=16000
  &interim_results=true&smart_format=true&utterance_end_ms=1000&vad_events=true
```

- **`linear16` 16 kHz mono is byte-for-byte our worklet output** — no rate
  change, no resampler, no `ws` in the renderer.
- Interim transcripts arrive as `is_final: false` and get corrected upward;
  `UtteranceEnd` (driven by `utterance_end_ms`) is the natural final, and
  `vad_events` gives `SpeechStarted` for "listening harder" UI.
- `LiveOptions` are **immutable per connection** — you cannot flip
  `interim_results` mid-session; reconnect to change them.
- Nova-3: sub-300 ms transcription latency, 200–500 ms end-to-end, median WER
  ~6.8% on live audio. Flux adds semantic turn detection and interruption
  handling (nice for a future barge-in, out of scope now).
- Pricing: Nova-3 streaming $0.0043–0.0077/min (list $0.0077, currently
  $0.0048), Flux $0.0065/min. Per minute of audio. Some third-party notes claim
  interim results add billable request volume on top — verify on a real account
  before quoting a number to anyone.
- Cost: a 6-second turn ≈ **$0.0005** at the current rate, ~$0.0008 at list.
  Cheaper than OpenAI Realtime by ~3×, and the only option with zero format
  work.

Verdict: **the reference implementation for Track B.** Costs a new key slot in
`ApiKeyName` + a panel entry, which is a day of plumbing and no risk.

## 4. Alternatives surveyed

| Option | Streaming? | Wire format | Latency | BYOK fit | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Azure Speech** (`microsoft-cognitiveservices-speech-sdk`) | Yes — `startContinuousRecognition()` with `PushAudioInputStream`; `recognizing` = partial, `recognized` = final | native PCM16 16 kHz | ~300–700 ms | needs region + key + optional custom endpoint (an *account*, not just a key) | Viable, heavier: a big SDK, a second credential shape, and we already have TTS providers. 3–4 d. |
| **AssemblyAI Universal-Streaming** (`wss://streaming.assemblyai.com/v3/ws`) | Yes, ~256 ms P50, intelligent endpointing | PCM16 16 kHz | ~250 ms | new key slot | Same shape as Deepgram, ~3× the price ($0.15/h session-duration billing — **idle socket time counts**). Park it. |
| **Soniox** `stt-rt-v5` | Yes, token-level | PCM16 | ~260 ms TTFS | new key slot | Cheapest streaming (~$0.12/h) but 10 concurrent sessions and a smaller accuracy story than Nova-3. Park it. |
| **whisper.cpp** (`whisper-cli`, `whisper-server`) | **No.** Chunked windows + LocalAgreement/Whisper-Streaming policy on top | our PCM | 0.3–2 s per window on CPU; 5–15× with CUDA | none — but 40–80 MB model download + native binary in the installer | The "Local (private)" provider. 4–6 d including packaging/signing per platform. Later. |
| **faster-whisper** (CTranslate2) | Only via a server (`speaches` exposes OpenAI-compatible live transcription) or Whisper-Streaming | wav over HTTP | 0.2–1× realtime | none | Needs Python on the user's machine — disqualifying for a BYOK desktop app unless we ship a runtime. |
| **sherpa-onnx** | Yes — genuinely streaming models (zipformer/paraformer), native Node/Electron bindings, VAD, silero, has an Electron demo | our PCM | ~100–300 ms, tiny models | none | The best *local* answer if/when we want sub-300 ms offline. 3–5 d. Later. |
| **Web Speech API** (`webkitSpeechRecognition`) | — | — | — | — | **Dead end**: Chromium ships no speech backend and Electron's renderer has none. There is no Google endpoint to call. |
| **Windows 11 on-device speech** (WinRT `Windows.Media.SpeechRecognition`) | Yes | our PCM | good | none | Not reachable from Electron without a native addon, and the public WinRT surface is weaker than Azure's. Skip. |

## 5. Recommended path

Three tracks, in this order. A and B are independent; C is optional positioning.

**Track A — interim text on the key we already have (Groq chunking), ~1.5 d.**
Wrap the existing upload, don't replace it:

- Keep `sendAudio` buffering exactly as today (the final upload stays authoritative).
- Add a 2.5 s window timer (300 ms overlap) that uploads the trailing window with
  `response_format=verbose_json&timestamp_granularities[]=word`, keeps the
  previous window's words, and commits the longest **two-window agreement**
  (LocalAgreement-2) as "stable" while the rest shows as volatile.
- Emit `{ text: stable + volatile, isFinal: false }`. The final still comes from
  the one full-utterance upload on PTT release, so trigger detection
  (`extractAgentTask`) and history stay byte-identical to today.
- Gate behind a setting; ~3–4× per-turn cost on turbo.

**Track B — real streaming, ~5 d total.**
B1 Deepgram (2–3 d): `DeepgramStreamingProvider` behind the existing
`TranscriptionProvider` interface, new `deepgram` key slot, native 16 kHz.
B2 OpenAI Realtime (2–3 d, +0.5 d for the 24 kHz context switch): reuses the
OpenAI key users already have, so it can ship as "if you have an OpenAI key, turn
this on" with zero new signup. Add `ws` as a dependency either way.

**Track C — local/private, later, 4–6 d.** `whisper-server`/`whisper.cpp` behind
the same interface, model download + checksum on first use, CPU fallback. Only
worth it when the privacy story needs to be demonstrable, not just claimed.

**Why not lead with OpenAI Realtime?** It is the best *fit to our key story* but
the 24 kHz context change touches the capture path shared by the VAD, and
$0.017/min is 15× the Groq final and 3× Deepgram. B1 first, B2 second, and let
the provider dropdown absorb the rate.

## 6. Spec

### 6.1 Provider shape

Keep the existing four methods; add an optional partial sink and a capability
flag so batch providers stay untouched and the turn pipeline can ask "will there
be partials?" before it promises the user a live caption.

```ts
// src/main/services/transcription.ts
export interface TranscriptionProvider {
  start(): Promise<void>;
  stop(): Promise<TranscriptionResult>;
  sendAudio(pcm16Buffer: Buffer): void;
  transcribe(pcmData: Buffer): Promise<TranscriptionResult>;

  /**
   * Interim-text sink. Providers that cannot stream never implement this
   * and `streams` stays false; the sink is only wired when the user has
   * live partials enabled, so no provider needs to check a setting.
   */
  setPartialSink?(sink: (partial: TranscriptionResult) => void): void;
  /** True when interim text will actually arrive for this turn. */
  readonly streams?: boolean;
}
```

`transcription.ts` already has a `stashFailedUtterance` diagnostic for failed
uploads; a streaming provider needs the same discipline for a socket that dies
mid-utterance (see 6.4).

### 6.2 Shared contract (`src/shared/types.ts`)

```ts
export interface TranscriptionResult {
  text: string;
  isFinal: boolean;            // exists today
  /**
   * Interim text REPLACES the utterance-so-far; it is not an append.
   * The stream rail's `streamingUser` currently appends, so a partial
   * arriving on the same channel would double up — hence a separate
   * channel rather than a flag on this one.
   */
  replace?: boolean;
  /** Vendor confidence when the provider gives one; undefined otherwise. */
  confidence?: number;
}

export type TranscriptionProviderType =
  | 'groq' | 'openai' | 'native'
  | 'deepgram'            // new — Track B1
  | 'openai-realtime'     // new — Track B2
  | 'local';              // Track C

export type ApiKeyName = 'anthropic' | 'openai' | 'elevenlabs'
  | 'fishaudio' | 'groq' | 'deepgram';   // += deepgram
```

Settings: `sttPartialsEnabled: boolean` (default **on** for providers with
`streams`, off otherwise), `sttPartialModel?: string` (provider-specific model
picker — `nova-3` / `gpt-live-transcribe` / Groq model), and
`sttInterimOnly?: boolean` (default true: partials are display-only).

### 6.3 IPC

Add, do not reuse:

```
IPC.TRANSCRIPT_PARTIAL: 'transcript-partial'   // send → renderers, payload TranscriptionResult
IPC.SET_STT_PARTIALS: 'set-stt-partials'      // send boolean
```

`onTranscriptPartial(cb)` in preload. Rationale: `TRANSCRIPT_UPDATE` feeds
`setStreamingUser(chunk)` (`ChatsTab.tsx:94`) — an **appending** rail. Partials
replace, finals are one-shot; a second channel keeps both renderers honest with
no flag gymnastics, and lets us drop partials wholesale without touching the
user-chat path.

### 6.4 Turn-pipeline rules (`companion-manager.ts`)

1. In `startPushToTalk` (~:1158) — this is where the dead hook used to be — if
   `sttPartialsEnabled && provider.streams`, call
   `provider.setPartialSink?.(r => this.onPartialTranscript(r, isCurrent))`.
2. The sink body **must** gate on `isCurrent()` like every other async callback
   (turn-interruption contract in `AGENTS.md`). A partial landing after a
   PTT interrupt or a new turn is dropped on the floor.
3. **Partials are display-only.** They never enter the turn pipeline, never
   reach `extractAgentTask`, never get written to chat history, and never
   count toward the self-setting-command gate. Only the `isFinal: true` result
   from `stop()` runs the turn. This is the single most important rule in the
   design: a live caption that can re-trigger the agent is a hazard.
4. On `stop()`: clear the sink, then await the final as today. If a provider
   socket is still connecting, `stop()` must still resolve with the buffered
   upload (never hang on a socket that will not open) — the 30 s
   `UPLOAD_TIMEOUT_MS` precedent applies to the connect+first-response budget.
5. On socket death mid-turn: log + `stashFailedUtterance`-style diagnostics,
   fall back to the buffered full upload for the final, and surface one
   non-fatal line in the panel ("live transcript unavailable this turn"). Never
   fail a turn because the *partials* died.
6. `transcribeWith()` (the VAD path) is unchanged in Track A/B1. Deepgram's
   `utterance_end_ms` would let always-on mode stream continuously, but that
   means a second endpointing authority next to the overlay's VAD — defer it;
   partials are PTT-first.

### 6.5 Failure, cost and latency budgets

- Interim text target: **< 800 ms** after the corresponding audio; first interim
  within ~1.5 s of speech starting.
- Interim churn is expected and fine; the UI should render volatile text dimmed
  and stable text solid (Deepgram/OpenAI both revise upward).
- Cost ceiling per turn on turbo/Groq chunking: ~$0.0005. Above that, shorten
  the window or fall back to finals-only.
- WS connect budget: 3 s, one reconnect with backoff, then degrade to
  buffered-final for the rest of the turn.

### 6.6 Panel

Ear tab: a "Live transcript" switch (disabled with a hint when the selected
provider has no streaming), a model dropdown that only lists what the provider
supports, and a deepgram key field in the keys section. Keep the switch off by
default for `groq` (it costs 3–4×) and on for `deepgram`/`openai-realtime`.

## 7. Effort

| Item | Days | Notes |
| --- | --- | --- |
| Contract (types + IPC + preload + settings + key slot) | 1 | Shared by every track; land once |
| Track A — Groq chunked partials | 1–1.5 | Chunker + LocalAgreement-2 committer + tests |
| Track B1 — Deepgram WS provider | 2–3 | Includes reconnect/backoff + panel |
| Track B2 — OpenAI Realtime provider | 2–3 | Plus 0.5 d for the 24 kHz context + VAD retune |
| Azure Speech provider | 3–4 | Bigger SDK, region+endpoint credential |
| Track C — local whisper.cpp | 4–6 | Binary bundling, model download, per-platform signing |
| Track C′ — sherpa-onnx streaming | 3–5 | Native binding, streaming (non-Whisper) models |

Smoke coverage for any track: a fake socket/provider asserting the sink fires
with `isFinal: false`, that a partial after an abort is dropped, that finals
still come from `stop()`, and that `extractAgentTask` never sees interim text.

## 8. Open questions

- Does the panel's live-caption UI want word-level highlighting (needs Deepgram
  word timings or timestamps on a second upload)? Out of scope until the basic
  interim line lands.
- Always-on VAD + streaming means two end-of-turn authorities. If we ever want
  interim text in always-on mode, the overlay's VAD should become the only one
  and the provider's `utterance_end_ms` should be ignored.
- Do we want a barge-in path (Flux/Deepgram interruption handling) for agent
  mode? Nice, unrelated to partials, do not bundle.
- If Groq ever ships a websocket endpoint, Track A collapses into Track B and the
  LocalAgreement code goes away — keep it isolated in one module so that is a
  delete, not a refactor.

## Sources

- Groq speech-to-text docs — <https://console.groq.com/docs/speech-to-text>
- Groq ASR announcement (10 s minimum billing) — <https://groq.com/blog/largest-most-capable-asr-model-now-faster-on-groqcloud>
- OpenAI realtime transcription guide — <https://developers.openai.com/api/docs/guides/realtime-transcription>
- OpenAI create transcription session (ephemeral key, model list) — <https://developers.openai.com/api/reference/resources/realtime/subresources/transcription_sessions/methods/create/>
- OpenAI pricing (transcribe + realtime per-minute) — <https://developers.openai.com/api/docs/pricing>
- Deepgram interim results — <https://developers.deepgram.com/docs/interim-results>
- Deepgram streaming latency — <https://developers.deepgram.com/docs/measuring-streaming-latency>
- Deepgram pricing — <https://deepgram.com/pricing>
- Azure Speech quotas/limits (SDK real-time billing) — <https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits>
- AssemblyAI Universal-Streaming — <https://www.assemblyai.com/universal-streaming>
- sherpa-onnx (Node/Electron streaming ASR) — <https://github.com/k2-fsa/sherpa-onnx>
- faster-whisper — <https://github.com/SYSTRAN/faster-whisper>
