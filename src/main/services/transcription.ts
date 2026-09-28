import type { TranscriptionResult, TranscriptionProviderType } from '../../shared/types';
import { getApiKey } from './key-store';
import { normalizeBase } from './ollama-api';
import * as settingsStore from './settings-store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Provider Interface ─────────────────────────────────────────────────

/**
 * Single retry on 429/5xx (and network hiccups) with ~800ms backoff.
 * Transcription calls are on the voice-turn critical path — one quick
 * retry absorbs the provider's transient blips without making a real
 * outage feel any slower than it is.
 */
const RETRY_DELAY_MS = 800;
/**
 * Per-attempt upload deadline — a half-open connection must not wedge a
 * turn on 'listening' forever. Fresh per attempt: a fired timeout signal
 * stays aborted, so it can't be shared across retries.
 */
const UPLOAD_TIMEOUT_MS = 30_000;
/**
 * PCM16 mono 16 kHz → 32 kB/s; ~30 s of voice ≈ 960 KB. Beyond that the
 * upload is unbounded audio, slow, and almost always a stuck-PTT bug —
 * cap the buffer, then refuse the upload with a 'too long' message.
 */
const MAX_PCM_BYTES = 960_000;
/** Rolling cap on the failure-stash dir — diagnostics, not a log sink. */
const FAILED_UTTERANCES_MAX_BYTES = 5 * 1024 * 1024;

function failedUtteranceDir(): string {
  return path.join(os.tmpdir(), 'zapi-failed-utterances');
}

/**
 * Keep the PCM that just failed to transcribe so a broken endpoint /
 * bad upload is debuggable after the fact. Best-effort: diagnostics
 * never throw into the turn path.
 */
function stashFailedUtterance(wav: Buffer, providerLabel: string, detail: unknown): void {
  try {
    const dir = failedUtteranceDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.wav'))
      .sort();
    let total = existing.reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(dir, f)).size;
      } catch {
        return sum;
      }
    }, 0) + wav.length;
    while (total > FAILED_UTTERANCES_MAX_BYTES && existing.length > 0) {
      const victim = existing.shift() as string;
      try {
        total -= fs.statSync(path.join(dir, victim)).size;
        fs.unlinkSync(path.join(dir, victim));
      } catch { /* keep going */ }
    }
    const file = path.join(dir, `${Date.now()}-${providerLabel}.wav`);
    fs.writeFileSync(file, wav);
    console.warn(
      `[Zapi] transcription failed — ${wav.length}B utterance via ${providerLabel}, copy kept at ${file}:`,
      detail,
    );
  } catch { /* a diagnostic path must never break the turn */ }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function postWithRetry(
  url: string,
  formData: FormData,
  apiKey: string,
  providerLabel: string,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      // Anything non-retryable (or the last attempt) returns as-is.
      if (res.ok || attempt === 1 || (res.status !== 429 && res.status < 500)) {
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        const timeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new Error(
          timeout
            ? `${providerLabel} took too long to answer — try again`
            : `can't reach ${providerLabel} — check your internet connection`,
        );
      }
    }
    await delay(RETRY_DELAY_MS * (attempt + 1));
  }
  throw lastErr;
}

/** Turn HTTP failures into short plain-language errors for the panel. */
function transcriptionError(status: number, providerLabel: string, detail: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`${providerLabel} rejected your key — check it in the Zapi panel`);
  }
  if (status === 429 || status >= 500) {
    return new Error(`${providerLabel} is having trouble right now — try again in a moment`);
  }
  return new Error(
    `${providerLabel} transcription error ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
  );
}

export interface TranscriptionProvider {
  start(): Promise<void>;
  stop(): Promise<TranscriptionResult>;
  sendAudio(pcm16Buffer: Buffer): void;
  /**
   * Transcribe one self-contained PCM16 buffer without any prior
   * sendAudio calls — the always-on VAD path hands us finished
   * utterances rather than streamed chunks.
   */
  transcribe(pcmData: Buffer): Promise<TranscriptionResult>;
}

// ── Groq Whisper Provider ──────────────────────────────────────────────

export class GroqWhisperProvider implements TranscriptionProvider {
  private audioChunks: Buffer[] = [];
  private bufferedBytes = 0;
  private overflowed = false;

  async start(): Promise<void> {
    const apiKey = getApiKey('groq');
    if (!apiKey) throw new Error('Groq API key not configured. Add it in the Zapi panel.');
    this.audioChunks = [];
    this.bufferedBytes = 0;
    this.overflowed = false;
  }

  sendAudio(pcm16Buffer: Buffer): void {
    // Bound the buffer: a stuck-PTT hold must not grow memory without
    // limit. Past the cap we drop audio and flag it so stop() refuses
    // the upload — a silently-truncated recording transcribes into
    // hallucinated text, worse than an honest "too long".
    if (this.bufferedBytes + pcm16Buffer.length > MAX_PCM_BYTES) {
      if (!this.overflowed) {
        this.overflowed = true;
        console.warn(`[Zapi] recording exceeded ~30s cap — audio is being dropped`);
      }
      return;
    }
    this.audioChunks.push(pcm16Buffer);
    this.bufferedBytes += pcm16Buffer.length;
  }

  async stop(): Promise<TranscriptionResult> {
    const pcmData = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.bufferedBytes = 0;
    if (this.overflowed) {
      this.overflowed = false;
      throw new Error('that recording ran past ~30 seconds — keep it shorter');
    }
    return this.transcribe(pcmData);
  }

  async transcribe(pcmData: Buffer): Promise<TranscriptionResult> {
    // Sub-150ms utterances are accidental taps: 16000 Hz × 2 bytes ×
    // 0.15s = 4800 bytes minimum. Groq rejects tiny files anyway, and
    // the caller treats empty text as "no speech" — a clean no-op
    // instead of a wasted round-trip.
    if (pcmData.length < 4800) {
      return { text: '', isFinal: true };
    }
    // The VAD path (transcribeWith) bypasses sendAudio's cap — refuse
    // over-long buffers here too rather than uploading an unbounded blob.
    if (pcmData.length > MAX_PCM_BYTES) {
      throw new Error('that recording ran past ~30 seconds — keep it shorter');
    }

    const wavBuffer = buildWav(pcmData, 16000, 1, 16);

    const model = settingsStore.get('groqTranscriptionModel');

    const formData = new FormData();
    const arrayBuf = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
    formData.append('file', new Blob([arrayBuf], { type: 'audio/wav' }), 'recording.wav');
    formData.append('model', model);
    // English-only locks Whisper out of language detection (which is the
    // single biggest source of garbled output on short voice clips). If
    // we ever want multilingual, lift this from the user's locale.
    formData.append('language', 'en');
    // Temperature 0 = deterministic decoding. Higher temps invent words
    // when the audio is unclear; for short commands we want fewer halluc-
    // inations, even if it means cutting an unintelligible word.
    formData.append('temperature', '0');
    // The "prompt" biases the model's vocab. Loading it with the kind
    // of words a user actually says to a screen-aware assistant fixes a
    // lot of the weirdness — proper-noun apps ("Slack", "Notion"),
    // pointing verbs ("click", "highlight"), and generic UI nouns get
    // far higher prior probability and stop being mis-transcribed as
    // homophones (e.g. "click" → "clique"). Whisper accepts up to 224
    // tokens here; keep it short and dense.
    formData.append(
      'prompt',
      "Zapi, agent, click, tap, open, close, switch, highlight, select, search, paste, file, folder, window, tab, button, link, screen, cursor, Slack, Chrome, Notion, VS Code, Figma, Gmail.",
    );

    let res: Response;
    try {
      res = await postWithRetry(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        formData,
        getApiKey('groq') ?? '',
        'groq',
      );
      if (!res.ok) throw transcriptionError(res.status, 'groq', await res.text());
    } catch (err) {
      stashFailedUtterance(wavBuffer, 'groq', err);
      throw err;
    }
    const result = (await res.json()) as { text?: unknown };

    // Providers can legally answer {"text": null} — always a string out.
    const text = typeof result.text === 'string' ? result.text : '';
    return { text, isFinal: true };
  }
}

// ── OpenAI Whisper Provider (upload-based fallback) ────────────────────

export class OpenAIWhisperProvider implements TranscriptionProvider {
  private audioChunks: Buffer[] = [];
  private bufferedBytes = 0;
  private overflowed = false;

  async start(): Promise<void> {
    const apiKey = getApiKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured. Add it in the Zapi panel.');
    this.audioChunks = [];
    this.bufferedBytes = 0;
    this.overflowed = false;
  }

  sendAudio(pcm16Buffer: Buffer): void {
    if (this.bufferedBytes + pcm16Buffer.length > MAX_PCM_BYTES) {
      if (!this.overflowed) {
        this.overflowed = true;
        console.warn(`[Zapi] recording exceeded ~30s cap — audio is being dropped`);
      }
      return;
    }
    this.audioChunks.push(pcm16Buffer);
    this.bufferedBytes += pcm16Buffer.length;
  }

  async stop(): Promise<TranscriptionResult> {
    // Build WAV from accumulated PCM16 chunks
    const pcmData = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.bufferedBytes = 0;
    if (this.overflowed) {
      this.overflowed = false;
      throw new Error('that recording ran past ~30 seconds — keep it shorter');
    }
    return this.transcribe(pcmData);
  }

  async transcribe(pcmData: Buffer): Promise<TranscriptionResult> {
    // Same sub-150ms guard as the Groq path — a degenerate VAD/PTT
    // utterance isn't worth an API round-trip or a 400.
    if (pcmData.length < 4800) {
      return { text: '', isFinal: true };
    }
    if (pcmData.length > MAX_PCM_BYTES) {
      throw new Error('that recording ran past ~30 seconds — keep it shorter');
    }

    const wavBuffer = buildWav(pcmData, 16000, 1, 16);

    const formData = new FormData();
    const arrayBuf = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
    formData.append('file', new Blob([arrayBuf], { type: 'audio/wav' }), 'recording.wav');
    formData.append('model', 'gpt-4o-transcribe');

    // The whisper endpoint hangs off the same base URL the chat path
    // uses — a ClinePass/proxy user transcriptions where their key lives.
    const base = settingsStore.get('openAIBaseUrl').trim();
    const url = base
      ? `${normalizeBase(base)}/v1/audio/transcriptions`
      : 'https://api.openai.com/v1/audio/transcriptions';
    let res: Response;
    try {
      res = await postWithRetry(
        url,
        formData,
        getApiKey('openai') ?? '',
        'openai',
      );
      if (!res.ok) {
        const err = transcriptionError(res.status, 'openai', await res.text());
        // Chat-capable proxies (ClinePass) routinely lack the Whisper
        // route — 404/405/411 with a custom base almost always means
        // that, so name the fix instead of leaving a bare HTTP error.
        if (base && (res.status === 404 || res.status === 405 || res.status === 411)) {
          throw new Error(`${err.message} (this endpoint may not support Whisper; pick Groq in Ear tab)`);
        }
        throw err;
      }
    } catch (err) {
      stashFailedUtterance(wavBuffer, 'openai', err);
      throw err;
    }
    const result = (await res.json()) as { text?: unknown };

    const text = typeof result.text === 'string' ? result.text : '';
    return { text, isFinal: true };
  }
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTranscriptionProvider(
  type: TranscriptionProviderType,
): TranscriptionProvider {
  switch (type) {
    case 'groq':
      return new GroqWhisperProvider();
    case 'openai':
      return new OpenAIWhisperProvider();
    case 'native':
    default:
      // Fall back to Groq for unknown/legacy provider values (e.g. 'assemblyai').
      return new GroqWhisperProvider();
  }
}

/**
 * One-shot transcription for callers that already hold a finished PCM
 * buffer (always-on VAD utterances). Builds a fresh provider per call —
 * providers are stateless beyond their chunk buffer, so there's nothing
 * to reuse between utterances.
 */
export async function transcribeWith(
  provider: TranscriptionProviderType,
  pcm: Buffer,
): Promise<TranscriptionResult> {
  const p = createTranscriptionProvider(provider);
  await p.start();
  // VAD utterances arrive over IPC as Uint8Array — Buffer.from handles
  // Uint8Array/ArrayBuffer/number[]; providers call .copy() on the pcm.
  return p.transcribe(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm));
}

// ── WAV Builder ────────────────────────────────────────────────────────

function buildWav(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(headerSize - 8 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, headerSize);

  return buffer;
}
