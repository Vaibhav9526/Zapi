import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic } from './fs-util';
import type { Suggestion } from '../../shared/types';

/**
 * Local-only store of the task cards the suggestions engine has proposed
 * for each agent. Dismissals are permanent (the engine re-reads its own
 * store when refreshing), so `list` hides them but the file keeps them —
 * a re-suggested card the user already swiped away must not come back on
 * the next refresh.
 *
 * On-disk shape is `{ [agentId]: Suggestion[] }`, newest-first, capped at
 * MAX_PER_AGENT per agent (dismissed rows are trimmed first so history
 * doesn't crowd out live cards). Same cache-then-debounced-atomic-flush
 * pattern as the chat/artifact stores.
 */

const MAX_PER_AGENT = 200;
const FLUSH_DELAY_MS = 400;

type SuggestionMap = Record<string, Suggestion[]>;

let cache: SuggestionMap | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'zapi-suggestions.json');
}

function readFromDisk(): SuggestionMap {
  const map: SuggestionMap = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        map[agentId] = (value as Suggestion[]).filter(
          (s): s is Suggestion =>
            !!s && typeof s === 'object' &&
            typeof (s as Suggestion).id === 'string' &&
            typeof (s as Suggestion).task === 'string',
        );
      }
    }
  } catch {
    return {};
  }
  return map;
}

function ensureCache(): SuggestionMap {
  if (cache === null) cache = readFromDisk();
  return cache;
}

function flushNow(): void {
  if (cache === null) return;
  try {
    writeFileAtomic(getFilePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[Zapi] suggestion flush failed:', err);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY_MS);
}

function newestFirst(items: Suggestion[]): Suggestion[] {
  return [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Live cards for one agent, or every agent merged when `agentId` is
 * omitted. Dismissed entries are filtered out; the result is a copy.
 */
export function list(agentId?: string): Suggestion[] {
  const map = ensureCache();
  const source = agentId !== undefined
    ? (map[agentId] ?? [])
    : Object.values(map).flat();
  return newestFirst(source).filter((s) => !s.dismissed);
}

/** Every card including dismissed ones — engine/diagnostic use. */
export function listAll(agentId?: string): Suggestion[] {
  const map = ensureCache();
  return newestFirst(
    agentId !== undefined ? (map[agentId] ?? []) : Object.values(map).flat(),
  );
}

/** Suggestion minus the fields the store owns. */
export type NewSuggestion = Omit<Suggestion, 'id' | 'createdAt' | 'dismissed'> &
  Partial<Pick<Suggestion, 'id' | 'createdAt' | 'dismissed'>>;

let idCounter = 0;

function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Record a card, newest first. `dismissed` defaults to false. */
export function add(suggestion: NewSuggestion): Suggestion {
  const full: Suggestion = {
    ...suggestion,
    id: suggestion.id ?? newId(),
    createdAt: suggestion.createdAt ?? Date.now(),
    dismissed: suggestion.dismissed ?? false,
  };
  const map = ensureCache();
  const arr = map[full.agentId] ?? (map[full.agentId] = []);
  arr.unshift(full);
  if (arr.length > MAX_PER_AGENT) {
    // Trim the oldest DISMISSED rows first; only if every trimmed row is
    // still live do we start dropping live cards.
    const drop = arr.length - MAX_PER_AGENT;
    const dismissedCount = arr.filter((s) => s.dismissed).length;
    if (dismissedCount >= drop) {
      const doomed = new Set(
        arr.filter((s) => s.dismissed).slice(-drop).map((s) => s.id),
      );
      map[full.agentId] = arr.filter((s) => !doomed.has(s.id));
    } else {
      arr.length = MAX_PER_AGENT;
    }
  }
  scheduleFlush();
  return { ...full };
}

/** Dismiss one card by id. Returns false for an unknown id. */
export function dismiss(id: string): boolean {
  for (const items of Object.values(ensureCache())) {
    const hit = items.find((s) => s.id === id);
    if (hit) {
      hit.dismissed = true;
      scheduleFlush();
      return true;
    }
  }
  return false;
}

/** Drop an agent's cards, or every agent's when `agentId` is omitted. */
export function clear(agentId?: string): void {
  if (agentId === undefined) {
    cache = {};
  } else {
    const map = ensureCache();
    if (!map[agentId]) return;
    map[agentId] = [];
    scheduleFlush();
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
