import { getApiKey } from './key-store';
import * as settingsStore from './settings-store';
import { coerceFishTtsModel, getFishTtsModel } from './settings-store';
import type { FishTtsModel } from '../../shared/types';

const FISH_AUDIO_API_URL = 'https://api.fish.audio/v1/tts';

export interface FishTtsOptions {
  /** Fish Audio voice model id (reference_id). '' → provider default. */
  voiceId: string;
  /** Playback speed multiplier (provider accepts ~0.5–2.0). Default 1.0. */
  speed?: number;
  /**
   * Override the model header (the voice picker's "try a different
   * model" preview). Omitted in normal turns, which use the setting.
   */
  model?: FishTtsModel;
}

/**
 * Build the request headers. The model travels as a HEADER, not a body
 * field, per Fish Audio's OpenAPI spec — putting it in the body is
 * silently ignored and the account's default (a paid tier) 402s on a
 * $0 dev key with "insufficient API credit".
 */
function buildHeaders(apiKey: string, model: FishTtsModel): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    model,
  };
}

/**
 * Fish Audio Text-to-Speech client.
 * Keys are stored locally via Electron safeStorage.
 */
export class FishAudioTTS {
  async synthesize(text: string, options: FishTtsOptions): Promise<Buffer> {
    const apiKey = getApiKey('fishaudio');
    if (!apiKey) {
      throw new Error('Fish Audio API key not configured. Add it in the Zapi panel.');
    }
    // Coerced on the way out: an unknown value in the settings file must
    // not become an opaque 4xx from the provider. Free tier by default.
    const model = options.model
      ? coerceFishTtsModel(options.model)
      : getFishTtsModel();

    // One retry on 429/5xx (or a network blip) with ~800ms backoff —
    // same policy as the transcription providers.
    let response: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(FISH_AUDIO_API_URL, {
          method: 'POST',
          headers: buildHeaders(apiKey, model),
          body: JSON.stringify({
            text,
            reference_id: options.voiceId || undefined,
            format: 'mp3',
            latency: 'normal',
            // voiceSpeed setting applies when the caller didn't pass one.
            speed: options.speed ?? settingsStore.get('voiceSpeed') ?? 1.0,
          }),
        });
        if (response.ok || attempt === 1 || (response.status !== 429 && response.status < 500)) {
          break;
        }
        lastErr = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastErr = err;
        if (attempt === 1) {
          throw new Error("can't reach fish audio — check your internet connection");
        }
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }

    if (!response) throw lastErr ?? new Error('fish audio request failed');
    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new Error('fish audio rejected your key — check it in the Zapi panel');
      }
      if (response.status === 429 || response.status >= 500) {
        throw new Error('fish audio is having trouble right now — try again in a moment');
      }
      // A 400 "Reference not found" with no voice configured is the one
      // 4xx we can actually explain: the request carried no
      // reference_id at all, so the panel's Voice tab is the fix. With a
      // voice set, the id is wrong or revoked and that is a different
      // conversation — so the hint is conditional on the empty case.
      const noVoice = !(options.voiceId || settingsStore.get('fishVoiceId'));
      if (
        response.status === 400 &&
        noVoice &&
        /reference not found/i.test(errText)
      ) {
        throw new Error(
          `fish audio: no voice reference_id set — paste a voice reference_id in the Voice tab (provider said: ${errText.slice(0, 120)})`,
        );
      }
      throw new Error(`Fish Audio TTS error ${response.status}: ${errText}`);
    }

    // A 200 with a JSON error payload has bitten us before — the SDK
    // returns audio bytes, so anything that isn't audio/* is not
    // playable and should fail loudly rather than hand static to the
    // speaker.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('audio/')) {
      const errText = await response.text();
      throw new Error(
        `fish audio returned ${contentType || 'unknown content-type'} instead of audio: ${errText.slice(0, 200)}`,
      );
    }

    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}
