import { useEffect, useRef, useState } from 'react';
import type { AgentProfile, AgentStatus, Artifact, ChatEntry, FlickySettings, Routine, Scene, Suggestion, UsageStats, VoiceState, MemoryStats } from '../../../shared/types';
import { Waveform } from '../Waveform';
import { Tour } from './Tour';
import { NewAgentModal } from './NewAgentModal';
import { RoutineModal } from './RoutineModal';

interface HomeTabProps {
  voiceState: VoiceState;
  settings: FlickySettings;
  memory: MemoryStats | null;
  onNavigate: (tab: 'chats' | 'mind' | 'voice' | 'ear' | 'general') => void;
  /** Clicking an agent card jumps to Chats filtered to that agent. */
  onOpenAgentChat?: (agentId: string) => void;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function HomeTab({ voiceState, settings, memory, onNavigate, onOpenAgentChat }: HomeTabProps) {
  // Multi-agent: statuses keyed by agentId, latest action label the same.
  // AGENT_ACTION carries no agentId on the wire, so it's attributed to
  // whichever agent currently holds a thinking/acting phase.
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [lastActions, setLastActions] = useState<Record<string, string>>({});
  const statusesRef = useRef<Record<string, AgentStatus>>({});
  // Non-null while zapi is actively drawing scene cues on the overlay.
  const [scene, setScene] = useState<Scene | null>(null);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    const unsubAgent = window.flicky.onAgentStatus((s) => {
      statusesRef.current = { ...statusesRef.current, [s.agentId]: s };
      setStatuses(statusesRef.current);
      if (s.phase === 'idle') {
        setLastActions((m) => {
          if (!(s.agentId in m)) return m;
          const next = { ...m };
          delete next[s.agentId];
          return next;
        });
      }
    });
    const unsubAction = window.flicky.onAgentAction((a) => {
      const running = Object.values(statusesRef.current).find(
        (s) => s.phase === 'acting' || s.phase === 'thinking',
      );
      if (running) {
        setLastActions((m) => ({ ...m, [running.agentId]: a.label }));
      }
    });
    const unsubScene = window.flicky.onScene(setScene);
    return () => { unsubAgent(); unsubAction(); unsubScene(); };
  }, []);

  // Usage strip + per-agent last activity + unread dots + file piles —
  // refreshed whenever a turn lands in chat history. If a main-side
  // handler isn't wired yet the invoke rejects and we render nothing;
  // never surface an error here.
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [lastByAgent, setLastByAgent] = useState<Record<string, ChatEntry>>({});
  const [unreadByAgent, setUnreadByAgent] = useState<Record<string, boolean>>({});
  const [piles, setPiles] = useState<Record<string, Artifact[]>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sugBusy, setSugBusy] = useState(false);
  const sugTimers = useRef<number[]>([]);
  useEffect(() => {
    const loadUsage = () => {
      window.flicky.getUsageStats().then((s) => setUsage(s ?? null)).catch(() => {});
    };
    // One merged fetch feeds both "last activity" and "has unread" — the
    // entries are the same payload, so deriving twice would double IPC.
    const loadChats = () => {
      window.flicky
        .getChatHistory()
        .then((history) => {
          const map: Record<string, ChatEntry> = {};
          const unread: Record<string, boolean> = {};
          for (const e of history) {
            const id = e.agentId ?? 'main';
            map[id] = e;
            if (e.read === false) unread[id] = true;
          }
          setLastByAgent(map);
          setUnreadByAgent(unread);
        })
        .catch(() => {});
    };
    // The merged pile arrives newest-first; slicing per agent keeps each
    // card's three freshest files without N invokes.
    const loadPiles = () => {
      window.flicky
        .getArtifacts()
        .then((list) => {
          const grouped: Record<string, Artifact[]> = {};
          for (const a of list) {
            const arr = grouped[a.agentId] ?? (grouped[a.agentId] = []);
            if (arr.length < 3) arr.push(a);
          }
          setPiles(grouped);
        })
        .catch(() => {});
    };
    const loadSuggestions = () => {
      window.flicky
        .getSuggestions()
        .then((list) => setSuggestions(list ?? []))
        .catch(() => {});
    };
    loadUsage();
    loadChats();
    loadPiles();
    loadSuggestions();
    const unsub = window.flicky.onChatEntryAdded((e) => {
      const owner = e.agentId ?? 'main';
      setLastByAgent((m) => ({ ...m, [owner]: e }));
      if (e.read === false) setUnreadByAgent((m) => ({ ...m, [owner]: true }));
      if (e.artifactIds?.length) loadPiles();
      loadUsage();
    });
    // Chat reads/piles aren't settings, but a settings emit is the only
    // broadcast that guarantees a repaint-worthy state change landed —
    // piggyback a cheap refresh on it rather than miss a mark-read.
    const unsubSettings = window.flicky.onSettingsChanged(() => loadChats());
    return () => {
      unsub();
      unsubSettings();
      for (const t of sugTimers.current) window.clearTimeout(t);
    };
  }, []);

  const refreshSuggestionCards = () => {
    window.flicky.refreshSuggestions();
    setSugBusy(true);
    // Generation runs a Mind completion per agent with no completion
    // event on the wire, so poll twice — early enough to catch fast
    // replies, late enough for slow ones.
    sugTimers.current.push(
      window.setTimeout(() => {
        window.flicky.getSuggestions().then((l) => setSuggestions(l ?? [])).catch(() => {});
      }, 3000),
      window.setTimeout(() => {
        window.flicky
          .getSuggestions()
          .then((l) => setSuggestions(l ?? []))
          .catch(() => {})
          .finally(() => setSugBusy(false));
      }, 9000),
    );
  };


  const { apiKeyStatus, mindProvider } = settings;
  const mindReady =
    mindProvider === 'openai' ? apiKeyStatus.openai : apiKeyStatus.anthropic;
  const isFish = settings.ttsProvider === 'fishaudio';
  const voiceReady = isFish ? apiKeyStatus.fishaudio : apiKeyStatus.elevenlabs;
  // Voice is only a requirement when the user wants spoken replies.
  const voiceRequired = settings.speakReplies;
  const required = [mindReady, apiKeyStatus.groq, ...(voiceRequired ? [voiceReady] : [])];
  const connectedCount = required.filter(Boolean).length;
  const ready = connectedCount === required.length;
  const total = required.length;

  const modelLabel =
    mindProvider === 'openai'
      ? settings.selectedOpenAIModel === 'gpt-5'
        ? 'GPT-5'
        : settings.selectedOpenAIModel === 'gpt-5-mini'
          ? 'GPT-5 mini'
          : 'GPT-4o'
      : settings.selectedModel === 'claude-sonnet-4-6'
        ? 'Claude Sonnet 4.6'
        : 'Claude Opus 4.6';

  const pct = memory ? Math.round((memory.tokens / memory.tokenBudget) * 100) : 0;

  const shortcutKeys = settings.pushToTalkShortcut.split('+').filter(Boolean);
  const dictationKeys = settings.dictationShortcut.split('+').filter(Boolean);

  const allAgents = settings.agents ?? [];
  const activeAgents = allAgents.filter((a) => !a.archived);
  const archivedAgents = allAgents.filter((a) => a.archived);
  const routines = settings.routines ?? [];
  const agentById = new Map(allAgents.map((a) => [a.id, a]));

  // Rotating tip under the mode chips — starts on a random one each mount,
  // the shuffle button steps through the rest. Shortcut text comes from
  // live settings so a rebound hotkey updates the hint.
  const tips = [
    `hold ${settings.pushToTalkShortcut} to talk`,
    'say “zapi agent …” to hand over the mouse',
    `hold ${settings.dictationShortcut} to type by voice`,
    'right-click tray for modes',
  ];
  const [tipIdx, setTipIdx] = useState(() => Math.floor(Math.random() * 4));
  const nextTip = () => setTipIdx((i) => (i + 1) % tips.length);

  return (
    <>
      <h1 className="main-h1">
        Welcome back<em>.</em>
      </h1>
      <p className="main-lead">
        {ready
          ? 'Hold the push-to-talk shortcut from anywhere and zapi will listen, think, and reply.'
          : `${connectedCount} of ${total} providers connected. Add the remaining keys to start talking.`}
      </p>

      <div className="home-hero">
        <div className="home-wave-wrap">
          <Waveform state={ready ? voiceState : 'idle'} bars={23} height={72} />
          {ready ? (
            <div className="home-ptt">
              hold{' '}
              {shortcutKeys.map((k, i) => (
                <kbd key={`${k}-${i}`}>{k}</kbd>
              ))}{' '}
              to talk
            </div>
          ) : (
            <div className="home-ptt blocked">add the missing key to start talking</div>
          )}
          {settings.dictationEnabled && (
            <div className="home-ptt dictate-hint">
              hold{' '}
              {dictationKeys.map((k, i) => (
                <kbd key={`${k}-${i}`}>{k}</kbd>
              ))}{' '}
              to dictate
            </div>
          )}
          {(settings.dictationEnabled || settings.alwaysOnEnabled) && (
            <div className="mode-chips">
              {settings.dictationEnabled && <span className="mode-chip">dictation on</span>}
              {settings.alwaysOnEnabled && <span className="mode-chip">always-on</span>}
            </div>
          )}
          <div className="home-tip">
            <span className="tip-text">{tips[tipIdx % tips.length]}</span>
            <button className="tip-shuffle" onClick={nextTip} title="Another tip" aria-label="Another tip">
              ↻
            </button>
          </div>
        </div>
        <div className="home-status">
          <div className="status-chip">
            <div
              className={`dot ${
                voiceState === 'listening' || voiceState === 'responding' || voiceState === 'acting'
                  ? 'active'
                  : ready
                    ? ''
                    : 'warn'
              }`}
            />
            <div style={{ flex: 1 }}>
              <div className="t">
                {voiceState === 'listening'
                  ? 'Listening'
                  : voiceState === 'processing'
                    ? 'Thinking'
                    : voiceState === 'responding'
                      ? 'Responding'
                      : voiceState === 'acting'
                        ? 'Acting'
                        : ready
                          ? 'Ready'
                          : 'Setup needed'}
              </div>
              <div className="s">{ready ? 'all providers connected' : `${connectedCount} of ${total} connected`}</div>
            </div>
          </div>
          {scene && (
            <div className="status-chip live scene" role="status">
              <span className="pulse-dot" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t">zapi is drawing on your screen</div>
              </div>
            </div>
          )}
          {/* One card per non-archived agent — replaces the old single-agent
              status chip now that multiple runtimes can exist. */}
          <div className="agents-row">
            {activeAgents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                status={statuses[a.id]}
                lastAction={lastActions[a.id]}
                lastEntry={lastByAgent[a.id]}
                unread={!!unreadByAgent[a.id]}
                pile={piles[a.id]}
                onOpen={
                  onOpenAgentChat
                    ? () => {
                        // ChatsTab issues the real markChatRead; clear the
                        // dot here too so it dies with the click instead of
                        // waiting on a history refetch.
                        setUnreadByAgent((m) =>
                          m[a.id] ? { ...m, [a.id]: false } : m,
                        );
                        onOpenAgentChat(a.id);
                      }
                    : undefined
                }
              />
            ))}
            <button
              className="agent-card new"
              onClick={() => setNewAgentOpen(true)}
              title="Create a new agent"
            >
              <span className="agent-new-plus">+</span>
              <span>new agent</span>
            </button>
          </div>
          {archivedAgents.length > 0 && (
            <>
              <button
                className="agents-archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? '▾' : '▸'} {archivedAgents.length} archived
              </button>
              {showArchived && (
                <div className="agents-row">
                  {archivedAgents.map((a) => (
                    <AgentCard key={a.id} agent={a} archived unread={!!unreadByAgent[a.id]} />
                  ))}
                </div>
              )}
            </>
          )}
          {/* Scheduled routines — each owned by an agent, results post to
              that agent's chat. */}
          <div className="routines-block">
            <div className="routines-head">
              <span className="routines-label">routines</span>
              <button className="agents-archived-toggle" onClick={() => setRoutineOpen(true)}>
                + new
              </button>
            </div>
            {routines.map((r) => (
              <RoutineRow
                key={r.id}
                routine={r}
                owner={agentById.get(r.agentId)}
              />
            ))}
            {routines.length === 0 && (
              <div className="routine-empty">no routines yet — scheduled agent runs</div>
            )}
          </div>
          {/* Proactive task cards from the suggestions engine — one card
              per proposed follow-up, run on the agent it was minted for. */}
          <div className="suggestions-block">
            <div className="routines-head">
              <span className="routines-label">suggestions</span>
              <button
                className="agents-archived-toggle"
                onClick={refreshSuggestionCards}
                disabled={sugBusy}
              >
                {sugBusy ? 'thinking…' : '↻ refresh'}
              </button>
            </div>
            {suggestions.map((s) => {
              const sp = statuses[s.agentId]?.phase;
              return (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  owner={agentById.get(s.agentId)}
                  busy={sp === 'thinking' || sp === 'acting' || sp === 'waiting'}
                  onAccept={() => {
                    window.flicky.acceptSuggestion(s.id);
                    setSuggestions((p) => p.filter((x) => x.id !== s.id));
                  }}
                  onDismiss={() => {
                    window.flicky.dismissSuggestion(s.id);
                    setSuggestions((p) => p.filter((x) => x.id !== s.id));
                  }}
                />
              );
            })}
            {suggestions.length === 0 && (
              <div className="routine-empty">
                no ideas yet — refresh asks your agents for next steps
              </div>
            )}
          </div>
          {settings.alwaysOnEnabled && (
            <div className="status-chip live always-on" role="status">
              <span className="pulse-dot green" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t">always-on · listening</div>
              </div>
            </div>
          )}
          {usage && (usage.talkTurns > 0 || usage.agentMessages > 0 || usage.dictationUtterances > 0) && (
            <div className="usage-strip">
              <span className="usage-label">this month</span>
              {usage.talkTurns > 0 && (
                <span>{usage.talkTurns} talk{usage.talkTurns === 1 ? '' : 's'}</span>
              )}
              {usage.agentMessages > 0 && (
                <span>{usage.agentMessages} agent msg{usage.agentMessages === 1 ? '' : 's'}</span>
              )}
              {usage.dictationUtterances > 0 && (
                <span>{usage.dictationUtterances} dictated</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Memory</div>
          <div className="stat-value">{formatTokens(memory?.tokens ?? 0)}</div>
          <div className="stat-sub">of {formatTokens(memory?.tokenBudget ?? 250_000)} tokens ({pct}%)</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Model</div>
          <div className="stat-value" style={{ fontSize: 22, lineHeight: 1.15 }}>{modelLabel}</div>
          <div className="stat-sub">{settings.reasoningDepth === 'off' ? 'no extended thinking' : `${settings.reasoningDepth} reasoning`}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Messages</div>
          <div className="stat-value">{memory?.messageCount ?? 0}</div>
          <div className="stat-sub">
            {memory?.summarizedCount
              ? `${memory.summarizedCount} summarized`
              : 'in this session'}
          </div>
        </div>
      </div>

      <div className="provider-summary">
        <h3>Connected providers</h3>
        <div className="provider-row">
          <div className={`provider-logo ${mindProvider === 'openai' ? 'openai' : ''}`}>
            {mindProvider === 'openai' ? 'Ai' : 'A'}
          </div>
          <div className="nm">
            {mindProvider === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}{' '}
            <span className="purpose" style={{ marginLeft: 6 }}>· reasoning</span>
          </div>
          {mindReady ? (
            <span className="pill-saved">Connected</span>
          ) : (
            <button className="goto" onClick={() => onNavigate('mind')}>Add key →</button>
          )}
        </div>
        <div className="provider-row">
          <div className={`provider-logo ${isFish ? 'fish' : 'eleven'}`}>{isFish ? 'F' : '11'}</div>
          <div className="nm">
            {isFish ? 'Fish Audio' : 'ElevenLabs'}{' '}
            <span className="purpose" style={{ marginLeft: 6 }}>· voice</span>
          </div>
          {voiceReady ? (
            <span className="pill-saved">Connected</span>
          ) : !voiceRequired ? (
            <span className="purpose">off — text only</span>
          ) : (
            <button className="goto" onClick={() => onNavigate('voice')}>Add key →</button>
          )}
        </div>
        <div className="provider-row">
          <div className="provider-logo groq">G</div>
          <div className="nm">
            Groq <span className="purpose" style={{ marginLeft: 6 }}>· transcription</span>
          </div>
          {apiKeyStatus.groq ? (
            <span className="pill-saved">Connected</span>
          ) : (
            <button className="goto" onClick={() => onNavigate('ear')}>Add key →</button>
          )}
        </div>
      </div>

      <Tour shortcut={settings.pushToTalkShortcut} onNavigate={onNavigate} />

      {newAgentOpen && <NewAgentModal onClose={() => setNewAgentOpen(false)} />}
      {routineOpen && (
        <RoutineModal agents={activeAgents} onClose={() => setRoutineOpen(false)} />
      )}
    </>
  );
}

function routineScheduleLabel(r: Routine): string {
  if (r.kind === 'daily') return `daily at ${r.timeOfDay ?? '?'}`;
  const m = r.intervalMinutes ?? 0;
  return m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`;
}

interface RoutineRowProps {
  routine: Routine;
  owner?: AgentProfile;
}

/** One scheduled routine: name, owner kaomoji+name, schedule, enable flip
 * (upserts the full routine), and delete. */
function RoutineRow({ routine: r, owner }: RoutineRowProps) {
  return (
    <div className={`routine-row ${r.enabled ? '' : 'off'}`}>
      <div className="routine-meta">
        <div className="routine-name">{r.name}</div>
        <div className="routine-sub">
          {owner && (
            <span className="kao" style={{ color: owner.color }}>{owner.kaomoji}</span>
          )}
          {owner?.name ?? r.agentId} · {routineScheduleLabel(r)}
        </div>
      </div>
      <button
        className={`toggle sm ${r.enabled ? 'on' : ''}`}
        onClick={() => window.flicky.upsertRoutine({ ...r, enabled: !r.enabled })}
        aria-label={r.enabled ? 'Disable routine' : 'Enable routine'}
      />
      <button
        className="routine-del"
        onClick={() => window.flicky.deleteRoutine(r.id)}
        title={`Delete ${r.name}`}
      >
        ×
      </button>
    </div>
  );
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const ARTIFACT_ICONS: Record<Artifact['kind'], string> = {
  sheet: '▦',
  doc: '¶',
  image: '◧',
  code: '</>',
  other: '·',
};

interface AgentCardProps {
  agent: AgentProfile;
  status?: AgentStatus;
  lastAction?: string;
  lastEntry?: ChatEntry;
  unread?: boolean;
  /** Up to three newest artifacts, already sliced by the caller. */
  pile?: Artifact[];
  archived?: boolean;
  onOpen?: () => void;
}

/**
 * One agent profile card: kaomoji face + color accent + name, the current
 * run phase (or last chat activity when idle), a spinner + stop button
 * while the agent holds the input lease, an unread dot when its chat has
 * unseen entries, a small file pile of its newest artifacts, and — once a
 * run settles — an inline box to type a follow-up turn.
 */
function AgentCard({ agent, status, lastAction, lastEntry, unread, pile, archived, onOpen }: AgentCardProps) {
  const phase = status?.phase ?? 'idle';
  const running = phase === 'thinking' || phase === 'acting' || phase === 'waiting';
  const settled = phase === 'done' || phase === 'failed';
  const detail = lastAction || status?.message;
  const [followUp, setFollowUp] = useState('');

  const sub = running
    ? `step ${status!.step}/${status!.maxSteps}${detail ? ` · ${detail}` : ''}`
    : settled
      ? `${phase}${detail ? ` · ${detail}` : ''}`
      : lastEntry
        ? truncate(lastEntry.userText || lastEntry.assistantText, 42)
        : 'idle';

  const sendFollowUp = () => {
    const text = followUp.trim();
    if (!text) return;
    window.flicky.sendTextTurn(agent.id, text);
    setFollowUp('');
  };

  return (
    <div
      className={`agent-card ${running ? 'running' : ''} ${archived ? 'archived' : ''}`}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      title={archived ? undefined : `Open ${agent.name}'s chat`}
      aria-label={
        archived
          ? `${agent.name} (archived)`
          : `Open ${agent.name}'s chat${unread ? ' — unread messages' : ''}`
      }
    >
      <div className="agent-card-top">
        <div className="agent-face" style={{ color: agent.color }} aria-hidden>
          {agent.kaomoji}
        </div>
        <div className="agent-meta">
          <div className="agent-name">
            <span className="agent-dot" style={{ background: agent.color }} />
            {agent.name}
            {/* visual cue only — "unread messages" is folded into the
                card's aria-label so SR users hear it once. */}
            {unread && <span className="unread-dot" title="Unread messages" aria-hidden />}
          </div>
          <div className="agent-sub">{sub}</div>
        </div>
        <div className="agent-card-actions">
          <button
            className="agent-ws"
            onClick={(e) => {
              e.stopPropagation();
              window.flicky.openAgentWorkspace(agent.id);
            }}
            title="open workspace folder"
            aria-label={`Open ${agent.name}'s workspace folder`}
          >
            📁
          </button>
          {running && !archived && (
            <>
              <span className="spinner-sm" />
              <button
                className="agent-stop"
                onClick={(e) => {
                  e.stopPropagation();
                  window.flicky.agentStop(agent.id);
                }}
                title={`Stop ${agent.name}`}
              >
                stop
              </button>
            </>
          )}
        </div>
      </div>
      {pile && (pile.length > 0 || status) && (
        // Wrapper is a div: the chip is one open target plus a reveal
        // button — sibling buttons, since nested interactives are invalid.
        <div className="agent-pile">
          {/* House-style dim empty line, like .routine-empty — only shows
              for agents with run activity; idle cards keep no row. */}
          {pile.length === 0 && <div className="pile-empty">no files yet</div>}
          {pile.map((art) => (
            <div
              key={art.id}
              className="pile-file"
              title={`${art.title} — open, or reveal in Explorer`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.flicky.revealArtifact(art.id);
              }}
            >
              <button
                className="pile-open"
                onClick={(e) => {
                  e.stopPropagation();
                  window.flicky.openArtifact(art.id);
                }}
                title={`Open ${art.title}`}
                aria-label={`Open ${art.title}`}
              >
                <span className={`pile-ic ${art.kind}`} aria-hidden>
                  {ARTIFACT_ICONS[art.kind]}
                </span>
                <span className="pile-name">{art.title}</span>
              </button>
              <button
                className="pile-reveal"
                onClick={(e) => {
                  e.stopPropagation();
                  window.flicky.revealArtifact(art.id);
                }}
                title="Reveal in Explorer"
                aria-label={`Reveal ${art.title} in Explorer`}
              >
                ↗
              </button>
            </div>
          ))}
        </div>
      )}
      {settled && !archived && (
        <div className="agent-followup" onClick={(e) => e.stopPropagation()}>
          <input
            className="agent-followup-input"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                sendFollowUp();
              }
            }}
            placeholder={`follow up with ${agent.name}…`}
            aria-label={`Follow-up message for ${agent.name}`}
          />
          <button
            className="agent-followup-send"
            onClick={sendFollowUp}
            disabled={!followUp.trim()}
            title="Send follow-up"
            aria-label={`Send follow-up to ${agent.name}`}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}

interface SuggestionCardProps {
  suggestion: Suggestion;
  owner?: AgentProfile;
  /** True while the owning agent is mid-run — matches routine semantics
   *  (a busy agent skips work rather than queueing it). */
  busy?: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}

/** One proactive card: title, the engine's reason, the owning agent chip,
 *  'do it' to run the task, '×' to dismiss permanently. */
function SuggestionCard({ suggestion: s, owner, busy, onAccept, onDismiss }: SuggestionCardProps) {
  return (
    <div className="suggestion-card">
      <div className="suggestion-meta">
        <div className="suggestion-title">{s.title}</div>
        {s.reason && <div className="suggestion-reason">{s.reason}</div>}
        <div className="suggestion-agent">
          {owner && (
            <span className="kao" style={{ color: owner.color }} aria-hidden>
              {owner.kaomoji}
            </span>
          )}
          {owner?.name ?? s.agentId}
        </div>
      </div>
      <button
        className="suggestion-go"
        onClick={onAccept}
        disabled={busy}
        title={busy ? 'agent busy' : `Run: ${s.task}`}
      >
        do it
      </button>
      <button
        className="suggestion-del"
        onClick={onDismiss}
        disabled={busy}
        title={busy ? 'agent busy' : 'Dismiss'}
        aria-label={`Dismiss ${s.title}`}
      >
        ×
      </button>
    </div>
  );
}
