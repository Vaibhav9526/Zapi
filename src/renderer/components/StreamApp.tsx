import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentAction,
  AgentProfile,
  AgentStatus,
  Artifact,
  ChatEntry,
  Scene,
  SceneCue,
  Suggestion,
  TranscriptionResult,
  TypeRequest,
  VoiceState,
} from '../../shared/types';

interface Turn {
  id: string;
  user: string;
  ai: string;
  /** Whether the AI portion is still being streamed in. */
  streaming: boolean;
  /** Turn start time (ms epoch) — the markdown export stamps it HH:MM. */
  ts: number;
  /**
   * The ChatEntry this turn sealed into, once it lands. Live turns are
   * seeded by transcript+chunk events which carry no metadata, so the
   * entry's artifactIds/agentId only become known at attach time.
   */
  entryId?: string;
  /** Owning agent; absent means the default 'main' agent. */
  agentId?: string;
  /** Artifacts produced during the turn — rendered as a file pile. */
  artifactIds?: string[];
}

/**
 * Rail glyph for draw-kind scene cues. 'point' cues get a numbered
 * badge instead (they're the step-like beats); every other kind is a
 * stroke the overlay draws, so the rail shows what was drawn.
 */
const CUE_GLYPH: Record<Exclude<SceneCue['kind'], 'point'>, string> = {
  arrow: '↗',
  circle: '◯',
  box: '▢',
  hilite: '▨',
  path: '〜',
  write: '✎',
  clear: '✕',
};

/** Glyph per executed agent action in the live feed. */
const ACTION_GLYPH: Record<AgentAction['kind'], string> = {
  click: '↖',
  dclick: '⇑',
  rclick: '↗',
  type: '⌨',
  key: '⌘',
  scroll: '⇅',
  drag: '⟿',
  move: '•',
  wait: '⏱',
  open: '⏏',
  done: '✓',
  fail: '✕',
};

/** Glyph per artifact kind in the per-turn file pile. */
const ARTIFACT_GLYPH: Record<Artifact['kind'], string> = {
  sheet: '▦',
  doc: '¶',
  image: '▣',
  code: '</>',
  other: '◈',
};

/** Max entries kept in the agent action feed. */
const FEED_MAX = 12;
/** How long the feed lingers after the run returns to idle. */
const FEED_COLLAPSE_MS = 3000;

interface AgentFeedEntry {
  id: number;
  kind: AgentAction['kind'];
  label: string;
  /**
   * Who was acting when this echo landed. AgentAction carries no agentId,
   * so this is captured from the status stream at echo time — the best
   * attribution available without changing the IPC payload.
   */
  agentId?: string;
}

/** One agent's latest status plus its emit order, for "most recent" picks. */
interface TrackedStatus {
  status: AgentStatus;
  seq: number;
}

/** Fallback identity for an agent we have no profile for. */
const UNKNOWN_KAOMOJI = '🤖';
function agentName(profiles: Map<string, AgentProfile>, id: string | undefined): string {
  if (!id) return 'agent';
  const hit = profiles.get(id);
  if (hit) return hit.name;
  // 'main' predates profiles and is still the default agent id.
  return id === 'main' ? 'Zapi' : id;
}
function agentKaomoji(profiles: Map<string, AgentProfile>, id: string | undefined): string {
  return (id && profiles.get(id)?.kaomoji) || UNKNOWN_KAOMOJI;
}

/**
 * agentId → profile, for the kaomoji / name chips. Loaded once on mount and
 * refreshed whenever a status names an agent we have no profile for — the
 * panel can create agents at runtime and there is no profiles-changed event,
 * so a status naming an unknown id is the only signal we get. Names are
 * cosmetic here, so a failed fetch degrades to the raw id.
 */
function useAgentProfiles(knownIdsKey: string): Map<string, AgentProfile> {
  const [profiles, setProfiles] = useState<Map<string, AgentProfile>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      window.flicky
        .getAgents()
        .then((list) => {
          if (cancelled) return;
          setProfiles(new Map((list ?? []).map((p) => [p.id, p])));
        })
        .catch(() => {
          /* cosmetic only — fall back to the agent id */
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const missing = useMemo(
    () => (knownIdsKey ? knownIdsKey.split(',') : []).filter((id) => !profiles.has(id)),
    [knownIdsKey, profiles],
  );
  useEffect(() => {
    if (missing.length === 0) return;
    window.flicky
      .getAgents()
      .then((list) => setProfiles(new Map((list ?? []).map((p) => [p.id, p]))))
      .catch(() => {
        /* leave the fallback in place */
      });
  }, [missing.join(',')]);

  return profiles;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The transparent floating window that mirrors the live Q/A stream.
 * It subscribes to the same IPC feed the panel uses (transcript updates,
 * response chunks, completed entries, scene cues, agent status) and
 * renders them in a scrollable list. The window chrome itself (size /
 * position / drag) is handled by the main process; this component only
 * draws what's inside.
 */
export function StreamApp() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [scene, setScene] = useState<Scene | null>(null);
  const [activeCue, setActiveCue] = useState<number | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Map<string, TrackedStatus>>(
    () => new Map(),
  );
  const [agentActions, setAgentActions] = useState<AgentFeedEntry[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [typeNote, setTypeNote] = useState<TypeRequest | null>(null);
  /** artifactId → Artifact lookup backing the per-turn file piles. */
  const [artifacts, setArtifacts] = useState<Map<string, Artifact>>(() => new Map());
  /** Undismissed suggestion cards — the strip hides itself when empty. */
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  /** Brief "copied" confirmation on the transcript-copy buttons. */
  const [copied, setCopied] = useState<'none' | 'plain' | 'md'>('none');
  const bodyRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  /** Tracks the in-progress turn so chunks can append to it. */
  const currentIdRef = useRef<string | null>(null);
  /**
   * Scroll-pinning: true while the user's viewport sits at (or near) the
   * bottom of the transcript. New content snaps to bottom only when
   * pinned; scrolling up more than ~80px unpins so a long token stream
   * never yanks the reader's viewport.
   */
  const pinnedRef = useRef(true);
  /** True while the latest agent phase is 'thinking' or 'acting' — gates feed appends. */
  const agentRunningRef = useRef(false);
  /** True from run start until the post-idle collapse clears the feed. */
  const runOpenRef = useRef(false);
  const feedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionSeqRef = useRef(0);
  /** Emit counter that gives "most recent agent" a stable ordering. */
  const statusSeqRef = useRef(0);
  /** Mirror of agentStatuses for the echo handler to read without stale state. */
  const statusesRef = useRef<Map<string, TrackedStatus>>(new Map());
  statusesRef.current = agentStatuses;
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Delayed suggestion re-read after a manual refresh request. */
  const sugTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Derived agent view ──────────────────────────────────────────────
  // Every agent with a non-idle status, newest emit first. The bar shows
  // the head of this list and counts the rest.
  const activeStatuses = useMemo(
    () =>
      [...agentStatuses.values()]
        .filter((t) => t.status.phase !== 'idle')
        .sort((a, b) => b.seq - a.seq),
    [agentStatuses],
  );
  const primaryStatus = activeStatuses[0]?.status ?? null;
  const otherAgentCount = Math.max(0, activeStatuses.length - 1);
  // Profiles are needed by status pills, suggestion cards, and any turn
  // an entry attributed to a non-main agent — union all three id sets so
  // the missing-id refetch in useAgentProfiles covers every surface.
  const agentIds = useMemo(() => {
    const ids = new Set(agentStatuses.keys());
    for (const s of suggestions) if (s.agentId) ids.add(s.agentId);
    for (const t of turns) if (t.agentId) ids.add(t.agentId);
    return [...ids].sort().join(',');
  }, [agentStatuses, suggestions, turns]);
  const profiles = useAgentProfiles(agentIds);
  const phaseWord = (p: AgentStatus['phase']): string =>
    p === 'acting'
      ? 'acting'
      : p === 'thinking'
        ? 'thinking'
        : p === 'waiting'
          ? 'waiting'
          : p;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await window.flicky.getChatHistory();
        if (cancelled) return;
        setTurns(
          history.map((h: ChatEntry) => ({
            id: h.id,
            entryId: h.id,
            user: h.userText,
            ai: h.assistantText,
            streaming: false,
            ts: h.timestamp,
            agentId: h.agentId,
            artifactIds: h.artifactIds,
          })),
        );
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubState = window.flicky.onVoiceStateChanged(setVoiceState);

    const unsubTranscript = window.flicky.onTranscriptUpdate((result: TranscriptionResult) => {
      // A final transcript marks the start of a new turn — seed it with
      // the user text and an empty AI body the chunks will append to.
      if (!result.isFinal) return;
      const id = makeId();
      currentIdRef.current = id;
      setTurns((prev) => [
        ...prev,
        { id, user: result.text, ai: '', streaming: true, ts: Date.now() },
      ]);
    });

    const unsubChunk = window.flicky.onAiResponseChunk((chunk: string) => {
      const id = currentIdRef.current;
      if (!id) return;
      setTurns((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ai: t.ai + chunk } : t)),
      );
    });

    const unsubComplete = window.flicky.onAiResponseComplete((fullText: string) => {
      const id = currentIdRef.current;
      if (!id) return;
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, ai: fullText, streaming: false } : t,
        ),
      );
      currentIdRef.current = null;
    });

    // The entry is the only event carrying artifactIds/agentId — chunk
    // and transcript payloads don't. Attach it to the turn it sealed:
    // userText matches the transcript verbatim for talk/dictation turns.
    // Voice-triggered AGENT runs store the parsed task instead, so text
    // can't match — they fall back to the still-open streaming turn (the
    // run's summary chunks haven't started, so ai is still empty). An
    // entry with no seeded turn at all (typed/routine turns never emit a
    // transcript, so their chunks were dropped for want of an open turn)
    // becomes a complete row of its own.
    const unsubEntry = window.flicky.onChatEntryAdded((entry: ChatEntry) => {
      setTurns((prev) => {
        if (prev.some((t) => t.entryId === entry.id)) return prev;
        let idx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].entryId === undefined && prev[i].user === entry.userText) {
            idx = i;
            break;
          }
        }
        if (idx < 0 && entry.kind === 'agent' && currentIdRef.current) {
          const open = currentIdRef.current;
          const i = prev.findIndex(
            (t) => t.id === open && t.streaming && t.ai === '' && t.entryId === undefined,
          );
          if (i >= 0) idx = i;
        }
        if (idx < 0) {
          return [
            ...prev,
            {
              id: entry.id,
              entryId: entry.id,
              user: entry.userText,
              ai: entry.assistantText,
              streaming: false,
              ts: entry.timestamp,
              agentId: entry.agentId,
              artifactIds: entry.artifactIds,
            },
          ];
        }
        return prev.map((t, i) =>
          i === idx
            ? {
                ...t,
                entryId: entry.id,
                agentId: entry.agentId,
                artifactIds: entry.artifactIds,
              }
            : t,
        );
      });
    });

    // SCENE delivers the full ordered cue list once; SCENE_CUE then
    // streams the active beat index so the rail can track progress.
    // SCENE(null) ends the scene — clearing the highlight here keeps a
    // stale beat index from lingering on an empty rail.
    const unsubScene = window.flicky.onScene((s) => {
      setScene(s);
      if (!s) setActiveCue(null);
    });

    const unsubSceneCue = window.flicky.onSceneCue((i) => {
      setActiveCue(i);
    });

    // Agent status drives the run lifecycle: a thinking/acting phase
    // opens (and resets) the action feed; idle schedules its collapse a
    // few seconds later so the last actions stay readable.
    const unsubAgent = window.flicky.onAgentStatus((s) => {
      const running = s.phase === 'thinking' || s.phase === 'acting';
      if (running && !runOpenRef.current) {
        runOpenRef.current = true;
        setAgentActions([]);
        if (feedTimerRef.current) {
          clearTimeout(feedTimerRef.current);
          feedTimerRef.current = null;
        }
      }
      agentRunningRef.current = running;
      if ((s.phase === 'done' || s.phase === 'failed') && runOpenRef.current) {
        // The run finished — append a verdict line while the feed is
        // still expanded, then start the same delayed collapse idle uses.
        // 'done' reports the step count from the status; 'failed' lifts
        // the reason from the status message when one arrived.
        runOpenRef.current = false;
        const reason = s.message?.trim();
        const label =
          s.phase === 'done'
            ? `done in ${s.step} step${s.step === 1 ? '' : 's'}`
            : `failed${reason ? ` — ${reason}` : ''}`;
        setAgentActions((prev) => [
          ...prev.slice(-(FEED_MAX - 1)),
          { id: ++actionSeqRef.current, kind: s.phase === 'done' ? 'done' : 'fail', label },
        ]);
        feedTimerRef.current = setTimeout(() => {
          feedTimerRef.current = null;
          setAgentActions([]);
        }, FEED_COLLAPSE_MS);
      } else if (s.phase === 'idle' && runOpenRef.current) {
        runOpenRef.current = false;
        feedTimerRef.current = setTimeout(() => {
          feedTimerRef.current = null;
          setAgentActions([]);
        }, FEED_COLLAPSE_MS);
      }
      // Keyed by agentId: several agents can run at once and each keeps
      // its own phase. A late 'idle' that would contradict a newer status
      // for the same agent (lower step) is dropped rather than blanking a
      // pill that belongs to the current turn.
      const prev = statusesRef.current.get(s.agentId);
      if (s.phase === 'idle' && prev && prev.status.phase !== 'idle' && s.step < prev.status.step) {
        return;
      }
      const next = new Map(statusesRef.current);
      next.set(s.agentId, { status: s, seq: ++statusSeqRef.current });
      statusesRef.current = next;
      setAgentStatuses(next);
    });

    // Live feed of executed actions — only while a run is live, so a
    // stray echo after the loop stops can't reopen a collapsed feed.
    const unsubAction = window.flicky.onAgentAction((a) => {
      if (!agentRunningRef.current) return;
      // AgentAction carries no agentId, so attribute the row to whoever
      // was acting when the echo arrived.
      const acting = [...statusesRef.current.values()]
        .filter((t) => t.status.phase === 'acting')
        .sort((x, y) => y.seq - x.seq)[0]?.status.agentId;
      setAgentActions((prev) => [
        ...prev.slice(-(FEED_MAX - 1)),
        {
          id: ++actionSeqRef.current,
          kind: a.kind,
          label: a.label,
          agentId: acting ?? [...statusesRef.current.values()].sort((x, y) => y.seq - x.seq)[0]?.status.agentId,
        },
      ]);
    });

    // Turn failures are sent to this window too — without surfacing them
    // a bad key or provider error looks like "nothing happened". Auto-
    // dismiss after a few seconds; it's a transient notice, not a log.
    const unsubError = window.flicky.onAiError((m) => {
      setLastError(m);
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
      errTimerRef.current = setTimeout(() => {
        setLastError(null);
        errTimerRef.current = null;
      }, 10_000);
    });

    // Dictation / auto-type confirmations — "typed N chars" chip.
    const unsubType = window.flicky.onTypeFulfilled((req) => {
      setTypeNote(req);
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      typeTimerRef.current = setTimeout(() => {
        setTypeNote(null);
        typeTimerRef.current = null;
      }, 5_000);
    });

    return () => {
      unsubState();
      unsubTranscript();
      unsubChunk();
      unsubComplete();
      unsubEntry();
      unsubScene();
      unsubSceneCue();
      unsubAgent();
      unsubAction();
      unsubError();
      unsubType();
      if (feedTimerRef.current) {
        clearTimeout(feedTimerRef.current);
        feedTimerRef.current = null;
      }
      if (errTimerRef.current) clearTimeout(errTimerRef.current);
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (sugTimerRef.current) clearTimeout(sugTimerRef.current);
    };
  }, []);

  // Artifact lookup for the file piles. Loaded once, then re-fetched only
  // when a turn references an id the map doesn't have yet — artifacts
  // land right around their turn's entry, so the first pile render can
  // race the store write.
  useEffect(() => {
    let cancelled = false;
    window.flicky
      .getArtifacts()
      .then((list) => {
        if (!cancelled) setArtifacts(new Map((list ?? []).map((a) => [a.id, a])));
      })
      .catch(() => {
        /* piles stay empty — cosmetic */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const missingArtifactKey = useMemo(() => {
    const missing = new Set<string>();
    for (const t of turns) {
      for (const id of t.artifactIds ?? []) {
        if (!artifacts.has(id)) missing.add(id);
      }
    }
    return [...missing].sort().join(',');
  }, [turns, artifacts]);

  useEffect(() => {
    if (!missingArtifactKey) return;
    let cancelled = false;
    window.flicky
      .getArtifacts()
      .then((list) => {
        if (!cancelled) setArtifacts(new Map((list ?? []).map((a) => [a.id, a])));
      })
      .catch(() => {
        /* leave chips unresolved */
      });
    return () => {
      cancelled = true;
    };
  }, [missingArtifactKey]);

  // No 'suggestions-changed' push event exists on the preload surface, so
  // the strip loads once on mount and refreshes only on its own ↻ button.
  useEffect(() => {
    let cancelled = false;
    window.flicky
      .getSuggestions()
      .then((list) => {
        if (!cancelled) setSuggestions(list ?? []);
      })
      .catch(() => {
        /* strip stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The feed always snaps to the latest action — unlike the turn list,
  // it's a transient status surface, not something the user reads back.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentActions]);

  /**
   * More than 80 px of unread content below the viewport means the user
   * scrolled up to read an earlier turn — stop following new content
   * until they return to the bottom. Tracked on scroll events rather
   * than measured after render: a single chunk taller than 80 px would
   * otherwise push a still-pinned user past the threshold and stall the
   * follow for the rest of the turn.
   */
  const PIN_THRESHOLD_PX = 80;
  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  };

  // Snap to bottom when content grows and the user is still pinned.
  // Deferred to rAF so a long token stream doesn't force synchronous
  // layout on every chunk. `scene` is a dep because the cue rail lives
  // inside the scrollable body and grows it when a scene starts.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [turns, scene]);

  const statusLabel =
    voiceState === 'listening'
      ? 'listening…'
      : voiceState === 'processing'
        ? 'thinking…'
        : voiceState === 'responding'
          ? 'responding'
          : voiceState === 'acting'
            ? 'agent working'
            : 'idle';

  /**
   * Clipboard write shared by both copy buttons. navigator.clipboard
   * can be denied on a frameless window in some contexts, so there's an
   * execCommand fallback; either way the clicked button flashes
   * 'copied' so the user knows the click landed.
   */
  const writeClipboard = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing more to try — the flash still confirms the click */
      }
      document.body.removeChild(ta);
    }
  };

  const flashCopied = (kind: 'plain' | 'md'): void => {
    setCopied(kind);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied('none'), 1500);
  };

  /** Copy the visible transcript as "You: … / Zapi: …" blocks. */
  const copyTranscript = () => {
    const text = turns
      .map((t) => `You: ${t.user}\nZapi: ${t.ai}`)
      .join('\n\n');
    void writeClipboard(text).then(() => flashCopied('plain'));
  };

  /** Same transcript as a markdown list with HH:MM turn timestamps. */
  const copyMarkdown = () => {
    const hhmm = (ts: number): string => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const text = turns
      .flatMap((t) => [
        `- [${hhmm(t.ts)}] user: ${t.user}`,
        `- [${hhmm(t.ts)}] zapi: ${t.ai}`,
      ])
      .join('\n');
    void writeClipboard(text).then(() => flashCopied('md'));
  };

  /**
   * Manual strip refresh: asks main to regenerate cards, then re-reads
   * the list twice — immediately (covers a synchronous rebuild) and once
   * more after a beat (covers an async generation pass).
   */
  const refreshSuggestions = () => {
    const load = (): void => {
      window.flicky
        .getSuggestions()
        .then((list) => setSuggestions(list ?? []))
        .catch(() => {
          /* keep what's shown */
        });
    };
    window.flicky.refreshSuggestions();
    load();
    if (sugTimerRef.current) clearTimeout(sugTimerRef.current);
    sugTimerRef.current = setTimeout(() => {
      sugTimerRef.current = null;
      load();
    }, 900);
  };

  const acceptSuggestion = (id: string): void => {
    window.flicky.acceptSuggestion(id);
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  const dismissSuggestion = (id: string): void => {
    window.flicky.dismissSuggestion(id);
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  /**
   * Wipe every piece of renderer-side state (preload exposes no
   * clearStream IPC — chat history on disk is untouched). Pending
   * notice timers are cancelled so they can't fire against cleared
   * state; a live agent run keeps running — this is a display reset,
   * not a stop.
   */
  const clearStream = () => {
    setTurns([]);
    currentIdRef.current = null;
    setScene(null);
    setActiveCue(null);
      setAgentActions([]);
      setAgentStatuses(new Map());
      statusesRef.current = new Map();
    setLastError(null);
    setTypeNote(null);
    if (feedTimerRef.current) {
      clearTimeout(feedTimerRef.current);
      feedTimerRef.current = null;
    }
    if (errTimerRef.current) {
      clearTimeout(errTimerRef.current);
      errTimerRef.current = null;
    }
    if (typeTimerRef.current) {
      clearTimeout(typeTimerRef.current);
      typeTimerRef.current = null;
    }
    // Re-pin so the next turn starts snapped to bottom.
    pinnedRef.current = true;
  };

  return (
    <div className="stream-root">
      <div className="stream-head">
        <span className="title">Zapi · {statusLabel}</span>
        <button
          className={`btn${copied === 'plain' ? ' copied' : ''}`}
          title="Copy the transcript"
          onClick={copyTranscript}
        >
          {copied === 'plain' ? 'copied' : 'copy transcript'}
        </button>
        <button
          className={`btn${copied === 'md' ? ' copied' : ''}`}
          title="Copy the transcript as a markdown list with timestamps"
          onClick={copyMarkdown}
        >
          {copied === 'md' ? 'copied' : 'copy md'}
        </button>
        <button
          className="btn"
          title="Clear the on-screen stream (chat history is untouched)"
          onClick={clearStream}
        >
          clear
        </button>
      </div>
      {/* Proactive suggestion cards — pinned under the head like the
          agent status bar. Hidden entirely when nothing is undismissed. */}
      {suggestions.length > 0 && (
        <div className="suggest-strip">
          <span className="suggest-label">suggested</span>
          <div className="suggest-cards">
            {suggestions.map((s) => (
              <div key={s.id} className="suggest-card" title={s.reason ?? s.task}>
                <span className="suggest-title">{s.title}</span>
                <span className="suggest-agent">{agentName(profiles, s.agentId)}</span>
                <button
                  className="suggest-run"
                  title={s.task}
                  onClick={() => acceptSuggestion(s.id)}
                >
                  run
                </button>
                <button
                  className="suggest-x"
                  aria-label={`Dismiss ${s.title}`}
                  onClick={() => dismissSuggestion(s.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            className="suggest-refresh"
            title="Refresh suggestions"
            onClick={refreshSuggestions}
          >
            ↻
          </button>
        </div>
      )}
      {/* Pinned while the agent loop drives the mouse/keyboard. The
          stream window is a normal focusable window, so the stop
          button is clickable even though the overlay is click-through. */}
      {primaryStatus && (
        <div className="agent-status" role="status">
          <span className="agent-status-text">
            {agentKaomoji(profiles, primaryStatus.agentId)}{' '}
            {agentName(profiles, primaryStatus.agentId)} · {phaseWord(primaryStatus.phase)} step{' '}
            {primaryStatus.step}/{primaryStatus.maxSteps}
            {primaryStatus.message ? ` · ${primaryStatus.message}` : ''}
            {otherAgentCount > 0 ? ` · +${otherAgentCount} more agent${otherAgentCount === 1 ? '' : 's'}` : ''}
          </span>
          <button
            className="agent-stop"
            title={`Stop ${agentName(profiles, primaryStatus.agentId)}`}
            onClick={() => window.flicky.agentStop(primaryStatus.agentId)}
          >
            stop
          </button>
        </div>
      )}
      {/* Transient error line — turn failures would otherwise vanish. */}
      {lastError && (
        <div className="stream-error" role="alert">
          <span className="stream-error-text">{lastError}</span>
          <button
            className="stream-error-x"
            onClick={() => setLastError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {typeNote && (
        <div className="stream-typechip" role="status" title={typeNote.preview}>
          {typeNote.autoTyped ? 'typed' : 'copied'} {typeNote.text.length} chars
        </div>
      )}
      {/* Compact log of executed agent actions under the status bar. */}
      {agentActions.length > 0 && (
        <div className="agent-feed" ref={feedRef}>
          {agentActions.map((a) => (
            <div key={a.id} className="agent-feed-row">
              <span className="agent-feed-agent" aria-hidden>
                {agentName(profiles, a.agentId)}
              </span>
              <span className="agent-feed-glyph" aria-hidden>
                {ACTION_GLYPH[a.kind]}
              </span>
              <span className="agent-feed-label">{a.label}</span>
            </div>
          ))}
        </div>
      )}
      <div className="stream-body" ref={bodyRef} onScroll={handleBodyScroll}>
        {scene && scene.cues.length > 0 && (
          <div className="scene-card">
            <div className="scene-head">
              <span className="scene-title">Scene</span>
              <span className="scene-progress">
                {activeCue === null
                  ? `${scene.cues.length} cue${scene.cues.length === 1 ? '' : 's'}`
                  : `cue ${activeCue + 1} of ${scene.cues.length}`}
              </span>
            </div>
            <ol className="scene-steps">
              {scene.cues.map((cue, i) => {
                // Cue order == beat order: index < activeCue means the
                // beat already played (done: dim + strike), === is the
                // highlighted beat, > stays faint until its turn.
                const state =
                  activeCue === null
                    ? 'pending'
                    : i < activeCue
                      ? 'done'
                      : i === activeCue
                        ? 'active'
                        : 'pending';
                return (
                  <li key={i} className={`scene-step ${state}`}>
                    {cue.kind === 'point' ? (
                      <>
                        <span className="scene-num">
                          {state === 'done' ? '✓' : (cue.step ?? i + 1)}
                        </span>
                        <span className="scene-label">{cue.text}</span>
                      </>
                    ) : (
                      <>
                        <span className="scene-num scene-glyph" aria-hidden>
                          {CUE_GLYPH[cue.kind]}
                        </span>
                        {cue.text && <span className="scene-label">{cue.text}</span>}
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {turns.length === 0 && !scene ? (
          <div className="stream-empty">
            Hold the push-to-talk shortcut and start talking. The live Q/A will appear here.
          </div>
        ) : turns.length === 0 ? null : (
          turns.map((t) => (
            <div key={t.id} className="stream-turn">
              <div className="stream-label">You</div>
              <div className="stream-user">{t.user}</div>
              <div className="stream-label" style={{ marginTop: 6 }}>
                {agentName(profiles, t.agentId ?? 'main')}
              </div>
              <div className="stream-ai">
                {t.ai}
                {t.streaming && <span className="stream-caret" />}
              </div>
              {/* Files the turn produced — resolved through the artifacts
                  lookup; ids that haven't landed yet render nothing until
                  the missing-id refetch fills the map. */}
              {t.artifactIds && t.artifactIds.length > 0 && (
                <div className="artifact-pile">
                  {t.artifactIds.map((id) => {
                    const a = artifacts.get(id);
                    if (!a) return null;
                    return (
                      <button
                        key={id}
                        className="artifact-chip"
                        title={a.path}
                        onClick={() => window.flicky.openArtifact(id)}
                      >
                        <span className="artifact-icon" aria-hidden>
                          {ARTIFACT_GLYPH[a.kind] ?? ARTIFACT_GLYPH.other}
                        </span>
                        <span className="artifact-title">{a.title}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
