# PLAN — Mind tab → single API section (ClinePass-first)

User directive: "in the api section give me access for putting cline key and
remove the local ai thing — just use the cline api key, it has all the desired
models."

Renderer-heavy task + one new IPC channel (contract touch — coordinate wave).

## Changes

1. **Remove the Local/Ollama provider path from the panel UI**
   - `MindTab.tsx`: delete `{ id:'ollama' }` from the provider picker and the
     `isOllama ? <OllamaSection/>` branch; the Model/Reasoning sections now
     render unconditionally.
   - Remove `OllamaSection.tsx`, `OllamaManageModal.tsx`,
     `AddConnectionModal.tsx`, `ConnectionRow.tsx` (delete files).
   - Fix references: `HomeTab.tsx:52` (`localConnections` find), `Onboarding.tsx:354`
     (`hasLocal`), any `updateLocalConnection`/`listLocalConnections` preload calls.
   - `companion-manager.ts` ollama branch (~:1664): leave dormant — but if
     `settings.mindProvider === 'ollama'` is somehow persisted, coerce to
     'openai' at read so a stale setting can't strand the user. Simplest:
     settings-store getter clamps unknown providers to 'openai'.
   - Backend `localConnections` storage + ollama-api.ts can stay dormant in tree
     (or strip fully — follow repo style; keep diff focused).

2. **API section = Cline key + endpoint** (this is the "api section" they mean)
   - Relabel the OpenAI ProviderKey: `providerLabel: 'ClinePass · OpenAI-compatible'`,
     keyPlaceholder `sk-... or clinepass key`.
   - Keep `BaseUrlInput` (already live). Update hint:
     `empty = api.openai.com · clinepass: https://api.cline.bot/api`.
   - Provider picker keeps anthropic + openai; default new installs to 'openai'
     (DEFAULT_SETTINGS.mindProvider — user asked cline-first).

3. **Model list fetched from the endpoint**
   - New IPC `LIST_REMOTE_MODELS` (no args) → main:
     `GET {resolveOpenAIBase()}/v1/models` with `Authorization: Bearer {openai key}`
     — reuse `ollama.getModels(url, bearer)` shape (it already calls /v1/models).
     Return `string[]` (ids), empty on error.
   - `MindTab` OpenAI model section: `useEffect` → `flicky.listRemoteModels()`;
     if list non-empty render those ids as model-items (radio, id as name);
     else fall back to the hardcoded `OPENAI_MODELS`. Keep the
     `customOpenAIModel` free-form input as the override (it already wins at
     call time — companion-manager.ts:1659).
   - Refetch when `openAIBaseUrl` or key-set status changes (dep on those
     settings fields).

## Acceptance

- `tsc` main + renderer clean; `bun run build` green
- Panel shows no Local/Ollama UI anywhere; stale `mindProvider:'ollama'`
  setting can't break turns
- With a ClinePass key + base URL set, model list shows endpoint models
- worker_done with files + outcome
