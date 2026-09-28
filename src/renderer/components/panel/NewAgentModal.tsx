import { useState } from 'react';

const KAOMOJI_PRESETS = ['(•‿•)', '(◕‿◕)', '(≧◡≦)', '(¬‿¬)', '(ᵔᴥᵔ)', '(◣_◢)'];
const COLOR_PRESETS = ['#7b4dff', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

interface NewAgentModalProps {
  onClose: () => void;
}

/**
 * Small create-an-agent dialog: name (required), optional kaomoji face
 * (preset row or free text — free text wins when both are set), and a
 * color swatch used for accent dots on cards/badges.
 */
export function NewAgentModal({ onClose }: NewAgentModalProps) {
  const [name, setName] = useState('');
  const [presetKaomoji, setPresetKaomoji] = useState<string | null>(KAOMOJI_PRESETS[0]);
  const [customKaomoji, setCustomKaomoji] = useState('');
  const [color, setColor] = useState(COLOR_PRESETS[0]);

  const kaomoji = customKaomoji.trim() || presetKaomoji || undefined;
  const canCreate = name.trim().length > 0;

  const create = () => {
    if (!canCreate) return;
    window.flicky.createAgent({ name: name.trim(), kaomoji, color });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>New agent</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-field">
          <div className="modal-label">Name</div>
          <input
            autoFocus
            className="modal-input"
            placeholder="e.g. scout, reviewer, ops"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          />
        </div>

        <div className="modal-field">
          <div className="modal-label">Face (optional)</div>
          <div className="kao-presets">
            {KAOMOJI_PRESETS.map((k) => (
              <button
                key={k}
                className={`kao-btn ${!customKaomoji.trim() && presetKaomoji === k ? 'on' : ''}`}
                onClick={() => { setPresetKaomoji(k); setCustomKaomoji(''); }}
              >
                {k}
              </button>
            ))}
          </div>
          <input
            className="modal-input"
            placeholder="or type your own kaomoji…"
            value={customKaomoji}
            onChange={(e) => setCustomKaomoji(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="modal-field">
          <div className="modal-label">Color</div>
          <div className="swatch-row">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`color ${c}`}
              />
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn xs subtle" onClick={onClose}>Cancel</button>
            <button className="btn xs primary" onClick={create} disabled={!canCreate}>
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
