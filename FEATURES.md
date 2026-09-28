# ZAPI — heyclicky.com Feature Parity Audit

Report-only audit of the ZAPI Electron app against the heyclicky.com feature set.
Each item was verified in code (grep + read). Statuses: **DONE** (implemented
end-to-end), **PARTIAL** (works but something is missing), **MISSING** (not found).

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | Global PTT hotkey | DONE | `src/main/index.ts:335-435` (globalShortcut register, hold/toggle, macOS toggle-force); `src/shared/types.ts:523-543` (IPC channels) |
| 2 | Always-on VAD listening | DONE | Overlay VAD engine `src/renderer/components/OverlayApp.tsx:288-399`; `handleVadUtterance` in `src/main/companion-manager.ts:636`; `setAlwaysOn` at `:273` |
| 3 | Dictation (push-to-dictate + mode toggle) | DONE | Dictation hotkey `src/main/index.ts:450-516`; sticky toggle `companion-manager.ts:285`; forced-dictation path `:593-625`; panel toggle `GeneralTab.tsx:221-222` |
| 4 | Screen-aware talk turns (screenshot→LLM→speech) | DONE | `captureAllDisplays` `:992` → `streamMind` `:1116` → `parseScene` `:1061` → `synthesizeSpeech` `:1097` in `companion-manager.ts` |
| 5 | On-screen drawing (arrow/box/circle/hilite/path/write/clear + point cursor) | DONE | Tag regexes `element-detector.ts:46-53`; `InkLayer.tsx:248`; prompt spec `prompts.ts:19-26`; POINT cursor via `onCursorPosition` (`preload/index.ts:281`) |
| 6 | Walkthrough step badges | DONE | `OverlayApp.tsx:987-989` renders `step-badge` + `step-badge-total`; styles `overlay.css:98-113` |
| 7 | Agent mode (click/dclick/rclick/move/type/key/scroll/drag/wait/done/fail via nut-js) | DONE | All verbs executed in `agent-driver.ts:163-281` via lazy `@nut-tree-fork/nut-js`; prompt contract `prompts.ts:69-79` |
| 8 | Agent status UI (panel chip + stream feed + overlay pill) | DONE | `HomeTab.tsx:146`, `StreamApp.tsx:307-311`, `OverlayApp.tsx:1047-1057`; fan-out `index.ts:256-260` |
| 9 | Agent stop | DONE | `IPC.AGENT_STOP` (`types.ts:540`), `agentStop` (`preload/index.ts:88`), buttons in `StreamApp.tsx:305` + `HomeTab.tsx:156` |
| 10 | Multi-monitor scene routing | DONE | Per-display overlays `index.ts:844`; `shotToDisplay` (`element-detector.ts:59`); cursor-screen-first sorting (`screen-capture.ts:140-145`); display-aware clicks (`agent-driver.ts:69-87`) |
| 11 | TTS providers (ElevenLabs + Fish Audio) | DONE | `elevenlabs-tts.ts:17`, `fish-audio-tts.ts:17`; provider switch `companion-manager.ts:1359-1374`; voice preview `:475-481`; `VoiceTab.tsx:13-46` |
| 12 | Speech providers (Groq + OpenAI Whisper) | DONE | `transcription.ts:82` (Groq), `:152` (OpenAI `gpt-4o-transcribe`), dispatcher `:197-205`; model picker `EarTab.tsx:8-59` |
| 13 | Mind providers (Anthropic + OpenAI + Ollama) | DONE | Dispatch `companion-manager.ts:1301-1345`; `claude-api.ts:37`, `openai-api.ts:47`, `ollama-api.ts:257`; picker `MindTab.tsx:103-109` |
| 14 | API key OS-store (safeStorage) | DONE | `key-store.ts:8-70` (safeStorage encrypt → `zapi-keys.json`); status + validation wired to panel |
| 15 | Chat history with kind | DONE | `chat-history-store.ts:63` appends; kinds `talk` (`:1054`), `dictation` (`:961`), `agent` (`:1256`); kind filters + badges in `ChatsTab.tsx:27-29,183-184` |
| 16 | Usage stats | DONE | `usage-store.ts:62-72` counters (talkTurns/agentMessages/dictationUtterances); surfaced in `HomeTab.tsx:163-173` |
| 17 | Settings panel (all new fields) | DONE | `GeneralTab.tsx`: PTT shortcut + mode (`:140-179`), always-on/dictation/agent toggles (`:210-264`), max steps (`:272`), cursor toggle (`:329-330`), stream visibility (`:378-379`), launch-at-login (`:355-356`); MindTab custom model (`:199-201`) |
| 18 | Onboarding incl. modes slide | DONE | `Onboarding.tsx:27,48` registers the `modes` step; `ModesStep` at `:563-600` covers dictation hotkey, always-on, and `zapi agent` |
| 19 | Tray menu (modes checkboxes + play-demo) | DONE | `rebuildTrayMenu` in `src/main/index.ts:765-791` (always-on/dictation/agent checkboxes + `Play ink demo` via `playDemoScene`) |
| 20 | Stream window | DONE | Factory `windows.ts:174-214` (transparent, draggable, bounds persistence); lazy lifecycle `index.ts:906-979`; live feed `StreamApp.tsx` |
| 21 | Launch-at-login | DONE | `setLoginItemSettings({ openAtLogin })` in `companion-manager.ts:399-403`, applied at boot `index.ts:329`; toggle `GeneralTab.tsx:355-356` |
| 22 | Custom model field | DONE | `customOpenAIModel` setting (`types.ts:411`), IPC + setter (`index.ts:589`, `companion-manager.ts:305-306`), input in `MindTab.tsx:199-201`, honored at `:1305` |
| 23 | Cursor toggle vs ink visibility | DONE | `TOGGLE_CURSOR` (`types.ts:521`) → `GeneralTab.tsx:329-330`; overlay hides only cursor chrome while ink/echoes/pills keep rendering (`OverlayApp.tsx:228-232,892`) |

## GAPS

**Functional gaps: 0.** Every checklist item is implemented end-to-end.

Non-functional naming leftovers (intentional, do not touch without a migration plan):
- `window.flicky` bridge name, `FlickySettings`/`FlickyAPI` type names, `isClickyCursorEnabled` setting key — renaming breaks the preload contract and stored settings.
- `flicky-chat-history.json` on disk and `--flicky-display-info=` launch-arg prefix — renaming orphans existing user data / breaks the numeric-only display-info constraint.
- `package.json` publish `repo: "flicky"` — still points at the live releases repo.
