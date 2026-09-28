/**
 * Dev tool: plant three sample Suggestion cards into the app's real
 * zapi-suggestions.json so the panel's suggestion UI can be eyeballed
 * without a live model call.
 *
 *   bun scripts/seed-suggestions.mts                 # seed into detected userData
 *   bun scripts/seed-suggestions.mts -- --clear      # remove previously-seeded rows
 *   bun scripts/seed-suggestions.mts -- --agent scout
 *   bun scripts/seed-suggestions.mts -- --user-data "C:\\path\\to\\userData"
 *
 * Works under tsx too — it's a plain fs tool, no Electron import (the
 * store itself needs `app`, so the tool replicates its on-disk shape
 * instead of reusing it):
 *
 *   { "<agentId>": Suggestion[] }   newest-first, ≤200 per agent
 *   Suggestion = { id, agentId, title, task, reason?, createdAt, dismissed }
 *
 * Target dir resolution order:
 *   --user-data flag → $ZAPI_SEED_USERDATA → $ZAPI_SMOKE_USERDATA →
 *   first existing of %APPDATA%\\ZAPI, %APPDATA%\\zapi → %APPDATA%\\ZAPI.
 *
 * Idempotent: rows whose id starts with 'seed-' are replaced on re-run
 * (or dropped by --clear); every other agent's rows and non-seed rows
 * are left untouched. Writes atomically via services/fs-util.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../src/main/services/fs-util';
import type { Suggestion } from '../src/shared/types';

const MAX_PER_AGENT = 200; // mirror of suggestion-store.ts
const SEED_PREFIX = 'seed-';
const FILE = 'zapi-suggestions.json';

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

function resolveUserData(): string {
  const explicit = flagValue('--user-data') ?? process.env.ZAPI_SEED_USERDATA ?? process.env.ZAPI_SMOKE_USERDATA;
  if (explicit) return explicit;
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  for (const name of ['ZAPI', 'zapi']) {
    const dir = path.join(appData, name);
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(appData, 'ZAPI');
}

const agentId = flagValue('--agent') ?? 'main';
const userData = resolveUserData();
const filePath = path.join(userData, FILE);

// ── Load the existing index, preserving every other agent's rows ───────
let map: Record<string, Suggestion[]> = {};
if (fs.existsSync(filePath)) {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        // Same well-formedness bar the store's loader applies.
        if (Array.isArray(value)) {
          map[id] = (value as Suggestion[]).filter(
            (s): s is Suggestion =>
              !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.task === 'string',
          );
        }
      }
    }
  } catch (err) {
    console.error(`[seed] ${filePath} is corrupt — starting over:`, err);
    map = {};
  }
}

const before = (map[agentId] ?? []).length;
const kept = (map[agentId] ?? []).filter((s) => !s.id.startsWith(SEED_PREFIX));

if (hasFlag('--clear')) {
  map[agentId] = kept;
  writeFileAtomic(filePath, JSON.stringify(map, null, 2));
  console.log(`[seed] removed ${before - kept.length} seed row(s) from ${filePath}`);
  console.log(`[seed] ${agentId}: ${kept.length} non-seed row(s) kept`);
  process.exit(0);
}

const now = Date.now();
const seeds: Suggestion[] = [
  {
    id: `${SEED_PREFIX}digest-${now.toString(36)}`,
    agentId,
    title: 'summarize this week’s chats',
    task: 'summarize the last 7 days of chat into a markdown digest and save it as a file',
    reason: 'recurring weekly wrap-up',
    createdAt: now,
    dismissed: false,
  },
  {
    id: `${SEED_PREFIX}sheet-${(now - 1).toString(36)}`,
    agentId,
    title: 'expense sheet skeleton',
    task: 'create a csv expense tracker with date, category, amount columns',
    reason: 'you built a similar sheet before',
    createdAt: now - 1,
    dismissed: false,
  },
  {
    id: `${SEED_PREFIX}followup-${(now - 2).toString(36)}`,
    agentId,
    title: 'pick up the report draft',
    task: 'finish the quarterly report draft left half done',
    reason: 'open thread from earlier',
    createdAt: now - 2,
    dismissed: false,
  },
];

// Newest-first, then trim to the store's per-agent cap from the tail.
map[agentId] = [...seeds, ...kept]
  .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  .slice(0, MAX_PER_AGENT);

fs.mkdirSync(userData, { recursive: true });
writeFileAtomic(filePath, JSON.stringify(map, null, 2));

console.log(`[seed] wrote ${seeds.length} suggestion(s) for agent '${agentId}' → ${filePath}`);
for (const s of seeds) console.log(`  • ${s.title} — ${s.task}`);
console.log(`[seed] ${kept.length} existing non-seed row(s) preserved; rerun any time (idempotent), --clear to remove`);
