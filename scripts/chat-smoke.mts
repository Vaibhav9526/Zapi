/**
 * Smoke test for chat-history-store.ts.
 *
 * Bun-ONLY (uses the Bun.plugin electron stub + process.execPath respawn):
 *   bun --preload ./scripts/store-preload.ts ./scripts/chat-smoke.mts
 * Under any other runner it prints SKIP lines and exits 0 — the `electron`
 * import in the store cannot be satisfied without the bun preload stub,
 * and a skipped test must never masquerade as PASS.
 *
 * The store keeps a module-level cache, so every seed state gets a cold
 * import via a chat-helper.mts child process (one spawn per case).
 *
 * Covers:
 *  a) legacy file without 'kind' → loads fine, kind undefined (back-compat);
 *  b) append with kind 'agent' → persists through flush + fresh-process read;
 *  c) store filename: now zapi-chats.json (post-rebrand, hardcoded
 *     in getFilePath — no exported constant to adapt to), tested;
 *  d) corrupt JSON → recovers to [] without throwing;
 *  e) read flags: appended entries carry read:false, and markRead flips
 *     only the named agent's entries — the per-agent unread dot contract.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

declare const Bun: unknown;

let pass = 0;
let fail = 0;
let skipped = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(
      `FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`,
    );
  }
}
function skip(name: string, reason: string): void {
  skipped++;
  console.log(`SKIP ${name} :: ${reason}`);
}
void skip;

if (typeof Bun === 'undefined') {
  skip('chat: legacy/corrupt/roundtrip', 'requires bun --preload electron stub');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./store-preload.ts', import.meta.url));
const helper = fileURLToPath(new URL('./chat-helper.mts', import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-chat-smoke-'));
const HISTORY_FILE = 'zapi-chats.json';

type HelperMode = 'read' | 'read-agent' | 'append' | 'append-plain' | 'markread';

function runHelper(
  dir: string,
  mode: HelperMode,
  agentId?: string,
): { status: number; json: Record<string, unknown> | null; stderr: string } {
  const res = spawnSync(process.execPath, ['--preload', preload, helper], {
    cwd: root,
    env: {
      ...process.env,
      ZAPI_SMOKE_USERDATA: dir,
      CHAT_MODE: mode,
      ...(agentId !== undefined ? { CHAT_AGENT_ID: agentId } : {}),
    },
    encoding: 'utf-8',
  });
  let json: Record<string, unknown> | null = null;
  try {
    const lastLine = String(res.stdout ?? '').trim().split('\n').pop() ?? '';
    json = JSON.parse(lastLine) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status ?? -1, json, stderr: String(res.stderr ?? '') };
}

// ── a) Legacy entries without 'kind' load fine ──────────────────────────
{
  const dir = path.join(tmpRoot, 'legacy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, HISTORY_FILE),
    JSON.stringify([
      { id: 'a-1', timestamp: 1700000000000, userText: 'hi', assistantText: 'hello' },
      { id: 'a-2', timestamp: 1700000001000, userText: 'q', assistantText: 'a' },
    ]),
  );
  const r = runHelper(dir, 'read');
  const entries = (r.json?.entries ?? null) as Array<Record<string, unknown>> | null;
  check(r.status === 0 && entries !== null, 'chat legacy: loads without throwing', {
    status: r.status,
    stderr: r.stderr.slice(-300),
  });
  check(
    entries !== null &&
      entries.length === 2 &&
      entries[0].userText === 'hi' &&
      entries[0].assistantText === 'hello',
    'chat legacy: entries intact',
    entries,
  );
  check(
    entries !== null && !('kind' in (entries[0] as object)),
    'chat legacy: kind stays undefined for old entries',
    entries?.[0],
  );
}

// ── b) Append kind:'agent' → disk → fresh-process read ──────────────────
{
  const dir = path.join(tmpRoot, 'roundtrip');
  fs.mkdirSync(dir, { recursive: true });
  const w = runHelper(dir, 'append');
  const appended = (w.json?.appended ?? null) as Record<string, unknown> | null;
  check(
    w.status === 0 &&
      appended !== null &&
      typeof appended.id === 'string' &&
      typeof appended.timestamp === 'number' &&
      appended.kind === 'agent',
    'chat append: entry gets id/timestamp, keeps kind agent',
    appended,
  );
  // Raw disk assertion. The on-disk shape is now `{ [agentId]: entries[] }`
  // (multi-agent), so the seeded 'main' list is asserted under its key.
  let onDisk: Record<string, Array<Record<string, unknown>>> | null = null;
  try {
    onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf-8'),
    ) as Record<string, Array<Record<string, unknown>>>;
  } catch {
    onDisk = null;
  }
  const mainOnDisk = onDisk?.main ?? null;
  check(
    mainOnDisk !== null &&
      mainOnDisk.length === 1 &&
      mainOnDisk[0].kind === 'agent' &&
      mainOnDisk[0].agentId === 'main' &&
      mainOnDisk[0].id === appended?.id,
    'chat append: kind + agentId persisted under the agent key on disk',
    onDisk,
  );
  // Fresh-process read (cold module cache).
  const r = runHelper(dir, 'read');
  const entries = (r.json?.entries ?? null) as Array<Record<string, unknown>> | null;
  check(
    r.status === 0 &&
      entries !== null &&
      entries.length === 1 &&
      entries[0].kind === 'agent' &&
      entries[0].userText === 'open notepad',
    'chat roundtrip: fresh process reads back the agent entry',
    entries,
  );
}

// ── c) Filename: the post-rebrand zapi name ─────────────────────────────
{
  const dir = path.join(tmpRoot, 'roundtrip');
  const zapiExists = fs.existsSync(path.join(dir, HISTORY_FILE));
  // Negative guard: the pre-rebrand filename must not reappear. The literal
  // is the point of the check, so it stays spelled the old way on purpose.
  const legacyExists = fs.existsSync(path.join(dir, 'flicky-chat-history.json'));
  check(
    zapiExists && !legacyExists,
    `chat file: store uses ${HISTORY_FILE} (rename landed; no legacy file)`,
    { zapiExists, legacyExists },
  );
}

// ── d) Corrupt JSON → empty list, no throw ──────────────────────────────
{
  const dir = path.join(tmpRoot, 'corrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, HISTORY_FILE), '{not valid json!!!');
  const r = runHelper(dir, 'read');
  const entries = (r.json?.entries ?? null) as Array<Record<string, unknown>> | null;
  check(
    r.status === 0 && entries !== null && entries.length === 0,
    'chat corrupt: recovers to [] without throwing',
    { status: r.status, entries, stderr: r.stderr.slice(-300) },
  );
}

// ── e) read flags: stamped false on append, markRead is per-agent ──────
{
  const dir = path.join(tmpRoot, 'readflag');
  fs.mkdirSync(dir, { recursive: true });

  const w1 = runHelper(dir, 'append-plain', 'main');
  const e1 = (w1.json?.appended ?? null) as Record<string, unknown> | null;
  check(
    w1.status === 0 && e1 !== null && e1.read === false,
    'chat read: appended main entry stamped read:false',
    e1 ?? w1.stderr.slice(-300),
  );
  const w2 = runHelper(dir, 'append-plain', 'scout');
  const e2 = (w2.json?.appended ?? null) as Record<string, unknown> | null;
  check(
    w2.status === 0 && e2 !== null && e2.read === false,
    'chat read: appended scout entry stamped read:false',
    e2 ?? w2.stderr.slice(-300),
  );

  const m = runHelper(dir, 'markread', 'main');
  check(
    m.status === 0 && m.json?.marked === 'main',
    'chat read: markRead(main) completes',
    { status: m.status, json: m.json, stderr: m.stderr.slice(-300) },
  );

  const rMain = runHelper(dir, 'read-agent', 'main');
  const mainEntries = (rMain.json?.entries ?? null) as Array<Record<string, unknown>> | null;
  check(
    rMain.status === 0 &&
      mainEntries !== null &&
      mainEntries.length === 1 &&
      mainEntries.every((e) => e.read === true),
    'chat read: markRead flipped every main entry to read:true',
    mainEntries,
  );

  const rScout = runHelper(dir, 'read-agent', 'scout');
  const scoutEntries = (rScout.json?.entries ?? null) as Array<Record<string, unknown>> | null;
  check(
    rScout.status === 0 &&
      scoutEntries !== null &&
      scoutEntries.length === 1 &&
      scoutEntries.every((e) => e.read === false),
    'chat read: markRead(main) left scout entries unread',
    scoutEntries,
  );

  // And the flip must be durable, not just an in-cache mutation.
  let onDisk: Record<string, Array<Record<string, unknown>>> | null = null;
  try {
    onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf-8'),
    ) as Record<string, Array<Record<string, unknown>>>;
  } catch {
    onDisk = null;
  }
  check(
    onDisk !== null &&
      (onDisk.main ?? []).every((e) => e.read === true) &&
      (onDisk.scout ?? []).every((e) => e.read === false),
    'chat read: read flags persisted to disk per agent',
    onDisk,
  );
}

// Best-effort temp cleanup; never fails the run.
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
