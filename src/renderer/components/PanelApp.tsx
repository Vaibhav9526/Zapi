import { useState, useEffect } from 'react';
import type { VoiceState, FlickySettings, MemoryStats } from '../../shared/types';
import { HomeTab } from './panel/HomeTab';
import { ChatsTab } from './panel/ChatsTab';
import { MindTab } from './panel/MindTab';
import { VoiceTab } from './panel/VoiceTab';
import { EarTab } from './panel/EarTab';
import { GeneralTab } from './panel/GeneralTab';
import { PermissionsBanner } from './panel/PermissionsBanner';
import { Onboarding } from './panel/Onboarding';
import { CursorIcon } from './CursorIcon';

type Tab = 'home' | 'chats' | 'mind' | 'voice' | 'ear' | 'general';

export function PanelApp() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [settings, setSettings] = useState<FlickySettings | null>(null);
  const [memory, setMemory] = useState<MemoryStats | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [version, setVersion] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);
  // Lifted so HomeTab's agent cards can deep-link into a filtered Chats view.
  const [chatAgentFilter, setChatAgentFilter] = useState<string | null>(null);

  useEffect(() => {
    window.flicky.getSettings().then(setSettings);
    window.flicky.getMemoryStats().then(setMemory);
    window.flicky.getAppVersion().then(setVersion).catch(() => {});

    let errTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubs = [
      window.flicky.onVoiceStateChanged(setVoiceState),
      window.flicky.onSettingsChanged(setSettings),
      window.flicky.onMemoryStats(setMemory),
      // Turn failures used to vanish into the main-process console. Show
      // them in a dismissable strip so "nothing happened" becomes "here's
      // why nothing happened".
      window.flicky.onAiError((m) => {
        setLastError(m);
        if (errTimer) clearTimeout(errTimer);
        errTimer = setTimeout(() => setLastError(null), 12_000);
      }),
    ];
    return () => {
      unsubs.forEach((u) => u());
      if (errTimer) clearTimeout(errTimer);
    };
  }, []);

  if (!settings) return null;

  if (!settings.onboardingComplete) {
    return <Onboarding settings={settings} voiceState={voiceState} />;
  }

  const { apiKeyStatus } = settings;
  const mindNeeds =
    settings.mindProvider === 'openai'
      ? !apiKeyStatus.openai
      : !apiKeyStatus.anthropic;

  const navItem = (
    id: Tab,
    label: string,
    opts: { needs?: boolean } = {},
  ) => (
    <button
      className={`nav-item ${tab === id ? 'on' : ''}`}
      onClick={() => setTab(id)}
    >
      <span className={`dot ${opts.needs ? 'warn' : ''}`} />
      <span className="label">{label}</span>
    </button>
  );

  return (
    <div className="panel-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <CursorIcon size={34} />
          </div>
          <div className="sidebar-title">Zapi</div>
        </div>

        <nav className="nav">
          {navItem('home', 'Home')}
          {navItem('chats', 'Chats')}

          <div className="nav-label">Providers</div>
          {navItem('mind', 'Mind', { needs: mindNeeds })}
          {navItem('voice', 'Voice', {
            needs:
              settings.speakReplies &&
              !(settings.ttsProvider === 'fishaudio' ? apiKeyStatus.fishaudio : apiKeyStatus.elevenlabs),
          })}
          {navItem('ear', 'Ear', { needs: !apiKeyStatus.groq })}

          <div className="nav-label">System</div>
          {navItem('general', 'General')}
        </nav>

        <div className="sidebar-foot">
          <button className="nav-item quit" onClick={() => window.flicky.quit()}>
            <span className="label">Quit</span>
          </button>
          <div className="sidebar-version">
            {version ? `ZAPI v${version} · windows build` : 'ZAPI · windows build'}
          </div>
        </div>
      </aside>

      <main className="main">
        <PermissionsBanner />
        {lastError && (
          <div className="error-strip" role="alert">
            <span className="error-strip-text">{lastError}</span>
            <button className="error-strip-close" onClick={() => setLastError(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        {!settings.encryptionAvailable && (
          <div className="perm-banner">
            <div className="perm-banner-head">
              <span className="perm-banner-title">API keys are not encrypted</span>
              <span className="perm-banner-sub">
                OS secure storage is unavailable on this system. Keys are not encrypted and are
                readable by anything that can read the file.
              </span>
            </div>
          </div>
        )}
        {tab === 'home' && (
          <HomeTab
            voiceState={voiceState}
            settings={settings}
            memory={memory}
            onNavigate={(t) => setTab(t)}
            onOpenAgentChat={(id) => {
              setChatAgentFilter(id);
              setTab('chats');
            }}
          />
        )}
        {/* key remounts the wrapper on tab switch so the tabPanelIn
            transition replays — pure presentation, no behavior change. */}
        <div className="tab-panel" key={tab}>
          {tab === 'chats' && (
            <ChatsTab
              agents={settings.agents ?? []}
              agentFilter={chatAgentFilter}
              onAgentFilter={setChatAgentFilter}
              mindReady={!mindNeeds}
            />
          )}
          {tab === 'mind' && <MindTab settings={settings} />}
          {tab === 'voice' && <VoiceTab settings={settings} />}
          {tab === 'ear' && <EarTab settings={settings} />}
          {tab === 'general' && <GeneralTab settings={settings} memory={memory} />}
        </div>
      </main>
    </div>
  );
}
