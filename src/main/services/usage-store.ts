import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeFileAtomic } from './fs-util';
import type { UsageStats } from '../../shared/types';

/**
 * Monthly usage counters, persisted as JSON next to settings.
 * Best-effort by design: a failed read/write costs us telemetry, not
 * a broken turn — so every IO path swallows errors.
 */

function getFilePath(): string {
  return path.join(app.getPath('userData'), 'zapi-usage.json');
}

/** 'YYYY-MM' in local time — the bucket the user sees in the panel. */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function freshMonth(): UsageStats {
  return { month: currentMonth(), talkTurns: 0, agentMessages: 0, dictationUtterances: 0, perAgent: {} };
}

/** Empty counter row for one agent. */
function freshCounters(): { talkTurns: number; agentMessages: number; dictationUtterances: number } {
  return { talkTurns: 0, agentMessages: 0, dictationUtterances: 0 };
}

function readDisk(): UsageStats {
  try {
    const raw = fs.readFileSync(getFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    return {
      ...freshMonth(),
      ...parsed,
      // perAgent is optional on the contract and absent from every file
      // written before multi-agent; normalise so callers never guard.
      perAgent: parsed.perAgent && typeof parsed.perAgent === 'object' ? { ...parsed.perAgent } : {},
    };
  } catch {
    return freshMonth();
  }
}

/**
 * In-memory cache hydrated lazily (same rationale as settings-store:
 * within a run we own the file). The month check lives here rather
 * than at load so a process that runs across a month boundary rolls
 * over on the next record instead of silently counting into the old
 * bucket.
 */
let cache: UsageStats | null = null;

function ensureLoaded(): UsageStats {
  if (cache === null) cache = readDisk();
  if (cache.month !== currentMonth()) {
    cache = freshMonth();
    persist(cache);
  }
  return cache;
}

function persist(stats: UsageStats): void {
  try {
    writeFileAtomic(getFilePath(), JSON.stringify(stats, null, 2));
  } catch (err) {
    console.warn('[Zapi] usage write failed:', err);
  }
}

/** Counter keys shared by the monthly total and each per-agent row. */
type CounterKey = 'talkTurns' | 'agentMessages' | 'dictationUtterances';

function bump(key: CounterKey, agentId: string): void {
  const stats = ensureLoaded();
  stats[key] += 1;
  // Totals and the per-agent row move together — the panel reads both
  // (overall figures, and a per-agent breakdown as agents are added), so a
  // counter that only bumped the total would make the two disagree.
  const per = stats.perAgent ?? (stats.perAgent = {});
  const row = per[agentId] ?? (per[agentId] = freshCounters());
  row[key] += 1;
  persist(stats);
}

export const recordTalkTurn = (agentId = 'main'): void => bump('talkTurns', agentId);
export const recordAgentMessage = (agentId = 'main'): void => bump('agentMessages', agentId);
export const recordDictationUtterance = (agentId = 'main'): void => bump('dictationUtterances', agentId);

export function getStats(): UsageStats {
  // Copy so callers can't mutate the cache through the returned ref.
  return { ...ensureLoaded() };
}
