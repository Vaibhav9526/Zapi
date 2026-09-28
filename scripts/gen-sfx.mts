/**
 * Generate the overlay's UI chimes — pure node, no deps. Each sound is a
 * small stack of sine voices with a fast attack + exponential decay
 * (struck-bell shape), rendered to 16-bit PCM mono 44.1kHz WAV.
 *
 * Output: src/renderer/assets/sfx/{agent-launch,agent-done,agent-needs-you,heard}.wav
 * — inside the vite root so the renderer bundles them via
 * `new URL('../assets/sfx/x.wav', import.meta.url)` and the packaged app
 * resolves them like any other emitted asset.
 *
 * The names are the IPC.PLAY_SFX contract — main emits 'agent-launch',
 * 'agent-done', 'agent-needs-you', 'heard'; keep filenames in sync.
 *
 * Run:  bun scripts/gen-sfx.mts  (or: npx tsx scripts/gen-sfx.mts)
 * Re-running is idempotent — deterministic synth, same bytes out.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'sfx');

const RATE = 44100;

/** One decaying sine voice. `start`/`decay`/`attack` in seconds. */
interface Voice {
  freq: number;
  start: number;
  decay: number;
  gain: number;
  /** Optional 2nd-harmonic partial for warmth (0 = pure sine). */
  sparkle?: number;
  /** Slight detune chorus: a twin at ±this many cents. */
  detuneCents?: number;
}

/** A whole sound: voices mixed, then normalized to `peak` (0..1). */
interface Sound {
  seconds: number;
  peak: number;
  voices: Voice[];
}

// Fast attack prevents the onset click; exponential decay keeps the tail
// smooth. Sparkle + detune partials give the chimes body without noise.
function renderVoice(v: Voice, out: Float32Array): void {
  const attack = 0.006;
  const detune = v.detuneCents ? Math.pow(2, v.detuneCents / 1200) : 0;
  const start = Math.floor(v.start * RATE);
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / RATE;
    const env = (1 - Math.exp(-t / attack)) * Math.exp(-t / v.decay);
    let s = Math.sin(2 * Math.PI * v.freq * t);
    if (v.sparkle) s += v.sparkle * Math.sin(4 * Math.PI * v.freq * t);
    if (detune) s += 0.35 * Math.sin(2 * Math.PI * v.freq * detune * t);
    out[i] += s * env * v.gain;
  }
}

function render(sound: Sound): Int16Array {
  const raw = new Float32Array(Math.ceil(sound.seconds * RATE));
  for (const v of sound.voices) renderVoice(v, raw);
  let peak = 0;
  for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]));
  const scale = peak > 0 ? sound.peak / peak : 0;
  const pcm = new Int16Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(raw[i] * scale * 32767)));
  }
  return pcm;
}

function wavBuffer(pcm: Int16Array): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

// ── The four chimes ─────────────────────────────────────────────────────
// Frequencies pulled from the A-major-ish pentatonic area so consecutive
// sounds never clash; nothing exceeds ~1.3kHz fundamental so they read as
// chimes, not beeps.

const SOUNDS: Record<string, Sound> = {
  // Ascending perfect-fifth lift (E5 → B5) — "an agent has entered".
  'agent-launch': {
    seconds: 0.7,
    peak: 0.75,
    voices: [
      { freq: 659.26, start: 0.0, decay: 0.34, gain: 0.9, sparkle: 0.25 },
      { freq: 987.77, start: 0.16, decay: 0.4, gain: 0.8, sparkle: 0.25, detuneCents: 4 },
    ],
  },
  // Resolved major triad (E5 G#5 B5) struck together — "work landed".
  'agent-done': {
    seconds: 0.85,
    peak: 0.8,
    voices: [
      { freq: 659.26, start: 0.0, decay: 0.5, gain: 0.9, sparkle: 0.2, detuneCents: 3 },
      { freq: 830.61, start: 0.02, decay: 0.5, gain: 0.7, sparkle: 0.2 },
      { freq: 987.77, start: 0.04, decay: 0.55, gain: 0.8, sparkle: 0.25, detuneCents: 3 },
    ],
  },
  // Two soft pulses (B5) — "attention requested", urgent but not harsh.
  'agent-needs-you': {
    seconds: 0.6,
    peak: 0.7,
    voices: [
      { freq: 987.77, start: 0.0, decay: 0.11, gain: 0.85, sparkle: 0.15 },
      { freq: 987.77, start: 0.24, decay: 0.16, gain: 0.9, sparkle: 0.15 },
    ],
  },
  // Single high tick, quick decay — "heard you" without interrupting.
  heard: {
    seconds: 0.3,
    peak: 0.5,
    voices: [{ freq: 1318.51, start: 0.0, decay: 0.055, gain: 0.8, sparkle: 0.1 }],
  },
};

// ── Run ─────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
let fail = 0;
for (const [name, sound] of Object.entries(SOUNDS)) {
  const pcm = render(sound);
  const file = path.join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, wavBuffer(pcm));
  // Read back the header so a broken write fails loudly here, not in the
  // overlay at demo time.
  const back = readFileSync(file);
  const ok =
    back.length >= 44 &&
    back.toString('ascii', 0, 4) === 'RIFF' &&
    back.toString('ascii', 8, 12) === 'WAVE' &&
    back.readUInt16LE(34) === 16 &&
    back.readUInt32LE(24) === RATE &&
    back.readUInt32LE(40) === pcm.length * 2;
  if (ok) {
    console.log(`WROTE ${name}.wav — ${sound.seconds}s, ${pcm.length} samples, ${back.length}B`);
  } else {
    fail++;
    console.log(`FAIL  ${name}.wav — header/length mismatch`);
  }
}
console.log(fail ? `\n${fail} file(s) failed validation` : '\nAll chimes valid.');
process.exit(fail ? 1 : 0);
