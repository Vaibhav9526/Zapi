# PLAN — Custom OpenAI base URL (ClinePass / OpenAI-compatible endpoints)

Goal: let the user point the **existing OpenAI mind provider** at an
OpenAI-compatible endpoint (ClinePass, proxies, etc.) with their existing
OpenAI key slot. Vision/screenshots must keep working — the openai-api path
already sends images unconditionally.

Small task. One worker. Touches the shared contract — dispatch when no other
contract edit is in flight.

## Changes

1. `src/shared/types.ts`
   - `FlickySettings`: add `openAIBaseUrl: string` (empty = default api.openai.com)
   - `DEFAULT_SETTINGS`: `openAIBaseUrl: ''`
   - IPC map: add `SET_OPENAI_BASE_URL` (string payload), following `SET_CUSTOM_OPENAI_MODEL`

2. `src/main/services/settings-store.ts` — field on the settings interface
   (~line 55, next to `customOpenAIModel`), default `''` (~line 94),
   companion setter `setOpenAIBaseUrl(v: string)` (store.trim())

3. `src/main/services/openai-api.ts`
   - Add `baseUrl?: string` to `OpenAIChatOptions`
   - Resolve endpoint: `baseUrl ? `${normalize(baseUrl)}/v1/chat/completions` : OPENAI_API_URL`
     where `normalize` = strip trailing `/` then strip a trailing `/v1`
     (same rule as `normalizeBase` in ollama-api.ts — copy the 3-line helper or export it)
   - Log the resolved host once per call (no key material): `console.log('[Zapi] openai endpoint:', host)`

4. `src/main/companion-manager.ts` (~:1659 openai branch)
   - pass `baseUrl: settings.openAIBaseUrl || undefined` into streamChat options

5. `src/main/services/key-validation.ts` (~:39)
   - openai validator posts to hardcoded URL — accept an optional baseUrl param
     (or read settingsStore directly if that module already imports it) and use
     the same resolution rule, so "validate key" works against ClinePass too

6. `src/main/index.ts` — `ipcMain.handle(IPC.SET_OPENAI_BASE_URL, ...)` →
   `settingsStore.setOpenAIBaseUrl`, next to the custom-model handler (~:589)

7. `src/preload/index.ts` — `setOpenAIBaseUrl(v: string)` next to `setCustomOpenAIModel`

8. `src/renderer/components/panel/MindTab.tsx` (~:199, inside `isOpenAI` block,
   below custom-model input):
   - label: `Custom base URL (optional)`
   - input bound to `settings.openAIBaseUrl`, `onChange` → `setOpenAIBaseUrl`
   - placeholder `https://api.cline.bot/v1`
   - hint: `leave empty for api.openai.com — point at any OpenAI-compatible endpoint (clinepass, proxy, etc.)`

## Acceptance

- `bunx tsc -p tsconfig.main.json --noEmit` and renderer tsconfig clean
- `bun run build` green
- Manual sanity: set `openAIBaseUrl` to `https://localhost:9` → a talk turn
  errors fast with connection refused at that host (proves the URL is used);
  reset to `''`
- worker_done with files + outcome
