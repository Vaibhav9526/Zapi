import { useState } from 'react';
import type { FlickySettings, FishTtsModel, TtsProvider } from '../../../shared/types';
import { VOICE_PRESETS } from '../../../shared/types';
import { ProviderKey } from './ProviderKey';
import { Slider } from './Slider';

interface VoiceTabProps {
  settings: FlickySettings;
}

const TTS_PROVIDERS: Array<{ id: TtsProvider; label: string }> = [
  { id: 'fishaudio', label: 'Fish Audio' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
];

/**
 * Fish Audio model header, in the same order as the main-process
 * FISH_TTS_MODELS list. The free tier leads because it is the one a $0
 * dev account can actually call — `s2.1-pro` returns 402 "insufficient
 * API credit" there, which reads as a broken key rather than a tier.
 */
const FISH_TTS_MODELS: FishTtsModel[] = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'];

/** `Record` over the union, so a new model without a label fails the build. */
const FISH_MODEL_LABELS: Record<FishTtsModel, string> = {
  's2.1-pro-free': 'free · s2.1-pro-free',
  's2.1-pro': 's2.1-pro',
  's2-pro': 's2-pro',
  s1: 's1',
};

const DEFAULT_FISH_MODEL: FishTtsModel = 's2.1-pro-free';

export function VoiceTab({ settings }: VoiceTabProps) {
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const selectedVoice = VOICE_PRESETS.find((v) => v.id === settings.voiceId) ?? VOICE_PRESETS[0];
  const isFish = settings.ttsProvider === 'fishaudio';
  // Main coerces the stored value on load, but default here too so a stale
  // settings payload can never leave every button unselected.
  const fishModel: FishTtsModel = settings.fishTtsModel ?? DEFAULT_FISH_MODEL;

  return (
    <>
      <h1 className="main-h1">
        Voice<em>.</em>
      </h1>
      <p className="main-lead">How zapi sounds. Pick a provider and a voice, tune speed and stability, or mute replies for silent mode.</p>

      <div className="section">
        <div className="section-title" style={{ marginBottom: 12 }}>Voice provider</div>
        <div className="seg">
          {TTS_PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={settings.ttsProvider === p.id ? 'on' : ''}
              onClick={() => window.flicky.setTtsProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <ProviderKey
          name={isFish ? 'fishaudio' : 'elevenlabs'}
          providerLabel={isFish ? 'Fish Audio' : 'ElevenLabs'}
          providerLogo={isFish ? 'F' : '11'}
          providerLogoClass={isFish ? 'fish' : 'eleven'}
          isSet={isFish ? settings.apiKeyStatus.fishaudio : settings.apiKeyStatus.elevenlabs}
          keyPlaceholder={isFish ? 'fish.audio api key' : 'xi-...'}
          hideProviderHeader
        />
        <p className="section-hint">Gives zapi a voice. Required to speak replies aloud.</p>
        <p className="section-hint">keys never leave this machine — stored in the OS credential store</p>
      </div>

      {isFish ? (
        <div className="section">
          <div className="section-title" style={{ marginBottom: 2 }}>Voice</div>
          <div className="label">
            Fish voice reference_id (from the fish.audio voice page URL, e.g. fish.audio/m/…)
          </div>
          <input
            className="text-input"
            type="text"
            value={settings.fishVoiceId}
            placeholder="reference_id — leave empty for default voice"
            onChange={(e) => window.flicky.setFishVoiceId(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="section-hint">paste the reference id, not the voice name</p>
          <div className="label" style={{ marginTop: 16 }}>Fish model</div>
          <div className="seg">
            {FISH_TTS_MODELS.map((m) => (
              <button
                key={m}
                className={fishModel === m ? 'on' : ''}
                onClick={() => window.flicky.setFishTtsModel(m)}
              >
                {FISH_MODEL_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="section-hint">
            free is the $0 dev tier; the paid models need Fish API credit
          </p>
        </div>
      ) : (
        <div className="section">
          <div className="section-title" style={{ marginBottom: 14 }}>Voice</div>
          <div className="vpreview">
            <button
              className="play-btn"
              onClick={() => window.flicky.playVoicePreview(settings.voiceId)}
              aria-label="Preview voice"
            >
              ▶
            </button>
            <div className="vpreview-meta">
              <div className="vpreview-name">{selectedVoice.name}</div>
              <div className="vpreview-sub">{selectedVoice.description}</div>
            </div>
            <button className="btn xs" onClick={() => setVoicePickerOpen((x) => !x)}>
              {voicePickerOpen ? 'Close' : 'Change'}
            </button>
          </div>

          {voicePickerOpen && (
            <div className="voice-list">
              {VOICE_PRESETS.map((v) => (
                <button
                  key={v.id}
                  className={`voice-item ${v.id === settings.voiceId ? 'on' : ''}`}
                  onClick={() => {
                    window.flicky.setVoiceId(v.id);
                    setVoicePickerOpen(false);
                  }}
                >
                  <div className="nm">{v.name}</div>
                  <div className="sub">{v.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="section">
        {!isFish && (
          <>
            <div className="row">
              <div className="row-main">
                <div className="row-t">Speed</div>
                <div className="row-s">how fast zapi speaks</div>
              </div>
              <div style={{ width: 220 }}>
                <Slider
                  value={settings.voiceSpeed}
                  min={0.7}
                  max={1.2}
                  step={0.05}
                  format={(v) => `${v.toFixed(2)}×`}
                  onChange={(v) => window.flicky.setVoiceSpeed(v)}
                />
              </div>
            </div>
            <div className="row">
              <div className="row-main">
                <div className="row-t">Stability</div>
                <div className="row-s">lower = more expressive, higher = more consistent</div>
              </div>
              <div style={{ width: 220 }}>
                <Slider
                  value={settings.voiceStability}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => window.flicky.setVoiceStability(v)}
                />
              </div>
            </div>
          </>
        )}
        <div className="row">
          <div className="row-main">
            <div className="row-t">Speak replies aloud</div>
            <div className="row-s">auto-play voice response after each answer</div>
          </div>
          <button
            className={`toggle ${settings.speakReplies ? 'on' : ''}`}
            onClick={() => window.flicky.setSpeakReplies(!settings.speakReplies)}
            aria-label="Toggle speak replies"
          />
        </div>
      </div>
    </>
  );
}
