import { useEffect, useState } from 'react';
import type {
  FlickySettings,
  ClaudeModel,
  OpenAIModel,
  MindProvider,
  ReasoningDepth,
  ReplyTone,
} from '../../../shared/types';
import { ProviderKey } from './ProviderKey';

/**
 * Commit-on-blur field for the OpenAI base URL — draft locally so typing
 * doesn't fire a settings write per keystroke; Enter applies, Escape reverts.
 */
function BaseUrlInput({ value }: { value: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const v = raw.trim();
    if (v !== value) window.flicky.setOpenAIBaseUrl(v);
    setDraft(null);
  };
  return (
    <input
      className="text-input"
      type="text"
      value={draft ?? value}
      placeholder="https://api.openai.com (or your ClinePass endpoint)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(e.currentTarget.value);
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') setDraft(null);
      }}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

interface MindTabProps {
  settings: FlickySettings;
}

interface ModelEntry<M extends string> {
  id: M;
  name: string;
  sub: string;
  tag?: { label: string; cls: string };
}

const CLAUDE_MODELS: Array<ModelEntry<ClaudeModel>> = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    sub: 'fast · balanced · default',
    tag: { label: 'recommended', cls: 'info' },
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    sub: 'deepest reasoning · slower',
  },
];

const OPENAI_MODELS: Array<ModelEntry<OpenAIModel>> = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    sub: 'frontier reasoning · supports extended thinking',
    tag: { label: 'recommended', cls: 'info' },
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    sub: 'fast + cheap reasoning model',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    sub: 'multimodal · fast',
  },
];

export function MindTab({ settings }: MindTabProps) {
  const [providerOpen, setProviderOpen] = useState(false);

  const provider = settings.mindProvider;
  const isAnthropic = provider === 'anthropic';
  const isOpenAI = provider === 'openai';
  const setTone = (t: ReplyTone) => window.flicky.setReplyTone(t);
  const setDepth = (d: ReasoningDepth) => window.flicky.setReasoningDepth(d);

  const providerLabel = isAnthropic ? 'Anthropic' : 'ClinePass · OpenAI-compatible';
  const providerLogoText = isAnthropic ? 'A' : 'Ai';
  const providerLogoClass = isAnthropic ? '' : 'openai';

  // Model ids advertised by the configured endpoint (GET {base}/v1/models
  // in main). null = still fetching; [] = endpoint returned nothing →
  // fall back to the hardcoded picker with a heads-up line. Refetches
  // when the base URL or the key's presence flips.
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  useEffect(() => {
    if (!isOpenAI) return;
    let cancelled = false;
    setRemoteModels(null);
    window.flicky
      .listRemoteModels()
      .then((ids) => {
        if (!cancelled) setRemoteModels(ids ?? []);
      })
      .catch(() => {
        if (!cancelled) setRemoteModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpenAI, settings.openAIBaseUrl, settings.apiKeyStatus.openai]);

  // Endpoint-returned ids win over the static list. The cast is safe on
  // the wire — main forwards the selected id verbatim (provider/model ids
  // like 'openai/gpt-5' round-trip fine) — but keeps OpenAIModel's static
  // union for the hardcoded entries' type-checking.
  const openAiItems: Array<ModelEntry<OpenAIModel>> =
    remoteModels && remoteModels.length > 0
      ? remoteModels.map((id) => ({ id: id as OpenAIModel, name: id, sub: '' }))
      : OPENAI_MODELS;

  // Substring filter, case-insensitive. The current selection always
  // pins to the top — even when the endpoint dropped it or the filter
  // excludes it — so the active id never scrolls away.
  const mq = modelQuery.trim().toLowerCase();
  const selectedOpenAIItem: ModelEntry<OpenAIModel> | null = settings.selectedOpenAIModel
    ? (openAiItems.find((m) => m.id === settings.selectedOpenAIModel) ?? {
        id: settings.selectedOpenAIModel,
        name: settings.selectedOpenAIModel,
        sub: '',
      })
    : null;
  const visibleOpenAiItems = openAiItems.filter(
    (m) => m.id !== settings.selectedOpenAIModel && (!mq || m.id.toLowerCase().includes(mq)),
  );

  return (
    <>
      <h1 className="main-h1">
        Mind<em>.</em>
      </h1>
      <p className="main-lead">
        How zapi thinks — which provider, which model, how deep it reasons, and the tone of
        its replies.
      </p>

      <div className="section">
        <div className="section-title">Model provider</div>

        <div className="provider-header">
          <button
            type="button"
            className="provider-pick"
            onClick={() => setProviderOpen((x) => !x)}
          >
            <div className={`provider-logo ${providerLogoClass}`}>{providerLogoText}</div>
            <span>{providerLabel}</span>
            <span className="chev">▾</span>
          </button>
        </div>

        {providerOpen && (
          <div className="voice-list" style={{ marginTop: 8 }}>
            {(
              [
                { id: 'anthropic', label: 'Anthropic', sub: 'Claude Sonnet / Opus · built-in web search' },
                { id: 'openai', label: 'OpenAI-compatible', sub: 'ClinePass · OpenAI · any /v1 endpoint' },
              ] as Array<{ id: MindProvider; label: string; sub: string }>
            ).map((p) => (
              <button
                key={p.id}
                className={`voice-item ${provider === p.id ? 'on' : ''}`}
                onClick={() => {
                  window.flicky.setMindProvider(p.id);
                  setProviderOpen(false);
                }}
              >
                <div className="nm">{p.label}</div>
                <div className="sub">{p.sub}</div>
              </button>
            ))}
          </div>
        )}

        {isAnthropic && (
          <ProviderKey
            name="anthropic"
            providerLabel="Anthropic"
            providerLogo="A"
            isSet={settings.apiKeyStatus.anthropic}
            keyPlaceholder="sk-ant-..."
            hideProviderHeader
          />
        )}
        {isOpenAI && (
          <>
            <ProviderKey
              name="openai"
              providerLabel="ClinePass · OpenAI-compatible"
              providerLogo="Ai"
              providerLogoClass="openai"
              isSet={settings.apiKeyStatus.openai}
              keyPlaceholder="sk-... or clinepass key"
              hideProviderHeader
            />
            <div className="label">Base URL (optional)</div>
            <BaseUrlInput value={settings.openAIBaseUrl} />
            <p className="section-hint" style={{ marginTop: 8 }}>
              empty = api.openai.com · clinepass: https://api.cline.bot/api
            </p>
          </>
        )}
        <p className="section-hint">Powers the reasoning behind every answer.</p>
      </div>

      <>
        <div className="section">
          <div className="section-title" style={{ marginBottom: 14 }}>Model</div>
            {isAnthropic ? (
              <div className="model-list">
                {CLAUDE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    className={`model-item ${settings.selectedModel === m.id ? 'on' : ''}`}
                    onClick={() => window.flicky.setModel(m.id)}
                  >
                    <div className="model-radio" />
                    <div className="model-meta">
                      <div className="model-name">{m.name}</div>
                      <div className="model-sub">{m.sub}</div>
                    </div>
                    {m.tag && <div className={`model-tag ${m.tag.cls}`}>{m.tag.label}</div>}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <input
                  className="text-input model-search"
                  type="text"
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder={
                    remoteModels && remoteModels.length > 0
                      ? `search ${remoteModels.length} endpoint models…`
                      : 'search models…'
                  }
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Search OpenAI-compatible models"
                />
                {remoteModels !== null && remoteModels.length === 0 && (
                  <div className="model-list-note">
                    endpoint didn&apos;t return a list — showing built-in picks
                  </div>
                )}
                <div className="model-list model-scroll">
                  {selectedOpenAIItem && (
                    <button
                      className="model-item on"
                      onClick={() => window.flicky.setOpenAIModel(selectedOpenAIItem.id)}
                    >
                      <div className="model-radio" />
                      <div className="model-meta">
                        <div className="model-name">{selectedOpenAIItem.name}</div>
                        {selectedOpenAIItem.sub && (
                          <div className="model-sub">{selectedOpenAIItem.sub}</div>
                        )}
                      </div>
                      <div className="model-tag info">selected</div>
                    </button>
                  )}
                  {visibleOpenAiItems.map((m) => (
                    <button
                      key={m.id}
                      className="model-item"
                      onClick={() => window.flicky.setOpenAIModel(m.id)}
                    >
                      <div className="model-radio" />
                      <div className="model-meta">
                        <div className="model-name">{m.name}</div>
                        {m.sub && <div className="model-sub">{m.sub}</div>}
                      </div>
                      {m.tag && <div className={`model-tag ${m.tag.cls}`}>{m.tag.label}</div>}
                    </button>
                  ))}
                  {mq && visibleOpenAiItems.length === 0 && (
                    <div className="model-list-note">no models match &ldquo;{modelQuery}&rdquo;</div>
                  )}
                </div>
              </>
            )}
            {isOpenAI && (
              <>
                <div className="label">Custom model id (optional)</div>
                <input
                  className="text-input"
                  type="text"
                  value={settings.customOpenAIModel}
                  placeholder="e.g. gpt-6-luna"
                  onChange={(e) => window.flicky.setCustomOpenAIModel(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="section-hint">
                  overrides the picker — e.g. an OpenAI-compatible endpoint model like gpt-6-luna
                </p>
              </>
            )}
          </div>

          <div className="section">
            <div className="section-title" style={{ marginBottom: 6 }}>Reasoning depth</div>
            <p className="section-hint" style={{ margin: '0 0 14px' }}>
              How much zapi thinks before replying.
            </p>
            <div className="seg">
              <button
                className={settings.reasoningDepth === 'off' ? 'on' : ''}
                onClick={() => setDepth('off')}
              >
                Off
              </button>
              <button
                className={settings.reasoningDepth === 'medium' ? 'on' : ''}
                onClick={() => setDepth('medium')}
              >
                Medium
              </button>
              <button
                className={settings.reasoningDepth === 'deep' ? 'on' : ''}
                onClick={() => setDepth('deep')}
              >
                Deep
              </button>
            </div>
          </div>
      </>

      <div className="section">
        <div className="section-title" style={{ marginBottom: 14 }}>Reply tone</div>
        <div className="seg">
          <button
            className={settings.replyTone === 'concise' ? 'on' : ''}
            onClick={() => setTone('concise')}
          >
            Concise
          </button>
          <button
            className={settings.replyTone === 'friendly' ? 'on' : ''}
            onClick={() => setTone('friendly')}
          >
            Friendly
          </button>
          <button
            className={settings.replyTone === 'detailed' ? 'on' : ''}
            onClick={() => setTone('detailed')}
          >
            Detailed
          </button>
        </div>
      </div>
    </>
  );
}
