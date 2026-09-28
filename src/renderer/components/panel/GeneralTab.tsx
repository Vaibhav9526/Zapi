import { useState } from 'react';
import type { FlickySettings, MemoryStats } from '../../../shared/types';
import {
  HOTKEY_DEFS,
  HOTKEY_DEFAULTS,
  OS_RESERVED_ACCELERATORS,
  acceleratorsEqual,
  normalizeAccelerator,
  type HotkeyDef,
  type HotkeyId,
} from '../../../shared/hotkeys';
import { ShortcutCapture } from './ShortcutCapture';

interface GeneralTabProps {
  settings: FlickySettings;
  memory: MemoryStats | null;
}

/** Settings field carrying each hotkey's accelerator. */
const HOTKEY_FIELDS: Record<
  HotkeyId,
  'pushToTalkShortcut' | 'dictationShortcut' | 'agentPttShortcut' | 'abortShortcut'
> = {
  ptt: 'pushToTalkShortcut',
  dictation: 'dictationShortcut',
  agent: 'agentPttShortcut',
  abort: 'abortShortcut',
};

/** One setter per binding — main re-registers the hotkey on each send. */
const HOTKEY_SETTERS: Record<HotkeyId, (accel: string) => void> = {
  ptt: (a) => window.flicky.setPushToTalkShortcut(a),
  dictation: (a) => window.flicky.setDictationShortcut(a),
  agent: (a) => window.flicky.setAgentPttShortcut(a),
  abort: (a) => window.flicky.setAbortShortcut(a),
};

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatRelative(ts: number | null): string {
  if (!ts) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Small numeric field for "Max agent steps". Keeps a local draft while
 * typing (clamping mid-keystroke makes "30" unreachable — typing "3" would
 * pin to 3), then commits clamped on blur or Enter; Escape reverts.
 */
function StepsInput({ value, disabled }: { value: number; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) {
      window.flicky.setAgentMaxSteps(Math.min(30, Math.max(3, n)));
    }
    setDraft(null);
  };
  return (
    <input
      className="num-input"
      type="number"
      min={3}
      max={30}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value);
        else if (e.key === 'Escape') setDraft(null);
      }}
      aria-label="Max agent steps"
    />
  );
}

export function GeneralTab({ settings, memory }: GeneralTabProps) {
  // Which hotkey row is mid-capture, and why its last Save was refused.
  const [editingHotkey, setEditingHotkey] = useState<HotkeyId | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactStatus, setCompactStatus] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const onCompact = async () => {
    setIsCompacting(true);
    setCompactStatus(null);
    try {
      const res = await window.flicky.compactContext();
      if (res.ok) {
        setCompactStatus({ kind: 'success', message: 'Compacted.' });
      } else {
        setCompactStatus({ kind: 'error', message: res.error ?? 'Compaction failed.' });
      }
    } catch (err) {
      setCompactStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Compaction failed.',
      });
    } finally {
      setIsCompacting(false);
      setTimeout(() => setCompactStatus(null), 4000);
    }
  };

  const tokens = memory?.tokens ?? 0;
  const budget = memory?.tokenBudget ?? 250_000;
  const pct = Math.min(100, (tokens / budget) * 100);
  const healthLabel = pct < 60 ? 'healthy' : pct < 85 ? 'getting full' : 'near cap';
  const healthColor =
    pct < 60 ? 'var(--fl-ok)' : pct < 85 ? 'var(--fl-warn)' : 'var(--fl-danger)';

  const isMac = window.flicky.platform === 'darwin';

  const bindingFor = (id: HotkeyId): string => settings[HOTKEY_FIELDS[id]];
  const setBinding = (id: HotkeyId, accel: string) => HOTKEY_SETTERS[id](accel);

  // Stored-vs-stored collisions surface on every affected row — same
  // canonical comparison the main side uses before registering.
  const conflictFor = (id: HotkeyId): HotkeyDef | null =>
    HOTKEY_DEFS.find((d) => d.id !== id && acceleratorsEqual(bindingFor(id), bindingFor(d.id))) ??
    null;

  // A captured combo is vetted here before it ever reaches IPC: Windows
  // claims the OS-reserved chords at the shell level, and a binding that
  // shadows another command would register while breaking that command.
  // Refusals stay inline so the capture box keeps listening.
  const saveHotkey = (id: HotkeyId, accel: string) => {
    if (OS_RESERVED_ACCELERATORS.has(normalizeAccelerator(accel))) {
      setCaptureError('Windows owns this combo');
      return;
    }
    const clash = HOTKEY_DEFS.find(
      (d) => d.id !== id && acceleratorsEqual(accel, bindingFor(d.id)),
    );
    if (clash) {
      setCaptureError(`conflicts with ${clash.label}`);
      return;
    }
    setBinding(id, accel);
    setCaptureError(null);
    setEditingHotkey(null);
  };

  const resetAllHotkeys = () => {
    for (const def of HOTKEY_DEFS) setBinding(def.id, HOTKEY_DEFAULTS[def.id]);
  };

  return (
    <>
      <h1 className="main-h1">
        General<em>.</em>
      </h1>
      <p className="main-lead">Shortcuts, memory, and the companion cursor.</p>

      <div className="section">
        <div className="section-title hk-head">
          Keyboard shortcuts
          <button
            className="btn xs subtle"
            onClick={resetAllHotkeys}
            title="Restore every binding to its default"
          >
            Reset all to defaults
          </button>
        </div>
        {HOTKEY_DEFS.map((def) => {
          const current = bindingFor(def.id);
          const isBound = normalizeAccelerator(current) !== '';
          const clash = conflictFor(def.id);
          return editingHotkey === def.id ? (
            <div className="row" key={def.id}>
              <div className="row-main">
                <div className="row-t">{def.label}</div>
                <div className="row-s">{def.description}</div>
                {captureError && <div className="row-warn">{captureError}</div>}
              </div>
              <ShortcutCapture
                onSave={(accel) => saveHotkey(def.id, accel)}
                onCancel={() => {
                  setEditingHotkey(null);
                  setCaptureError(null);
                }}
              />
            </div>
          ) : (
            <div className="row" key={def.id}>
              <div className="row-main">
                <div className="row-t">{def.label}</div>
                <div className="row-s">{def.description}</div>
                {clash && <div className="row-warn">conflicts with {clash.label}</div>}
                {!isBound && (
                  <div className="row-warn">not bound — this shortcut won&apos;t fire</div>
                )}
              </div>
              <div className="shortcut-edit">
                <div className="keys">
                  {isBound ? (
                    current
                      .split('+')
                      .filter(Boolean)
                      .map((k, i) => <kbd key={`${k}-${i}`}>{k}</kbd>)
                  ) : (
                    <span className="hk-unset">not set</span>
                  )}
                </div>
                <button
                  className="hk-btn"
                  onClick={() => {
                    setCaptureError(null);
                    setEditingHotkey(def.id);
                  }}
                  title="Record a new combo"
                >
                  record
                </button>
                <button
                  className="hk-btn"
                  onClick={() => setBinding(def.id, HOTKEY_DEFAULTS[def.id])}
                  disabled={acceleratorsEqual(current, HOTKEY_DEFAULTS[def.id])}
                  title={`Reset to ${HOTKEY_DEFAULTS[def.id]}`}
                >
                  default
                </button>
                <button
                  className="hk-btn danger"
                  onClick={() => setBinding(def.id, '')}
                  disabled={!isBound}
                  title="Unbind this shortcut"
                >
                  clear
                </button>
              </div>
            </div>
          );
        })}
        <div className="row" style={{ borderBottom: 'none' }}>
          <div className="row-main">
            <div className="row-t">Push-to-talk style</div>
            <div className="row-s">
              {isMac
                ? 'macOS only supports tap-toggle — Electron can’t see the key release for hold-to-talk.'
                : settings.pttMode === 'toggle'
                  ? 'tap once to start, tap again to stop'
                  : 'hold to speak, release to send'}
            </div>
          </div>
          <div className="ptt-mode-seg" role="tablist" aria-label="Push-to-talk mode">
            <button
              role="tab"
              aria-selected={settings.pttMode === 'hold'}
              className={`seg ${settings.pttMode === 'hold' ? 'on' : ''}`}
              disabled={isMac}
              title={isMac ? 'Not supported on macOS' : ''}
              onClick={() => window.flicky.setPttMode('hold')}
            >
              Hold
            </button>
            <button
              role="tab"
              aria-selected={settings.pttMode === 'toggle'}
              className={`seg ${settings.pttMode === 'toggle' ? 'on' : ''}`}
              onClick={() => window.flicky.setPttMode('toggle')}
            >
              Toggle
            </button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title" style={{ marginBottom: 4 }}>Modes</div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Always-on listening</div>
            <div className="row-s">listens continuously — no hotkey needed</div>
          </div>
          <button
            className={`toggle ${settings.alwaysOnEnabled ? 'on' : ''}`}
            onClick={() => window.flicky.setAlwaysOn(!settings.alwaysOnEnabled)}
            aria-label="Toggle always-on listening"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Dictation mode</div>
            <div className="row-s">types what you say into the focused field instead of answering</div>
          </div>
          <button
            className={`toggle ${settings.dictationEnabled ? 'on' : ''}`}
            onClick={() => window.flicky.setDictation(!settings.dictationEnabled)}
            aria-label="Toggle dictation mode"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Agent mode</div>
            <div className="row-s">zapi agent … takes over mouse + keyboard</div>
          </div>
          <button
            className={`toggle ${settings.agentEnabled ? 'on' : ''}`}
            onClick={() => window.flicky.setAgentEnabled(!settings.agentEnabled)}
            aria-label="Toggle agent mode"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Max agent steps</div>
            <div className="row-s">hard stop for one agent run — 3 to 30 screenshot → act loops</div>
          </div>
          <StepsInput value={settings.agentMaxSteps} disabled={!settings.agentEnabled} />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Control backend</div>
            <div className="row-s">
              cua drives apps in the background so your mouse stays yours; falls back to
              real-cursor mode automatically when unavailable
            </div>
          </div>
          <div className="ptt-mode-seg" role="tablist" aria-label="Agent control backend">
            <button
              role="tab"
              aria-selected={settings.agentDriver === 'cua'}
              className={`seg ${settings.agentDriver === 'cua' ? 'on' : ''}`}
              disabled={!settings.agentEnabled}
              title="Drive apps in the background — your cursor stays free"
              onClick={() => window.flicky.setAgentDriver('cua')}
            >
              Background (keeps your cursor)
            </button>
            <button
              role="tab"
              aria-selected={settings.agentDriver === 'nutjs'}
              className={`seg ${settings.agentDriver === 'nutjs' ? 'on' : ''}`}
              disabled={!settings.agentEnabled}
              title="Drive the real mouse and keyboard"
              onClick={() => window.flicky.setAgentDriver('nutjs')}
            >
              Real cursor
            </button>
          </div>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Mute routine announcements</div>
            <div className="row-s">routines still run on schedule — completions stay silent (no voice/overlay)</div>
          </div>
          <button
            className={`toggle ${settings.routinesMuted ? 'on' : ''}`}
            onClick={() => window.flicky.setRoutinesMuted(!settings.routinesMuted)}
            aria-label="Toggle routine announcements"
          />
        </div>
      </div>

      <div className="section">
        <div className="section-title">Setup</div>
        <div className="row" style={{ borderBottom: 'none' }}>
          <div className="row-main">
            <div className="row-t">Replay onboarding</div>
            <div className="row-s">walk through setup again — keys and settings stay put</div>
          </div>
          {/* No reload needed: main flips onboardingComplete=false and emits
              settings, so PanelApp re-renders into <Onboarding> itself. */}
          <button className="btn" onClick={() => window.flicky.replayOnboarding()}>
            show onboarding again
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Memory</div>
        <p className="section-hint" style={{ margin: '6px 0 14px' }}>
          zapi auto-compacts older messages into a summary near the {formatTokens(budget)} cap so the
          conversation can run forever.
        </p>
        <div className="context-bar">
          <div className="context-meta">
            <span>
              <b>{formatTokens(tokens)}</b> / {formatTokens(budget)} tokens
            </span>
            <span style={{ color: healthColor }}>{healthLabel}</span>
          </div>
          <div className="bar"><div className="f" style={{ width: `${pct}%` }} /></div>
          <div className="context-footer">
            <span>
              {memory?.messageCount ?? 0} messages
              {memory?.summarizedCount ? ` · ${memory.summarizedCount} summarized` : ''}
            </span>
            <span>last compact {formatRelative(memory?.lastCompactedAt ?? null)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button className="btn xs" onClick={onCompact} disabled={isCompacting}>
            {isCompacting && <span className="spinner-sm" />}
            {isCompacting ? 'Compacting…' : 'Compact now'}
          </button>
          <button
            className="btn xs subtle"
            onClick={() => window.flicky.clearContext()}
            disabled={isCompacting}
          >
            Clear memory
          </button>
          {compactStatus && (
            <span
              className={`compact-status ${compactStatus.kind}`}
              title={compactStatus.message}
            >
              {compactStatus.message}
            </span>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title" style={{ marginBottom: 4 }}>Companion</div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Show cursor</div>
            <div className="row-s">blue pointer that flies to things zapi mentions</div>
          </div>
          <button
            className={`toggle ${settings.isClickyCursorEnabled ? 'on' : ''}`}
            onClick={() => window.flicky.toggleCursor(!settings.isClickyCursorEnabled)}
            aria-label="Toggle cursor"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Allow zapi to type for you</div>
            <div className="row-s">
              when off (default), zapi copies text to your clipboard and you press paste.
              when on, zapi types directly into the focused field
              {isMac && <> — requires <strong>Accessibility</strong> permission on macOS</>}.
            </div>
          </div>
          <button
            className={`toggle ${settings.autoTypeEnabled ? 'on' : ''}`}
            onClick={() => window.flicky.setAutoTypeEnabled(!settings.autoTypeEnabled)}
            aria-label="Toggle auto-typing"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Launch at login</div>
            <div className="row-s">open zapi when you sign in</div>
          </div>
          <button
            className={`toggle ${settings.launchAtLogin ? 'on' : ''}`}
            onClick={() => window.flicky.setLaunchAtLogin(!settings.launchAtLogin)}
            aria-label="Toggle launch at login"
          />
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Setup</div>
            <div className="row-s">re-check permissions, keys, the shortcut and your mic step by step</div>
          </div>
          <button className="btn xs" onClick={() => window.flicky.replayOnboarding()}>
            Run setup again
          </button>
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-t">Stream window</div>
            <div className="row-s">floating transparent panel that shows the live Q/A — scroll, select, copy</div>
          </div>
          <div className="seg">
            {(['off', 'responses', 'always'] as const).map((v) => (
              <button
                key={v}
                className={settings.streamVisibility === v ? 'on' : ''}
                onClick={() => window.flicky.setStreamVisibility(v)}
              >
                {v === 'responses' ? 'while replying' : v}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
