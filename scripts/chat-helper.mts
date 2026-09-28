/**
 * Fresh-process worker for chat-smoke.mts.
 *
 * chat-history-store.ts keeps a module-level cache (and a debounce timer),
 * so each seed state needs a cold import: this helper runs as a child
 * process per case. $ZAPI_SMOKE_USERDATA points at the case dir (inherited
 * env); $CHAT_MODE selects the operation; $CHAT_AGENT_ID names the agent
 * (default 'main').
 *
 *   CHAT_MODE=read          → prints { entries: getAll() }
 *   CHAT_MODE=read-agent    → prints { entries: list(agentId) }
 *   CHAT_MODE=append        → appends a kind:'agent' entry, flushSync(),
 *                             prints { appended }
 *   CHAT_MODE=append-plain  → appends a no-kind entry, flushSync(),
 *                             prints { appended }  (read-flag assertions)
 *   CHAT_MODE=markread      → markRead(agentId), flushSync(), prints
 *                             { marked: agentId } — or { error } when the
 *                             export hasn't landed yet, so the parent
 *                             case reports a clean FAIL not a crash.
 *
 * Run only via bun with the electron stub preload:
 *   bun --preload ./scripts/store-preload.ts ./scripts/chat-helper.mts
 */
import { getAll, list, append, flushSync } from '../src/main/services/chat-history-store';
import * as chatStore from '../src/main/services/chat-history-store';

const mode = process.env.CHAT_MODE ?? 'read';
const agentId = process.env.CHAT_AGENT_ID ?? 'main';
if (mode === 'append') {
  const entry = append(agentId, {
    userText: 'open notepad',
    assistantText: 'opening notepad',
    kind: 'agent',
  });
  flushSync();
  console.log(JSON.stringify({ appended: entry }));
} else if (mode === 'append-plain') {
  const entry = append(agentId, {
    userText: `hello from ${agentId}`,
    assistantText: 'hi there',
  });
  flushSync();
  console.log(JSON.stringify({ appended: entry }));
} else if (mode === 'markread') {
  const markRead = (chatStore as Record<string, unknown>).markRead;
  if (typeof markRead !== 'function') {
    console.log(JSON.stringify({ error: 'markRead is not exported by chat-history-store yet' }));
  } else {
    (markRead as (id: string) => void)(agentId);
    flushSync();
    console.log(JSON.stringify({ marked: agentId }));
  }
} else if (mode === 'read-agent') {
  console.log(JSON.stringify({ entries: list(agentId) }));
} else {
  console.log(JSON.stringify({ entries: getAll() }));
}
process.exit(0);
