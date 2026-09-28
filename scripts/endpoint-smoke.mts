/**
 * Endpoint-resolution checks for the OpenAI-compatible path — the bug the
 * user hit as "cline API not working": ClinePass requires provider/model
 * ids ('openai/gpt-5') while api.openai.com expects bare ids, and a pasted
 * '/v1/chat/completions' URL must collapse back to its base before we
 * append our own /v1/... suffixes.
 *
 * Pure string logic — imports only ollama-api.ts (electron-free), so it
 * runs under plain tsx/bun with no preload stub.
 *
 * Run: bun scripts/endpoint-smoke.mts   (or: npx tsx scripts/endpoint-smoke.mts)
 * Exit: 0 = all checks pass; 1 = any failed.
 */
import { isReasoningCapableModel, normalizeBase, resolveModelId } from '../src/main/services/ollama-api';

let pass = 0;
let fail = 0;
function check(ok: boolean, name: string, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`ok ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq<T>(got: T, want: T, name: string): void {
  check(Object.is(got, want), name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── normalizeBase: pasted endpoint forms collapse to the base ────────
eq(normalizeBase('https://cline.bot/api/v1/chat/completions'), 'https://cline.bot/api', 'paste: full chat-completions URL');
eq(normalizeBase('https://cline.bot/api/v1/audio/transcriptions'), 'https://cline.bot/api', 'paste: full transcriptions URL');
eq(normalizeBase('https://api.x.ai/v1'), 'https://api.x.ai', 'strip trailing /v1');
eq(normalizeBase('https://api.x.ai/v1/'), 'https://api.x.ai', 'strip /v1/ with trailing slash');
eq(normalizeBase('https://cline.bot/api/v1/models'), 'https://cline.bot/api', 'strip /v1/models');
eq(normalizeBase('http://localhost:11434'), 'http://localhost:11434', 'bare host:port unchanged');
eq(normalizeBase('https://api.openai.com/'), 'https://api.openai.com', 'trailing slash dropped');

// ── resolveModelId: prefix decision by endpoint ──────────────────────
eq(resolveModelId('gpt-5', 'https://cline.bot/api/v1'), 'openai/gpt-5', 'bare model + custom base → openai/ prefix');
eq(resolveModelId('gpt-4o-mini', 'https://cline.bot'), 'openai/gpt-4o-mini', 'key-probe model + custom base → prefixed');
eq(resolveModelId('anthropic/claude-sonnet-4-6', 'https://cline.bot'), 'anthropic/claude-sonnet-4-6', 'provider-prefixed id passes through');
eq(resolveModelId('openai/gpt-5', 'https://cline.bot'), 'openai/gpt-5', 'already-prefixed id not doubled');
eq(resolveModelId('gpt-5', ''), 'gpt-5', 'empty base → bare (api.openai.com)');
eq(resolveModelId('gpt-5', '   '), 'gpt-5', 'whitespace-only base → bare');
eq(resolveModelId('gpt-5', undefined), 'gpt-5', 'undefined base → bare');
// Round-trip: a pasted full endpoint still resolves the model id the
// same way — normalization happens upstream of the model decision.
eq(
  resolveModelId('gpt-5', normalizeBase('https://cline.bot/api/v1/chat/completions')),
  'openai/gpt-5',
  'pasted endpoint → normalizeBase → resolveModelId still prefixes',
);

// ── isReasoningCapableModel: suffix match across provider prefixes ───
check(isReasoningCapableModel('gpt-5'), "'gpt-5' bare is reasoning-capable");
check(isReasoningCapableModel('openai/gpt-5'), "'openai/gpt-5' suffix is reasoning-capable");
check(isReasoningCapableModel('azure/gpt-5-mini'), "'azure/gpt-5-mini' suffix is reasoning-capable");
check(!isReasoningCapableModel('gpt-4o'), "'gpt-4o' is not reasoning-capable");
check(!isReasoningCapableModel('anthropic/gpt-5-clone'), "unrelated suffix doesn't match");
check(!isReasoningCapableModel(''), 'empty id safe');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
