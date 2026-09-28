# ZAPI dedupe follow-up — re-verify + package — task_098c177e7e26

Run window: 2026-09-28 23:24 → 23:26 (local). Verifier owns verification only;
no `src/**` edits were made.

**Outcome: ALL GREEN, packaged. No BLOCKED — the main wiring was already present
when I checked, so zero of the 3 permitted retries were needed.**

## Blocked-item check first (the point of this dispatch)

`IPC.OPEN_AGENT_WORKSPACE` + `IPC.PLAY_SFX` were already wired in main by the
time I grepped at 23:24:01, ~90s after the sibling's commit:

| Channel | main-side site | kind |
| --- | --- | --- |
| `open-agent-workspace` | `src/main/index.ts:891` | `ipcMain.on(IPC.OPEN_AGENT_WORKSPACE, (_e, { agentId }: { agentId?: string }) => { … })` |
| `play-sfx` | `src/main/index.ts:402` | `sendToOverlays(IPC.PLAY_SFX, 'agent-launch')` |
| | `src/main/index.ts:404` | `sendToOverlays(IPC.PLAY_SFX, 'agent-done')` |
| | `src/main/index.ts:406` | `sendToOverlays(IPC.PLAY_SFX, 'agent-needs-you')` |
| | `src/main/index.ts:458` | `onVadAccepted: () => sendToOverlays(IPC.PLAY_SFX, 'heard')` |

`src/main/index.ts` mtime 23:22:25, `src/main/companion-manager.ts` 23:21:34 —
both consistent with the wiring landing just before my check. Note the SFX
emitters are correctly routed through the existing `sendToOverlays` helper
(main → overlay direction), not broadcast to the panel, which matches the
"mic capture goes to exactly ONE overlay" style of discipline elsewhere in
`index.ts`. `play-sfx` is a broadcast send, which is the right shape for a UI
sound.

## Matrix — final state, first pass, no retries

| Step | Command | Result |
| --- | --- | --- |
| Blocked-item check | grep `OPEN_AGENT_WORKSPACE` / `PLAY_SFX` in `src/main` | **PRESENT** |
| Main typecheck | `bunx tsc -p tsconfig.main.json --noEmit` | **PASS** (exit 0) |
| Renderer typecheck | `bunx tsc -p tsconfig.renderer.json --noEmit` | **PASS** (exit 0) |
| Lint | `npm run lint` | **PASS** (exit 0, 0 errors 0 warnings) |
| Full verifier | `bunx tsx scripts/dev-verify.mts` | **PASS** — 21 passed, 0 failed, 0 skipped (exit 0) |
| Build | `bun run build` | **PASS** (tsc main + vite build, 783ms) |
| Package (nsis) | `npm run package:win` | **PASS** (exit 0) |

Retries used: **0 of 3**. The previous run's two preload-check findings are
closed — `bunx tsx scripts/preload-check.mts` is now **363 passed, 0 failed,
0 findings**.

## dev-verify breakdown (final, exit 0)

```
[PASS] tsc main
[PASS] tsc renderer
[PASS] bun  agent-abort.mts
[PASS] bun  artifact-smoke.mts
[PASS] bun  chat-smoke.mts
[PASS] tsx  golden-response.mts
[PASS] tsx  hotkey-suspend-check.mts
[PASS] tsx  ink-check.mts
[PASS] bun  keystore-smoke.mts
[PASS] tsx  lease-smoke.mts
[PASS] tsx  parse-smoke.mts
[PASS] tsx  preload-check.mts
[PASS] bun  routines-smoke.mts
[PASS] tsx  scene-pipeline.mts
[PASS] bun  selfsettings-smoke.mts
[PASS] tsx  shape-check.mts
[PASS] bun  store-smoke.mts
[PASS] bun  suggestion-parse-smoke.mts
[PASS] bun  suggestion-smoke.mts
[PASS] bun  workspace-smoke.mts
[PASS] lint (report-only)

total: 21 passed, 0 failed, 0 skipped
```

## Installer

```
release/ZAPI-Setup-1.2.1.exe          179139615 bytes   2026-09-28 23:26:02  <-- rebuilt today
release/ZAPI-Setup-1.2.1.exe.blockmap    180275 bytes   2026-09-28 23:26:05
release/latest.yml                                  337 bytes   2026-09-28 23:26:05
```

- `target=nsis archs=x64,arm64 oneClick=false perMachine=false`; both
  `release\win-unpacked` and `release\win-arm64-unpacked` refreshed.
- `latest.yml` self-consistent: `path: ZAPI-Setup-1.2.1.exe`,
  `size: 179139615`, matching the on-disk byte count, new sha512.
- Size grew 178755807 → 179139615 (+383808 bytes). The SFX payloads are inside
  the bundle, confirmed in the build output — `dist/renderer` now carries the
  four hashed wav assets totalling 216266 bytes:
  `agent-done-DdcMHknt.wav` 75014, `agent-launch-BCq_hrwB.wav` 61784,
  `agent-needs-you-Cr298FOQ.wav` 52964, `heard-B-1fFSku.wav` 26504. The
  remaining ~167 kB of growth is the workspaces/memory and MEMO-tag work plus
  installer metadata churn.
- Signing skipped on every binary (`cscInfo=null`, `signHook=false`) — unsigned
  local build, unchanged from prior runs. electron-builder still warns
  `win.publisherName` is deprecated in favour of
  `win.signtoolOptions.<field_name>` (`package.json:85`); cosmetic.

## Correction to my previous report

`task_cadf964390b0`'s report claimed the orphaned
`release/ZAPI Setup 1.2.1.exe.blockmap` (179976 bytes, mtime 16:57:12) was
gone. **That was wrong** — I inferred it from a `*.exe`-only listing and never
re-checked blockmaps. It is still present, confirmed here at 16:57:12. Its
installer counterpart was deleted, so the blockmap is an orphan with nothing
referencing it and can be deleted. No impact on the shipped artifact:
`artifactName` is `ZAPI-Setup-${version}.${ext}`, so only the hyphenated name is
produced and published.

## What is left

Nothing blocking. The adoption wave is verified green at 21/21 and the 1.2.1
nsis installer is rebuilt and current, now including the workspace, memory,
MEMO, SFX, contentProtection and glass-CSS work.

Optional follow-ups, all cosmetic and none gating a release:
- delete the orphaned `release/ZAPI Setup 1.2.1.exe.blockmap`
- move `publisherName` under `win.signtoolOptions`
- set up code signing before any public release
