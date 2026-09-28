import { useEffect, useRef, useState } from 'react';
import type { AgentProfile, AgentStatus, ChatEntry } from '../../../shared/types';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday · ${time}`;

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` · ${time}`;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'talk', label: 'Talk' },
  { id: 'dictation', label: 'Dictated' },
  { id: 'agent', label: 'Agent runs' },
] as const;

type ChatFilter = (typeof FILTERS)[number]['id'];

interface ChatsTabProps {
  agents: AgentProfile[];
  /** Selected agent profile id; null = all agents' history. */
  agentFilter: string | null;
  onAgentFilter: (id: string | null) => void;
  /** False when no Mind key is configured — disables the composer. */
  mindReady: boolean;
}

export function ChatsTab({ agents, agentFilter, onAgentFilter, mindReady }: ChatsTabProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [streamingUser, setStreamingUser] = useState<string | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState('');
  // Typed-turn draft + the selected agent's run phase (input locks while
  // that agent is mid-run so a typed message can't jump the queue).
  const [draft, setDraft] = useState('');
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentFilterRef = useRef(agentFilter);
  agentFilterRef.current = agentFilter;

  // History is filtered server-side per agent — reload when the selection
  // changes. 'All' passes undefined and gets the merged feed.
  useEffect(() => {
    setEntries([]);
    window.flicky
      .getChatHistory(agentFilter ?? undefined)
      .then(setEntries)
      .catch((err) => console.error('[zapi] load chat history failed:', err));
  }, [agentFilter]);

  // Opening a chat marks its backlog read. The merged 'All' view shows
  // every agent's entries, so each known profile gets marked — agents
  // with no unread entries are a harmless no-op in main.
  const agentIdsKey = agents.map((a) => a.id).join(',');
  useEffect(() => {
    const ids = agentFilter ? [agentFilter] : agentIdsKey.split(',').filter(Boolean);
    for (const id of ids) window.flicky.markChatRead(id);
  }, [agentFilter, agentIdsKey]);

  useEffect(() => {
    const unsubs = [
      window.flicky.onChatEntryAdded((entry) => {
        // Ignore entries for other agents while viewing one agent's chat.
        const sel = agentFilterRef.current;
        if (sel && (entry.agentId ?? 'main') !== sel) return;
        setEntries((prev) => [...prev, entry]);
        setStreamingUser(null);
        setStreamingAssistant('');
        // The entry landed on screen — mark it read immediately so the
        // Home unread dot doesn't light for a message the user watched
        // arrive.
        window.flicky.markChatRead(entry.agentId ?? 'main');
      }),
      window.flicky.onAgentStatus((s) => {
        setStatuses((m) => ({ ...m, [s.agentId]: s }));
      }),
      window.flicky.onTranscriptUpdate((t) => {
        if (t.text) setStreamingUser(t.text);
      }),
      window.flicky.onAiResponseChunk((chunk) => {
        setStreamingAssistant((prev) => prev + chunk);
      }),
      // Wipe any orphan streaming state when a session ends without
      // producing an entry (e.g., transcription returned empty or
      // the LLM call errored). A fresh session landing on 'listening'
      // clears the previous turn's scaffolding.
      window.flicky.onVoiceStateChanged((state) => {
        if (state === 'listening') {
          setStreamingUser(null);
          setStreamingAssistant('');
        }
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // auto-scroll to bottom on new content, and when the agent filter swaps
  // the list wholesale
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, streamingUser, streamingAssistant, agentFilter]);

  const clearAll = () => {
    const label = agentFilter
      ? agents.find((a) => a.id === agentFilter)?.name ?? 'this agent'
      : 'all chat';
    if (!confirm(`Clear ${label === 'all chat' ? 'all chat history' : `${label}'s history`}? This cannot be undone.`)) return;
    window.flicky.clearChatHistory(agentFilter ?? undefined);
    setEntries([]);
  };

  // The typed-turn target: a selected agent's chat talks to that agent;
  // the merged 'All' feed defaults to the main companion.
  const selectedAgentId = agentFilter ?? 'main';
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const selPhase = statuses[selectedAgentId]?.phase;
  const agentBusy =
    selPhase === 'thinking' || selPhase === 'acting' || selPhase === 'waiting';
  const inputLocked = agentBusy || !mindReady;
  // Disabled-reason tooltip shared by the field and the send button.
  const lockHint = !mindReady
    ? 'add an OpenAI/ClinePass or Anthropic key in Mind tab'
    : agentBusy
      ? `${selectedAgent?.name ?? 'zapi'} is working…`
      : undefined;

  const sendDraft = () => {
    const text = draft.trim();
    if (!text || inputLocked) return;
    window.flicky.sendTextTurn(selectedAgentId, text);
    setDraft('');
  };

  const hasAny = entries.length > 0 || streamingUser || streamingAssistant;
  // Single predicate for both persisted entries and the in-flight turn:
  // an entry with no kind counts as 'talk', and a live turn has no kind
  // yet, so it flows through the same rule. A live turn can't be attributed
  // to a named agent until the entry lands, so it only shows under All or
  // the default 'main' agent.
  const matchesFilter = (kind: ChatEntry['kind'] | undefined) =>
    filter === 'all' || (kind ?? 'talk') === filter;
  const filtered = entries.filter((e) => matchesFilter(e.kind));
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label.toLowerCase() ?? '';
  const showLive = matchesFilter(undefined) && (!agentFilter || agentFilter === 'main');

  return (
    <>
      <div className="chats-head">
        <div>
          <h1 className="main-h1">
            Chats<em>.</em>
          </h1>
          <p className="main-lead" style={{ marginBottom: 0 }}>
            Everything you and zapi have said. All stored locally on your machine.
          </p>
        </div>
        {agentFilter && (
          <button
            className="btn xs"
            onClick={() => window.flicky.openAgentWorkspace(agentFilter)}
            title="open workspace folder"
            aria-label={`Open ${agents.find((a) => a.id === agentFilter)?.name ?? agentFilter}'s workspace folder`}
          >
            📁 workspace
          </button>
        )}
        <button className="btn xs" onClick={clearAll} disabled={!entries.length}>
          Clear history
        </button>
      </div>

      {agents.filter((a) => !a.archived).length > 0 && (
        <div className="chat-agents">
          <button
            className={`agent-filter-chip ${agentFilter === null ? 'on' : ''}`}
            onClick={() => onAgentFilter(null)}
          >
            All
          </button>
          {agents
            .filter((a) => !a.archived)
            .map((a) => (
              <button
                key={a.id}
                className={`agent-filter-chip ${agentFilter === a.id ? 'on' : ''}`}
                onClick={() => onAgentFilter(a.id)}
              >
                <span className="kao" style={{ color: a.color }} aria-hidden>{a.kaomoji}</span>
                {a.name}
              </button>
            ))}
        </div>
      )}

      <div className="chat-filters">
        <div className="seg">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? 'on' : ''}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {!hasAny && (
          <div className="chat-empty">
            <div className="chat-empty-icon">Z</div>
            <div className="chat-empty-t">No chats yet</div>
            <div className="chat-empty-s">
              Hold the push-to-talk shortcut from anywhere on your machine to start a conversation.
            </div>
          </div>
        )}

        {filtered.map((e) => (
          <ChatPair
            key={e.id}
            user={e.userText}
            assistant={e.assistantText}
            ts={e.timestamp}
            kind={e.kind}
          />
        ))}

        {hasAny && filtered.length === 0 && !(streamingUser || streamingAssistant) && (
          <div className="chat-empty">
            <div className="chat-empty-s">Nothing tagged {filterLabel} yet.</div>
          </div>
        )}

        {showLive && (streamingUser || streamingAssistant) && (
          <ChatPair
            user={streamingUser ?? ''}
            assistant={streamingAssistant}
            ts={Date.now()}
            live
          />
        )}
      </div>

      {/* title sits on the row: disabled inputs/swallow pointer events,
          so the lock reason would never surface on the field itself. */}
      <div className="chat-input-row" title={lockHint}>
        <textarea
          className="chat-input"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendDraft();
            }
          }}
          placeholder={
            inputLocked
              ? (lockHint ?? 'unavailable')
              : `message ${selectedAgent?.name ?? 'zapi'}…`
          }
          disabled={inputLocked}
          title={lockHint}
          aria-label={`Message ${selectedAgent?.name ?? 'zapi'}`}
        />
        <button
          className="btn primary xs chat-send"
          onClick={sendDraft}
          disabled={inputLocked || !draft.trim()}
          title={lockHint ?? 'Send message'}
        >
          Send
        </button>
      </div>
    </>
  );
}

function ChatPair({
  user,
  assistant,
  ts,
  live,
  kind,
}: {
  user: string;
  assistant: string;
  ts: number;
  live?: boolean;
  kind?: ChatEntry['kind'];
}) {
  return (
    <div className={`chat-pair ${live ? 'live' : ''}`}>
      <div className="chat-time">
        {formatTime(ts)}{live ? ' · live' : ''}
        {kind === 'dictation' && <span className="chat-kind">dictated</span>}
        {kind === 'agent' && <span className="chat-kind">agent run</span>}
      </div>
      {user && (
        <div className="chat-turn user">
          <div className="chat-avatar user">You</div>
          <div className="chat-text">{user}</div>
        </div>
      )}
      {assistant && (
        <div className="chat-turn assistant">
          <div className="chat-avatar assistant">Z</div>
          <div className="chat-text">
            {assistant}
            {live && <span className="caret" />}
          </div>
        </div>
      )}
    </div>
  );
}
