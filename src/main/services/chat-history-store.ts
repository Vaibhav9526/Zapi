import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic } from './fs-util';
import { MAIN_AGENT_ID } from './settings-store';
import type { ChatEntry } from '../../shared/types';

/**
 * Persistent, local-only chat log, keyed by owning agent. Every exchange
 * (user question + assistant reply) is appended here under the agent that
 * produced it. Nothing ever leaves the machine.
 *
 * On-disk shape is `{ [agentId]: ChatEntry[] }`. Pre-multi-agent installs
 * wrote a flat array; those entries had no owner, so they are adopted by
 * the default agent on first read and rewritten in the new shape.
 *
 * - In-memory cache populated lazily on first read; all subsequent
 *   reads/writes touch the cache, not the file.
 * - Writes are debounced and flushed atomically (write-tmp → rename).
 * - Bounded per agent at MAX_ENTRIES so no single list grows without limit.
 */

const MAX_ENTRIES = 1000;
const FLUSH_DELAY_MS = 400;

type ChatMap = Record<string, ChatEntry[]>;

let cache: ChatMap | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'zapi-chats.json');
}

/**
 * Coerce whatever is on disk into `{ agentId: entries[] }`. A bare array
 * is the legacy single-agent file and migrates under 'main'; entries
 * inside either shape that predate per-agent ownership (no `agentId`
 * field) are stamped so a single agent's list is internally consistent.
 */
function normalizeStored(parsed: unknown): { map: ChatMap; migrated: boolean } {
  const map: ChatMap = {};
  let migrated = false;

  if (Array.isArray(parsed)) {
    migrated = true;
    map[MAIN_AGENT_ID] = (parsed as ChatEntry[]).map((e) =>
      e && typeof e === 'object' && !e.agentId ? { ...e, agentId: MAIN_AGENT_ID } : e,
    );
    return { map, migrated };
  }

  if (parsed && typeof parsed === 'object') {
    for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      // Pre-per-agent-entry files nested under an agent id still lack the
      // per-entry stamp; add it so consumers can rely on the field.
      const entries = (value as ChatEntry[]).map((e) =>
        e && typeof e === 'object' && !e.agentId ? { ...e, agentId, migrated } : e,
      );
      if (entries.some((e) => e.agentId !== undefined)) migrated = true;
      map[agentId] = entries;
    }
    return { map, migrated };
  }

  return { map, migrated };
}

function readFromDisk(): ChatMap {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    const { map, migrated } = normalizeStored(JSON.parse(raw));
    if (migrated) {
      // Persist the new shape right away so the legacy array isn't
      // re-interpreted on every launch.
      try {
        writeFileAtomic(getFilePath(), JSON.stringify(map, null, 2));
      } catch (err) {
        console.warn('[Zapi] chat history migration write failed:', err);
      }
    }
    return map;
  } catch {
    return {};
  }
}

function ensureCache(): ChatMap {
  if (cache === null) cache = readFromDisk();
  return cache;
}

function flushNow(): void {
  if (cache === null) return;
  try {
    writeFileAtomic(getFilePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[Zapi] chat history flush failed:', err);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY_MS);
}

/** Entries for one agent. Unknown ids read as empty rather than throwing. */
export function list(agentId: string = MAIN_AGENT_ID): ChatEntry[] {
  return [...(ensureCache()[agentId] ?? [])];
}

/** Every agent id that has at least one entry. */
export function listAgentIds(): string[] {
  return Object.keys(ensureCache()).filter((id) => (cache?.[id]?.length ?? 0) > 0);
}

/** Legacy flat list, all agents concatenated — the call sites pre-Phase B. */
export function getAll(): ChatEntry[] {
  return Object.values(ensureCache()).flat();
}

export function append(
  agentId: string,
  entry: Omit<ChatEntry, 'id' | 'timestamp'>,
): ChatEntry {
  const full: ChatEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    agentId,
    ...entry,
    // New turns land unread; the panel calls markRead the moment the
    // entry is on screen. Defaulted (not omitted) so "is this unread"
    // is one `read === false` test everywhere — legacy rows keep their
    // absent field, which that same test reads as read.
    read: entry.read ?? false,
  };
  const map = ensureCache();
  const arr = map[agentId] ?? (map[agentId] = []);
  arr.push(full);
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
  scheduleFlush();
  return full;
}

/**
 * Mark every entry of one agent read (the panel opening that agent's
 * chat). Returns how many rows actually changed, so the CHAT_MARK_READ
 * handler can skip a disk write when the chat was already read. An
 * unknown agent id is a no-op, not an error: the panel marks every known
 * profile when the merged view is open, most of which have no history.
 */
export function markRead(agentId: string): number {
  const arr = ensureCache()[agentId];
  if (!arr) return 0;
  let changed = 0;
  for (const entry of arr) {
    if (entry.read === true) continue;
    entry.read = true;
    changed++;
  }
  if (changed > 0) scheduleFlush();
  return changed;
}

/**
 * Clear one agent's history, or every agent's when `agentId` is omitted
 * (the panel's global "clear all chats" affordance).
 */
export function clear(agentId?: string): void {
  if (agentId === undefined) {
    cache = {};
  } else {
    const map = ensureCache();
    if (map[agentId]) {
      map[agentId] = [];
      scheduleFlush();
      return;
    }
    return;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
}

/** Synchronous flush — call on app will-quit to avoid losing pending writes. */
export function flushSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
}
