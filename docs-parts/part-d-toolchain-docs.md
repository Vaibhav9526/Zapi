# Part D — Toolchain, Verification Suite, Docs and the Marketing Site

> Scope of this part: the build and config surface of `D:\projects\Zapi_clone`
> (`package.json`, the three tsconfigs, Vite, ESLint, Vercel, git config, GitHub
> Actions), the `scripts/` verification suite and its three Electron preload
> stubs, the existing prose documentation, the `landing/` Next.js marketing site,
> and a Windows getting-started path.
>
> Every claim below was read out of the tree. Line counts are from
> `Get-Content <file> | Measure-Object -Line`. Where a checked-in document
> disagrees with the source, the disagreement is called out in
> [§7 Contradictions](#7-contradictions-found-in-the-existing-docs).

---

## Table of contents

1. [Build and config](#1-build-and-config)
   - [1.1 `package.json`](#11-packagejson-scripts-dependencies-and-the-electron-builder-block)
   - [1.2 Dependencies, and what each is for](#12-dependencies-and-what-each-is-for)
   - [1.3 Why there are two lockfiles](#13-why-there-are-two-lockfiles)
   - [1.4 The three tsconfigs](#14-the-three-tsconfigs)
   - [1.5 `vite.config.ts`](#15-viteconfigts)
   - [1.6 `eslint.config.js` vs `.eslintrc.json`](#16-eslintconfigjs-vs-eslintrcjson)
   - [1.7 `vercel.json` and the landing deploy gate](#17-verceljson-and-the-landing-deploy-gate)
   - [1.8 `.gitignore` and `.gitattributes`](#18-gitignore-and-gitattributes)
   - [1.9 `.github/workflows/build.yml`](#19-githubworkflowsbuildyml)
   - [1.10 Other root config worth knowing about](#110-other-root-config-worth-knowing-about)
2. [The verification suite in `scripts/`](#2-the-verification-suite-in-scripts)
   - [2.1 `dev-verify.mts` — the one-shot gate](#21-dev-verifymts--the-one-shot-gate)
   - [2.2 `PRELOAD_FOR` — binding a script to an Electron stub](#22-preload_for--binding-a-script-to-an-electron-stub)
   - [2.3 Filename-suffix auto-discovery](#23-filename-suffix-auto-discovery)
   - [2.4 Complete inventory of every file in `scripts/`](#24-complete-inventory-of-every-file-in-scripts)
3. [The three preload stubs](#3-the-three-preload-stubs)
4. [Existing documentation](#4-existing-documentation)
5. [The `landing/` marketing site](#5-the-landing-marketing-site)
6. [Getting started on Windows](#6-getting-started-on-windows)
7. [Contradictions found in the existing docs](#7-contradictions-found-in-the-existing-docs)

---

## 1. Build and config

### 1.1 `package.json` — scripts, dependencies and the electron-builder block

`package.json` is 113 lines. Identity fields: `name: "zapi"`, `version: "1.2.1"`,
`license: MIT`, `main: "dist/main/main/index.js"`. The `main` path is not
arbitrary — `tsconfig.main.json` sets `rootDir: "src"` and `outDir: "dist/main"`,
so `src/main/index.ts` emits to `dist/main/main/index.js`.

**Every script in the file, verbatim:**

| Script | Command | What it actually does |
|---|---|---|
| `dev` | `concurrently "npm run dev:main" "npm run dev:renderer"` | Runs the two dev processes side by side. Note it re-enters `npm run`, not `bun run`. |
| `dev:main` | `tsc -p tsconfig.main.json --watch` | Incremental type-check/emit of main + preload + shared. |
| `dev:renderer` | `vite dev` | Vite dev server for `src/renderer` (port 5173, see `vite.config.ts`). |
| `build` | `npm run build:main && npm run build:renderer` | The full production build. |
| `build:main` | `tsc -p tsconfig.main.json` | Emits CommonJS to `dist/main`. |
| `build:renderer` | `vite build` | Emits the three renderer bundles to `dist/renderer`. |
| `start` | `VITE_DEV_SERVER=1 electron dist/main/main/index.js` | Launches the built main process against the **live** Vite dev server. |
| `start:prod` | `electron dist/main/main/index.js` | Launches the built main process against the **built** renderer in `dist/renderer`. |
| `lint` | `eslint src --ext .ts,.tsx` | ESLint over `src`. |
| `typecheck` | `tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json --noEmit` | Both projects, no emit. The root `tsconfig.json` is never type-checked directly — see §1.4. |
| `package` | `npm run build && electron-builder` | Build + installer for the current platform. |
| `package:win` | `npm run build && electron-builder --win` | Windows NSIS installer. |
| `package:mac` | `npm run build && electron-builder --mac` | macOS dmg + zip, universal-ish (x64 + arm64). |
| `package:linux` | `npm run build && electron-builder --linux` | AppImage + deb. |
| `postinstall` | `electron-builder install-app-deps` | Rebuilds native deps (nut-js) against the local Electron ABI. |

**`postinstall` matters more than it looks.** `@nut-tree-fork/nut-js` is a native
module; without `install-app-deps` it would be built for whatever Node happens to
be installed rather than for Electron's ABI, and the agent loop would fail at
`require` time rather than at build time.

**The `build` (electron-builder) block**, all keys present in the file:

- `appId: com.zapi.app`, `productName: ZAPI`, `directories.output: release`,
  `directories.buildResources: assets`, and `files: ["dist/**/*", "assets/**/*"]`
  — the installer ships the compiled output plus the icon/tray assets and
  nothing else.
- `mac`: productivity category, `assets/icon.icns`, dmg + zip for `x64` and
  `arm64`, `hardenedRuntime: true`, `gatekeeperAssess: false`,
  `notarize: true`, entitlements from `assets/entitlements.mac.plist`, and
  `NSMicrophoneUsageDescription` / `NSScreenCaptureUsageDescription` usage
  strings.
- `win`: `assets/icon.ico`, `publisherName: ZAPI`,
  `artifactName: ZAPI-Setup-${version}.${ext}`, nsis target for `x64` + `arm64`.
- `nsis`: `oneClick: false` (assisted installer), `perMachine: false`
  (per-user install — no admin needed), `allowToChangeInstallationDirectory: true`,
  desktop + start-menu shortcuts, `shortcutName: ZAPI`.
- `linux`: `assets/icons` directory icon, `AppImage` + `deb`, `Utility` category.
- `publish`: `provider: github`, `owner: jvaught01`, `repo: flicky`. **This is
  upstream-Flicky leftover, not ZAPI** — see §7.

### 1.2 Dependencies, and what each is for

**`dependencies` (2) — shipped in the packaged app:**

| Package | Version | Why it is there |
|---|---|---|
| `@nut-tree-fork/nut-js` | `^4.2.6` | The only way the app touches the real mouse, keyboard and screen. `src/main/services/agent-driver.ts` lazy-imports it and executes `[ACT:*]` actions through it; `src/main/services/auto-typer.ts` uses it for `[TYPE:]` tags and dictation auto-type. A **native** module, hence `postinstall: electron-builder install-app-deps`. |
| `posthog-node` | `^4.0.0` | Anonymous product analytics from `src/main/services/analytics.ts` (lazy-loaded). |

**`devDependencies` (16):**

| Package | Version | Why it is there |
|---|---|---|
| `electron` | `^33.0.0` | The shell. Provides `app`, `BrowserWindow`, `ipcMain`, `globalShortcut`, `desktopCapturer`, `safeStorage`, `screen`, `clipboard`, `shell`, `systemPreferences`. |
| `electron-builder` | `^25.0.0` | Installer generation + `install-app-deps` native rebuild. |
| `@electron/notarize` | `^2.5.0` | macOS notarization, driven by `mac.notarize: true`. |
| `typescript` | `^5.7.0` | Compiles main (CommonJS) and type-checks renderer. |
| `vite` | `^6.0.0` | Renderer bundler and dev server. |
| `vite-plugin-electron` | `^0.28.0` | Declared but **not referenced** — `vite.config.ts` imports only `defineConfig`, `@vitejs/plugin-react` and `path`. Dead dependency. |
| `@vitejs/plugin-react` | `^4.3.0` | React Fast Refresh + JSX transform for the renderer. |
| `react` / `react-dom` | `^19.0.0` | The panel, overlay and stream window UIs. |
| `@types/react` / `@types/react-dom` | `^19.0.0` | React type definitions for the renderer project. |
| `concurrently` | `^9.0.0` | Backs the `dev` script's two-process fan-out. |
| `eslint` | `^9.0.0` | Linter. Note: `eslint.config.js` also `require`s `@eslint/eslintrc`, `@eslint/js` and `globals`, none of which are declared in `package.json` — they resolve only as transitive deps. |
| `@typescript-eslint/parser` | `^8.0.0` | TS/TSX parsing for ESLint. |
| `@typescript-eslint/eslint-plugin` | `^8.0.0` | The `plugin:@typescript-eslint/recommended` rule set. |

### 1.3 Why there are two lockfiles

Both `bun.lock` (157 KB) and `package-lock.json` (150 KB) are **tracked in git**,
and `landing/` has its own third one (`landing/bun.lock`).

- `bun.lock` — bun's text lockfile, `"lockfileVersion": 1`, `"configVersion": 0`,
  with a `workspaces` block mirroring `package.json`.
- `package-lock.json` — npm's lockfile, `"lockfileVersion": 3`, `packages`-keyed,
  and stamped with the same `"version": "1.2.1"`.

There is no comment in the repo explaining the duplication. The evidence says
this is a **mid-flight migration from npm to bun that never finished**:

- CI (`.github/workflows/build.yml`) uses `oven-sh/setup-bun@v2` and
  `bun install --frozen-lockfile` — so `bun.lock` is the lockfile CI treats as
  authoritative.
- `dev-verify.mts` spawns `bun --preload <stub> scripts/<file>` for the
  Electron-stubbed scripts and `bunx tsx scripts/<file>` for the rest — bun is
  load-bearing for the test suite, not just for installing.
- But `dev-verify.mts` also runs its final step as `npm run lint`, and every
  `package.json` script body chains through `npm run <other-script>` rather than
  `bun run`. So npm is still on the critical path.

Practical consequence: **`bun.lock` is the one CI enforces.** Run
`bun install --frozen-lockfile` to reproduce CI exactly; `npm install` will
happily drift against `package-lock.json` and nothing will notice. If you
regenerate one, regenerate both or neither.

`landing/` keeps only `bun.lock` — the marketing site is fully bun-native.

### 1.4 The three tsconfigs

There are three, in a project-references arrangement. `tsconfig.json` (17 lines)
is the shared base and declares no `include`, so it compiles nothing on its own —
it exists to be `extends`-ed.

**`tsconfig.json`** — the base every other file inherits:

- `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`.
- `isolatedModules: true` (Vite/Rollup needs it), `jsx: react-jsx` (the automatic
  runtime, which is why `react/jsx-runtime` is a `manualChunks` entry).
- `baseUrl: "."` with `paths: { "@shared/*": ["src/shared/*"] }` — the shared
  contract alias.
- `references` to `./tsconfig.main.json` and `./tsconfig.renderer.json`.

**`tsconfig.main.json`** (12 lines) — the Electron main process:

- Overrides `module: CommonJS` and `moduleResolution: node`. This override is
  required: Electron's main process is CommonJS, while the base is ESM.
- `rootDir: "src"`, `outDir: "dist/main"`, `declaration: false`.
- `include: ["src/main/**/*", "src/shared/**/*", "src/preload/**/*"]`.
- **The preload is compiled by this project, not the renderer one** — that is why
  `dist/main/main/index.js` has the doubled path and why the preload ships as
  CommonJS. The renderer never gets to see `src/preload`.

**`tsconfig.renderer.json`** (8 lines) — the three browser windows:

- Inherits ESM/bundler resolution and `react-jsx`; sets
  `outDir: "dist/renderer"`, `rootDir: "src"`.
- `include: ["src/renderer/**/*", "src/shared/**/*"]` — no `src/main`, no
  `src/preload`. This is the boundary that stops Node/Electron code from leaking
  into a `contextIsolation: true` renderer.

Consequence worth knowing: `npm run typecheck` checks the two leaf projects only.
The base `tsconfig.json` is never `--noEmit`-checked on its own, and
`src/preload/index.ts` is type-checked as part of the *main* project.

### 1.5 `vite.config.ts`

47 lines. `root: 'src/renderer'` and `base: './'` — the renderer is built out of a
subfolder and loaded from disk, so asset URLs must be relative.

- **Three explicit Rollup inputs**: `panel.html`, `overlay.html`, `stream.html`
  under `src/renderer`. These are the three independent windows `windows.ts`
  creates.
- **`manualChunks: { react: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] }`**
  with an inline comment giving the reason: all three entries pull React, and
  without a shared chunk the installer ships React three times.
- `resolve.alias['@shared'] → src/shared`, matching the tsconfig `paths` so the
  editor and the bundler agree.
- A load-bearing comment records a fixed bug: `process.platform` used to be
  inlined at build time, which leaked the **build host's** platform into the
  renderer (a macOS dmg built on Linux shipped `linux` to the renderer).
  Renderers now read `window.flicky.platform`, exposed by the preload at runtime.
- `server.port: 5173` — the port `npm run start` assumes via
  `VITE_DEV_SERVER=1`.
- `html.cspNonce: undefined` and `build.crossOriginLoading: false` are both
  explicit no-ops that keep the defaults visible at the call site.

### 1.6 `eslint.config.js` vs `.eslintrc.json`

Two ESLint configs coexist — the ESLint v9 flat-config migration, deliberately
done in a way that keeps both files true at once.

- **`.eslintrc.json`** (legacy, 489 bytes): `root: true`,
  `parser: @typescript-eslint/parser`, `plugins: ["@typescript-eslint"]`,
  `extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"]`,
  `parserOptions: { ecmaVersion: 2022, sourceType: "module" }`,
  `env: { node: true, browser: true }`, and two rules:
  `no-unused-vars` as `warn` with `argsIgnorePattern: "^_"`, and
  `no-explicit-any` as `warn`.
- **`eslint.config.js`** (60 lines): the ESLint v9 flat config. Its header states
  the design contract — *".eslintrc.json is preserved verbatim as the single
  source of truth for rules; this file re-expresses it through FlatCompat so
  both formats stay in sync during the migration window."*

Three things `eslint.config.js` does that the legacy file cannot:

1. `ignores: ['node_modules/**', 'dist/**', 'release/**', 'landing/**',
   'design-mockups/**']` — flat config has no implicit directory exclusions, and
   this is what keeps the Next.js site and the mockups out of the Electron lint.
2. It maps the `FlatCompat`-expanded `extends` onto `files: ['**/*.ts', '**/*.tsx']`,
   with a comment explaining why: flat config applies to *every* file by default,
   whereas the old `eslint src --ext .ts,.tsx` invocation never linted plain
   `.js`. Without this, `src/renderer/audio-capture-worklet.js` would be linted
   and its browser-worklet globals would trip `no-undef`.
3. It re-declares `languageOptions.globals` from the `globals` package
   (`...globals.node, ...globals.browser`) to reproduce the legacy
   `env: { node, browser }`.

`--ext` is gone in ESLint v9; the file's comment notes the `lint` script still
passes it and that ESLint v9 tolerates it for a directory target. File selection
is genuinely done by the `files` patterns.

### 1.7 `vercel.json` and the landing deploy gate

`vercel.json` is 2 lines and identical in content at the repo root and in
`landing/`:

```json
{ "ignoreCommand": "git diff HEAD^ HEAD --name-only | grep -q '^landing/' && exit 1 || exit 0" }
```

This is a **"skip the deploy" gate, not a build config.** Vercel runs
`ignoreCommand` on each push; exit 1 means "do not deploy". So any commit whose
diff touches `landing/` suppresses the Vercel build. Combined with the
`output: 'export'` static-export mode in `next.config.mjs`, the intended flow is
that the marketing site deploys from its own pipeline (or is built by hand), and
Vercel is deliberately not rebuilt for landing-only changes.

Note it is a `grep`-based POSIX one-liner — it will not behave as intended on a
Windows shell that does not have `grep` on `PATH`.

### 1.8 `.gitignore` and `.gitattributes`

**`.gitignore`** (466 bytes) — build/dep output (`node_modules/`, `dist/`,
`release/`, `nul`), secrets (`*.env`, `.env.*`, `*.local`), OS noise
(`.DS_Store`, `Thumbs.db`), `*.log`, then two documented groups of *process*
exclusions:

- "Local-only files — never commit": `CLAUDE.md`, `.changelog/`, `run.bat`,
  `setup.bat`, `REVIEW*.md`, `AUDIT*.md`, `REPORT.md`, `FEATURES.md`,
  `PROBLEM.md`.
- "Fleet working docs — live in the tree for workers, not in repo":
  `docs/PLAN-*.md`, `docs/*-AUDIT.md`, `docs/*-SURVEY.md`, `docs/PROMPT-*.md`,
  `docs/CLICKY-SKILLS.md`, `docs/FEATURE-ADOPTION.md`, `docs/VOICE-TESTS.md`,
  `scripts/*-report.md`.

This is the single most important thing to understand about `docs/`: the audit /
review / plan corpus is **deliberately untracked**, which is why `docs/INDEX.md`
links so much that does not exist on disk (§7).

Two gaps: `.tmp-parse-test.ts` is a committed scratch file that is *not* ignored
(§7), and `docs-parts/` (this document's folder) is not ignored either.

**`.gitattributes`** (227 bytes), three rules:

- `* text=auto` — let Git normalize line endings.
- `*.sh text eol=lf` — the inline comment gives the reason: CRLF produces
  `\r: command not found` in bash. This protects `scripts/sprint-start.sh`.
- `.claude/skills/*.md text eol=lf` — LF for the Claude Code skill files.

### 1.9 `.github/workflows/build.yml`

One workflow, `Build & Release`, 156 lines, `permissions: contents: write`, with
`concurrency` cancelling in-progress runs per ref. Triggers: push to `master`,
tags `v*`, PRs into `master`, and `workflow_dispatch`. **Note `master` — the
repo's actual working branch is `main`** (see §7).

Three jobs in a chain:

**`verify`** (`ubuntu-latest`, single platform on purpose — "a correctness gate,
not a build matrix"): `actions/checkout@v4` → `oven-sh/setup-bun@v2` (latest) →
`bun install --frozen-lockfile` → `bunx tsx scripts/dev-verify.mts`. The comment
explains that `bun scripts/dev-verify.mts` also works but `bunx tsx` is used so
the child steps share one loader. No electron-builder, no secrets, so fork PRs
run it.

**`build`** (`needs: verify`, matrix macos/windows/ubuntu, `fail-fast: false`) —
packaging only starts once the gate is green. Per platform: checkout → setup-bun
→ frozen install → (mac only) `apple-actions/import-codesign-certs@v3` gated on a
`HAS_MAC_SIGNING` env var computed from `secrets.CSC_LINK != ''`, plus
`security find-identity` probe → `bun run typecheck` → `bun run build` →
`bunx electron-builder --<platform> --publish always|never`, where `always` only
on `refs/tags/v*`. Signing secrets in scope: `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and
`CSC_IDENTITY_AUTO_DISCOVERY` set *from* `HAS_MAC_SIGNING` so a fork with no cert
falls back to an unsigned build instead of trying to match an ad-hoc identity.
Artifacts (`ZAPI-<platform>-setup`) are uploaded for `*.dmg *.zip *.exe
*.AppImage *.deb`.

**`release`** (`if: startsWith(github.ref, 'refs/tags/v')`, `needs: build`,
ubuntu) — downloads the artifacts merged into one directory and creates the
GitHub Release with `softprops/action-gh-release@v2` and
`generate_release_notes: true`.

**Gap worth knowing:** the workflow's `publish` owner/repo is not configured
here, so `electron-builder`'s `publish.provider: github` block in `package.json`
(`jvaught01/flicky`) is what would receive the release — see §7.

### 1.10 Other root config worth knowing about

- **`.claude/settings.json`** — `{"skills": {"paths": [".claude/skills"]}}`.
  Four skill files live there: `commit-msg.md`, `merge-flow.md`,
  `new-branch.md`, `sprint-align.md`. These are agent workflow config, not
  project documentation, and `docs/INDEX.md` explicitly excludes them.
- **`assets/`** — the icon set `make-ico.mjs` regenerates: `zapi-icon.svg`
  (vector source), `icon.ico` (256/48/32/16, used by both the Windows tray and
  `build.win.icon`), `icon.icns` (referenced by `build.mac.icon`), `icon.png`
  (512 master), `tray-icon.png` (32 px) and `tray-icon@2x.png` (64 px),
  an `icons/` directory (16–512 PNG set for `build.linux.icon`), and
  `entitlements.mac.plist`.
- **`design-mockups/`** — one file, and it is lint-ignored.
- **`.tmp-parse-test.ts`** — a committed scratch file, not ignored, importing a
  symbol that no longer exists (§7).
- **`src/` shape** (for cross-reference with `AGENTS.md`): `src/main/` holds
  `companion-manager.ts`, `index.ts`, `windows.ts`; `src/main/services/` holds 28
  modules; `src/shared/` holds `types.ts` and `vision-models.ts`.

---

## 2. The verification suite in `scripts/`

`scripts/` is a flat directory — **40 files, no subdirectories**. The task brief
called it 36; that number counts only the runnable scripts (40 minus the 3
preload stubs and `dev-verify.mts` itself). Both numbers are reconciled in §2.4.

Two house rules appear in nearly every script header and are worth knowing before
you add one:

1. A script that needs an Electron stub **must print SKIP and exit 0** under any
   other runner — the repeated justification is that "a skipped test must never
   masquerade as PASS."
2. Comments explain *why*, in the same spirit as `AGENTS.md`. Several headers
   record a specific bug that produced the test.

### 2.1 `dev-verify.mts` — the one-shot gate

118 lines, and the only script you normally run. Its header enumerates the order:

1. `bunx tsc -p tsconfig.main.json --noEmit`
2. `bunx tsc -p tsconfig.renderer.json --noEmit`
3. every discovered test script, sorted
4. `npm run lint` — **report-only**

**Exit-code convention.** The header and the last line agree, and the code
(`process.exit(Math.min(counted, 1))`) is what actually runs. `counted` is the
number of `FAIL` results **excluding** report-only steps. So:

- 0 real failures → exit `0`
- 1 real failure → exit `1`
- 7 real failures → still exit `1`, not `7`

CI only needs a boolean, and a capped code keeps a green run at `0`. `SKIP`s
never affect the exit code. The summary line prints
`total: N passed, M failed, K skipped`, plus a parenthesised
`(R report-only failures not counted)` clause **only when R > 0** — so
"lint failed" appears in the output without turning the run red.

**Step construction.** All steps are built eagerly in one array literal
(`const results: StepResult[] = [...]`), so typechecks, every discovered test and
lint run in sequence and a failure does not abort the rest — you get the full
picture in one run, not just the first error.

**Failure output is truncated to 8 lines** (`out.split('\n').slice(-8)`), and the
summary prints only the first line of that tail. For a compile error that means
you see the *last* 8 lines, which is usually where the "Found N errors" line and
the tail of the error list live, not the first file. Pass `--noEmit` output
through your editor's tsc for full detail.

### 2.2 `PRELOAD_FOR` — binding a script to an Electron stub

```ts
const PRELOAD_FOR: Array<[RegExp, string]> = [
  [/(?:agent-abort|open-action-smoke)\.mts$/,        './scripts/agent-stub-preload.ts'],
  [/(?:selfsettings|speak-fallback)-smoke\.mts$/,    './scripts/companion-stub-preload.ts'],
  [/(?:store|chat|keystore|routines|artifact|suggestion|suggestion-parse|workspace|fish)-smoke\.mts$/,
                                                       './scripts/store-preload.ts'],
];
```

`preloadFor(file)` walks the list in order and returns the first matching stub, or
`null`. The mapping is **purely filename-based** — no test declares its own
preload; the gate owns the table.

`smokeStep()` only consults it if a *second* condition holds. It first reads the
script's source and tests `/-preload\.ts/.test(content)` — i.e. "does this
script's own text mention a `*-preload.ts` file?" Only then does it look up
`PRELOAD_FOR`. So adding a new stubbed test requires **two** edits: name the
stub in the script's header comment, and add a `PRELOAD_FOR` row. Miss the row
and the script is launched under plain `bunx tsx`, self-reports SKIP, and exits 0
— a green run with a silently untested file. Miss the header mention and the
lookup is skipped entirely, same outcome.

The two `build.module` vs `onResolve` notes in the stubs (§3) are the reason this
table exists in the shape it does.

### 2.3 Filename-suffix auto-discovery

`discoverTests()` reads `scripts/` and keeps a file if it ends with any of:

| Suffix | Matches today |
|---|---|
| `-smoke.mts` | `artifact`, `chat`, `endpoint`, `fish`, `focused-app`, `keystore`, `lease`, `open-action`, `parse`, `routines`, `selfsettings`, `speak-fallback`, `store`, `suggestion-parse`, `suggestion`, `workspace` |
| `-check.mts` | `glass`, `hotkey-suspend`, `ink`, `preload`, `prompt`, `sfx`, `shape` |
| `-abort.mts` | `agent-abort` |
| `-response.mts` | `golden-response` |
| exactly `scene-pipeline.mts` | one hard-coded exception, listed by literal name because it predates the convention |

Result is `.sort()`ed, so the run order is alphabetical and stable.

**This is the "new test scripts run free" property.** Name a file
`whatever-smoke.mts` and it is in the gate on the next run — no registry to
edit, no list in `AGENTS.md` to keep in sync. The flip side is that the
classification is *derived from the filename*, which is exactly why the
manual/auto split below had to be verified against `dev-verify.mts` rather than
trusted.

### 2.4 Complete inventory of every file in `scripts/`

40 files. Line counts are exact. **"Auto" means the filename matches a
`discoverTests()` rule; "Manual" means it cannot be discovered** — either the
suffix is wrong, the extension is not `.mts`, or it is a stub / the gate itself.
The auto/manual column was derived by applying the four suffix rules and the one
literal exception from `dev-verify.mts` to the real directory listing, not from
any document.

| File | Lines | Class | Covers |
|---|---:|---|---|
| `agent-abort.mts` | 307 | Auto (`-abort`) | `runAgentActions` abort mid-batch (resolves, stops early, reports the remainder as skipped, returns far sooner than an unaborted batch); the 30-action per-batch cap; `onAction` firing for pointer kinds only (move/click/dclick/rclick/drag) and never for type/key/scroll/wait; the `onLeaseWait` true-then-exactly-one-false contract. |
| `agent-dryrun.mts` | 51 | Manual | Dry-run proof of `agent-driver.ts`: a deliberately inert action batch (nudge cursor +80 px, move back, wait, done) exercising the lazy nut-js load, the display-space → physical `scaleFactor` scaling, and executed/failed reporting — without clicking or typing. Exits 1 if nut-js is missing or any action fails. |
| `agent-stub-preload.ts` | 126 | Manual (stub) | Bun preload stubbing `electron` + `@nut-tree-fork/nut-js` with recorders. See §3. |
| `artifact-smoke.mts` | 375 | Auto | `sanitizeFilename` (path traversal collapses to last segment, slashes stripped, dotfiles un-hidden, Windows device names prefixed); `writeArtifact` staying inside `artifactsDir` for hostile names, verbatim content, `name-2` instead of overwrite; `list` newest-first / per-agent / merged / capped at 200; `byId` cross-agent + copy semantics + null for unknown; `inferKind` csv→sheet, md→doc, png→image, ts→code, unknown→other; malformed seeded rows filtered and re-sorted. |
| `chat-helper.mts` | 57 | Manual (helper) | Fresh-process child worker for `chat-smoke.mts` (the store has a module-level cache + debounce, so each seed needs a cold import). `$CHAT_MODE` selects `read` / `read-agent` / `append` / `append-plain` / `markread`; prints one JSON line. |
| `chat-smoke.mts` | 256 | Auto | `chat-history-store.ts`: legacy file with no `kind` field still loads (back-compat); `append` with `kind: 'agent'` persists through flush + fresh-process read; the post-rebrand filename is `zapi-chats.json`; corrupt JSON recovers to `[]`; read flags — appended entries carry `read:false` and `markRead` flips only the named agent's entries (the per-agent unread dot contract). |
| `companion-stub-preload.ts` | 141 | Manual (stub) | Bun preload stubbing `electron` + nut-js for a real `CompanionManager`. See §3. |
| `dev-verify.mts` | 118 | Manual (the gate) | The aggregate verifier — see §2.1–2.3. |
| `endpoint-smoke.mts` | 60 | Auto | OpenAI-compatible endpoint resolution in `ollama-api.ts`: ClinePass needs provider/model ids (`openai/gpt-5`) while `api.openai.com` wants bare ids, and a pasted `/v1/chat/completions` must collapse to its base before `/v1/...` is appended. Covers `normalizeBase`, `resolveModelId`, `isReasoningCapableModel`. Pure strings, no preload. |
| `fish-smoke.mts` | 335 | Auto | Fish Audio free-tier model header: the `model` header on every TTS request, the `s2.1-pro-free` default, header change when a paid model is picked, unknown value coerced back to free and repaired on disk, the same header on the key-validation probe, and repair of a hand-edited junk model at load. `fetch` is replaced with a recorder — no network, no audio. |
| `flicky-sweep.mts` | 144 | Manual | Rebrand straggler sweep. Walks the repo (skipping `node_modules`, `dist`, `release`, `landing`, `.git`, and the rebrand-about documents), buckets every case-insensitive `flicky` as `[INTENTIONAL]` (frozen `FlickySettings`/`FlickyAPI` contracts, the `FLICKY_DISABLE_GPU` env var, wake-word mishear aliases, the `window.flicky` bridge key) or `[STRAY]`, and **exits 1 on any STRAY**. Report-only: it never edits anything. |
| `focused-app-smoke.mts` | 140 | Auto | Focused-app guide injection: `active-window.ts`'s `foregroundWindowTitle()` Win32 probe, the process→guide map, and `focusedAppContext()` (probe + map + guide read, all failure paths → null); plus `prompts.ts`'s `buildSystemPrompt` injecting a `Focused app: <name>` section into the **agent** prompt only. Degrades to null off Windows, so no preload needed. |
| `gen-sfx.mts` | 151 | Manual | **Generator, not a test.** Synthesises the four overlay chimes (`agent-launch`, `agent-done`, `agent-needs-you`, `heard`) as sine stacks with fast attack + exponential decay into 16-bit PCM mono 44.1 kHz WAV under `src/renderer/assets/sfx/`. Filenames are the `IPC.PLAY_SFX` contract. Deterministic and idempotent — same bytes every run. |
| `glass-check.mts` | 120 | Auto | The glass/acrylic wave must survive into the **built** bundle, not just source: at least one emitted CSS asset in `dist/renderer` carries `backdrop-filter`, and `dist/main`'s compiled `windows` bundle keeps **both** branches of the `backgroundMaterial` conditional (`'acrylic'` + the `PANEL_FALLBACK_BG` fallback) so non-Windows-11 still works. Has an **mtime gate**: if `dist` is older than the sources it claims to contain, affected checks report SKIP rather than passing on a stale artifact. |
| `golden-response.mts` | 285 | Auto | Feeds a full canned model response (prose + every draw-cue kind + several `[ACT:]` tags) through the real parsers and pretty-prints the beat table (cue kind, label, target display, display-space coords), the tag-stripped speech text, and the agent action list. Each scenario declares the cue kinds / actions it expects, so a parser regression fails the run. Accepts an optional scenario-name argument. |
| `hotkey-suspend-check.mts` | 148 | Auto | Static check that `SUSPEND_PUSH_TO_TALK_SHORTCUT` silences **both** hotkeys: locates the `ipcMain.on(IPC.SUSPEND_PUSH_TO_TALK_SHORTCUT, …)` registration in `src/main/index.ts`, resolves the handler body (named function or inline arrow), and asserts `globalShortcut.unregister` is called for a PTT-ish *and* a dictation-ish binding. Three outcomes: both unregistered → PASS/0; only PTT → `[FINDING]`/0 (appended under `AUDIT.md`'s `## FOR-OWNER` section — a file that is gitignored and absent); no handler at all → FAIL/1. |
| `ink-check.mts` | 319 | Auto | Headless math from the real `src/renderer/components/inkMath.ts` (imported, so it cannot drift): per-display culling including boundary straddles, stroke-budget live/excess slicing order, arrow-head geometry, Catmull-Rom smoothing pass-through, write-wrap invariants, wobble determinism. |
| `keystore-smoke.mts` | 128 | Auto | `key-store.ts`: `enc` mode set/get/delete/status roundtrip with the on-disk blob carrying `enc:` and never the plaintext; `'fishaudio'` flowing through `KEY_NAMES` into `getKeyStatus`; a no-encryption host (`ZAPI_SMOKE_NO_ENC=1`) writing a `plain:` blob that still roundtrips; an `enc:` blob read with the credential store gone returning `null` (honest failure, never a wrong key); legacy untagged base64 still decoding; `set('')` deleting the entry. |
| `lease-smoke.mts` | 182 | Auto | `input-lease.ts`: FIFO order (a acquires, b and c queue, release promotes in order); `onQueued` seeing `true` + position while waiting and `false` on grant; `holder()` / `queueLength()`; acquire timeout rejecting behind a stuck holder; `AbortSignal` cancelling a queued wait; idempotent release (double-release must not skip the queue); `leaseWaitPhase` status-card ordering (queued→`waiting`, grant→back to `acting`, abort-while-queued→no emit). |
| `make-ico.mjs` | 290 | Manual | **Generator, not a test.** Pure-Node rasterizer (superellipse SDF, point-in-poly, 4A supersampling) + `zlib` PNG encoder + ICO/ICNS packers. Writes `assets/zapi-icon.svg`, `assets/icon.ico` (256/48/32/16), `assets/icons/<N>x<N>.png` (16–512), `assets/icon.png` (512), `assets/tray-icon.png` (32), `assets/tray-icon@2x.png` (64) and `assets/icon.icns` — the exact set `package.json` and `src/main` reference. No native modules, no network. |
| `open-action-smoke.mts` | 217 | Auto | The `[ACT:open:target]` action — the only one that hands a model-authored string to a process launcher. Pins both halves: the target is validated (shell metachars rejected) *before* reaching `execFile`, and the launch is the documented `cmd /d /s /c start "" <target>` argv, never a shell string; and `open` is **lease-free** — a pure-open batch completes while another agent holds the global input lease, proven with the real `input-lease` module. Its header records a hard-won stub trick: `child_process` and nut-js are CJS, so their export objects are patched via `createRequire` *before* the driver module evaluates, because `plugin build.module` cannot intercept `node:*` or an installed package's dynamic import — an earlier attempt ran **real** `cmd start` calls. |
| `parse-smoke.mts` | 834 | Auto | The tag DSL in `element-detector.ts`, and the largest script in the suite: `parseScene`, `parseAgentActions`, `extractAgentTask`, `looksLikeCommand`, `parseTypeTags`, `parseFileTags`, `parseMemos`, `stripFileBlocks`, `TAG_STRIP_REGEX`. |
| `preload-check.mts` | 501 | Auto | The static preload↔IPC contract, without running Electron: (1) every channel in `src/preload/index.ts` is an `IPC.*` / `AUDIO_IPC.*` const or an allow-listed raw string; (2) every `IPC.SET_*` key is sent by at least one preload method; (3) every `ipcMain.on/handle` in `src/main/index.ts` resolves to `IPC`/`AUDIO_IPC`; (4) every `onXxx` listener in preload has emitter evidence; (5) companion callbacks in `companion-manager.ts` are all wired in `index.ts` and vice versa (informational); (6) every raw channel is declared in `KNOWN_RAW` and every `KNOWN_RAW` entry is used; (7) the artifacts / suggestions / read-flags / typed-turn channels are wired by name — method + verb + IPC key — so a dropped preload method is a FAIL, not just a finding. |
| `prompt-check.mts` | 106 | Auto | Contract check for `prompts.ts`, "the third leg of the tag DSL" after `shared/types.ts` and `element-detector.ts`. Pins `BASE_PROMPT`'s must-point rule ("names anything the user can see → you MUST point"), the POINT→TYPE ordering and per-step pointing rules, `AGENT_PROMPT`'s point-before-click hint, and `buildSystemPrompt` composition (mode swap, app-guide injection, web-search note, tone). Pure string checks. |
| `routines-smoke.mts` | 187 | Auto | `routines.ts` + settings-store routine CRUD. Drives `RoutineScheduler.tick()` with an **injected clock** (no timers, deterministic): interval cadence, daily next-HH:MM including tomorrow rollover, disabled routines, `markRun` persistence through the real store, and `reload()` picking up edits. |
| `scene-pipeline.mts` | 110 | Auto (literal) | `parseScene` + `parseAgentActions` against a fake **2-display** capture set (primary 1920×1080 @ x=0 → shot 960×540; secondary 2560×1440 @ x=1920 → shot 1280×720, both 2× downscale). Asserts cue ORDER (tag order is replay order), per-cue `screenIndex`, display-space coordinate mapping (scale + display origin), and that step/total numbering applies to `point` cues only. |
| `seed-suggestions.mts` | 121 | Manual | **Dev tool.** Plants three sample `Suggestion` cards into the real `zapi-suggestions.json` so the panel UI can be eyeballed with no model call. Flags: `--clear`, `--agent <id>`, `--user-data <path>`. Replicates the store's on-disk shape (`{ "<agentId>": Suggestion[] }`, newest-first, ≤200/agent) rather than importing the store, which needs `app`. Target dir resolution: `--user-data` → `$ZAPI_SEED_USERDATA` → `$ZAPI_SMOKE_USERDATA` → first existing of `%APPDATA%\ZAPI`, `%APPDATA%\zapi`, `%APPDATA%\ZAPI`. Idempotent — `seed-`-prefixed rows are replaced on re-run. |
| `selfsettings-smoke.mts` | 429 | Auto | The voice self-settings parser in `companion-manager.ts` (private `applyVoiceSelfSetting` + the `<8`-word gate in `processUserText`). Because the method is `private` but reachable at runtime, the test drives a **real** `CompanionManager` through its real entry point. Fire cases (speed / mute / listen → right setter + value + spoken confirmation line) and normalization (wake-word lead, case, `my`/`the` variants). `desktopCapturer → []` makes a non-trigger transcript exit via the can't-see-your-screen bail *before* any model call, so "fell through" is observable with zero network. |
| `settings-parity.mts` | 314 | Manual | Settings contract across the four files that define it, using a brace-matching (comment/string-aware) source reader rather than a real TS AST: (1) `StoredSettings` ↔ `FlickySettings` field-name parity both ways; (2) defaults coverage of every non-optional `StoredSettings` field; (3) every `IPC.SET_*` channel wired to a handler in `src/main/index.ts`; (4) every preload `setXxx` maps to an existing IPC channel. **Inverted exit convention:** findings are the point, so drift is reported as `FAIL` lines and exits **0**; a non-zero exit means the *script itself* could not do its job (a file went missing, a declaration could not be parsed). |
| `sfx-check.mts` | 78 | Auto | Presence + WAV header check for the overlay chimes in `src/renderer/assets/sfx/` (not `assets/`, which holds app icons). Every `IPC.PLAY_SFX` name main emits has a wav on disk and vice versa, each ≤44 KB with a well-formed RIFF/WAVE/PCM header — a missing or truncated file is a silent failure at demo time. |
| `shape-check.mts` | 96 | Auto | Static JSON shape invariants for the canonical IPC payloads: `Scene`, `AgentStatus`, `AgentPhase`, `UsageStats`. Round-trips each through `JSON` (and `structuredClone` for `Scene`) and asserts every field survives, catching `undefined` vs missing, `NaN`, `Map`s and class instances before they cross IPC. Type-only imports, so runner-agnostic. |
| `size-report.mts` | 109 | Manual | Bundle size report. **Runs `bun run build` internally**, then tabulates the main entry, preload, per-window renderer bundles (panel / overlay / stream js+css) plus shared chunks, flags any file > **500 KB** (`OVER_KB = 500`), totals `dist`, and counts packaged `assets/` files (electron-builder ships `dist/**` + `assets/**`). Exit 1 only when the build itself fails — oversize is a flag, not a failure. Because it builds internally, do not chain it after `bun run build`. |
| `speak-fallback-smoke.mts` | 292 | Auto | The TTS OS-voice fallback in `companion-manager.ts`: when the configured provider can't speak (missing key, thrown error such as Fish Audio's 402 "insufficient credit", or a null synthesis) the reply goes to `callbacks.onSpeakText(text, rate)`, which `index.ts` wires 1:1 to `sendToOverlays(IPC.SPEAK_TEXT, …)`. Those callback args **are** the IPC payload, so asserting them asserts the wire contract. Cases: missing key → emit with tag-stripped text + `voiceSpeed` rate; provider throws / returns null → same emit (both providers); audio returned → no emit; `speakReplies` off / empty-after-strip text → no emit; the "system voice" cue fires once per session not per turn; `speakLine` drives the same emit end to end. |
| `sprint-start.sh` | 37 | Manual | **Shell tool, not a test.** Pre-sprint alignment check: `bash scripts/sprint-start.sh [sprint-branch] [base-branch]`, defaulting to the current branch vs `master`. Fetches the base (warns and continues on failure), then prints `ALIGNED`/exit 0 if the base has no commits the sprint branch lacks, or `DIVERGED`/exit 1 with the commit list and `git diff --stat`. The one file the `*.sh text eol=lf` rule in `.gitattributes` exists for. |
| `store-preload.ts` | 52 | Manual (stub) | The narrowest Electron stub: `app.getPath('userData')` (throws for any other path name) plus a deterministic `safeStorage` (`0x01` + utf8 ciphertext). See §3. |
| `store-read-helper.mts` | 15 | Manual (helper) | Fresh-process reader for `store-smoke.mts`, so `getAll()` / `getStats()` exercise the real disk reload path (`readDisk` + defaults merge) rather than the in-memory cache. Prints one JSON line `{ settings, usage }`. |
| `store-smoke.mts` | 300 | Auto | `settings-store.ts` + `usage-store.ts`: settings roundtrip from a partial seed file through the defaults merge on load, `set()` of every newer field (`ttsProvider`, `fishVoiceId`, `alwaysOnEnabled`, `dictationEnabled`, `dictationShortcut`, `agentEnabled`, `agentMaxSteps`, `customOpenAIModel`), a raw-disk assertion, and a fresh-process reload via `store-read-helper.mts`; plus usage **month rollover** — a fake past-month file then `recordTalkTurn()` and the counters reset into the current-month bucket. |
| `suggestion-parse-smoke.mts` | 594 | Auto | Second suggestion suite, split differently from its sibling: the **engine** cases (prompt build, JSON salvage, `generateSuggestions`) are pure and run anywhere; the **store** cases need the Electron stub and SKIP unless `$ZAPI_SMOKE_USERDATA` is already set. Its header contains a typo in the run line — it says `suggestion-parse-smts.mts` where the file is `suggestion-parse-smoke.mts`. |
| `suggestion-smoke.mts` | 260 | Auto | `suggestion-engine.ts` + `suggestion-store.ts`, with a different split: the engine cases run under any runner, the store cases print SKIP and exit 0 under anything but `bun --preload ./scripts/store-preload.ts`. Covers `parseSuggestionJson` tolerance (fenced blocks, prose-wrapped arrays, bare arrays, a lone object, trailing commas, smart quotes, alias keys, junk items dropped, cap honoured, `agentId` always re-pinned); `generateSuggestions` (agents with no history skipped, per-agent completion failures swallowed, abort signal honoured); `summarizeChats` / `buildSuggestionPrompt` (open-loop detection and prompt shape); and the store (add/list hides dismissed, dismiss permanence via `listAll`, per-agent isolation, scoped clear, malformed disk rows dropped). |
| `workspace-smoke.mts` | 361 | Auto | `agent-workspace.ts` — the per-agent folder (`AGENTS.md` + `output/` + `tmp/`) and its memory lifecycle, plus the `[MEMO:]` parser that feeds it and the artifact store's new write location. `ensureWorkspace` scaffolding idempotently and never clobbering an existing memory file; `readMemory` (empty when absent, full when small, line-aligned cap); `appendMemo` (dated bullet under `## Notes`, dedupe, single-line coercion, 40-line pruning oldest-first, header/other-section preservation, no-throw on junk); `parseMemos` (1–6 per response, dedupe, FILE-block bodies ignored); and `writeArtifact` landing in the workspace `output/` dir while the legacy `artifacts/` dir is left alone and legacy rows still resolve. |

**Totals: 40 files — 26 auto-discovered, 14 not discovered.**

The 14 non-discovered files are: `dev-verify.mts` (the gate),
`agent-stub-preload.ts`, `store-preload.ts`, `companion-stub-preload.ts` (the 3
stubs), `chat-helper.mts` and `store-read-helper.mts` (child-process helpers only
meaningful to their parents), `flicky-sweep.mts`, `settings-parity.mts`,
`size-report.mts`, `agent-dryrun.mts`, `gen-sfx.mts`, `seed-suggestions.mts`,
`make-ico.mjs` and `sprint-start.sh`.

**Correction to the brief's manual-only list.** The brief listed 20 files as
manual-only. Verified against `discoverTests()`, **11 of those 20 are in fact
auto-discovered** and run in every `dev-verify` pass:
`prompt-check.mts` (`-check.mts`), `glass-check.mts` (`-check.mts`),
`sfx-check.mts` (`-check.mts`), `endpoint-smoke.mts` (`-smoke.mts`),
`focused-app-smoke.mts` (`-smoke.mts`), `open-action-smoke.mts` (`-smoke.mts`),
`selfsettings-smoke.mts` (`-smoke.mts`), `speak-fallback-smoke.mts`
(`-smoke.mts`), `fish-smoke.mts` (`-smoke.mts`) and `workspace-smoke.mts`
(`-smoke.mts`). The brief's list also omitted the 3 preload stubs, the 2 child
helpers and `dev-verify.mts` itself. Its 10 genuinely-manual entries
(`flicky-sweep`, `settings-parity`, `size-report`, `agent-dryrun`, `make-ico`,
`gen-sfx`, `seed-suggestions`, `sprint-start`, `chat-helper`,
`store-read-helper`) are all correct.

---

## 3. The three preload stubs

All three exist for the same root reason, stated verbatim in
`store-preload.ts`: the store modules do `import { app } from 'electron'` and call
`app.getPath('userData')`, and **outside Electron that module does not exist**.
`agent-driver.ts` is worse — it reaches the real desktop two ways (`import *
from 'electron'` for display bounds, and a *dynamic* `import('@nut-tree-fork/nut-js')`
for mouse and keyboard, which on a dev machine is a real native module). A live
`mouse.move` would hijack the developer's actual cursor and a live `pressKey`
would type into whatever window is focused.

All three use `import { plugin } from 'bun'` and `build.module(...)` with
`loader: 'object'` — so they are **Bun-only**. Under `tsx`/node they are never
loaded, which is why every bun-only test self-reports SKIP and exits 0.

`build.module` is used rather than `onResolve` deliberately. The comment in
`agent-stub-preload.ts` records the reason: *Bun keeps resolving an installed
package from disk even through `onResolve`* — verified experimentally, an
`onResolve` attempt left the real `@nut-tree-fork/nut-js` in place.

| Stub | Lines | What it fakes | Bound scripts |
|---|---:|---|---|
| `store-preload.ts` | 52 | The narrowest: `app.getPath` (throws for any name other than `userData`, and requires `$ZAPI_SMOKE_USERDATA`) plus a **deterministic** `safeStorage` — ciphertext is `0x01` + utf8 bytes, and `decryptString` throws on anything it did not produce, so legacy/corrupt-blob code paths are genuinely exercised. `ZAPI_SMOKE_NO_ENC=1` simulates a host with no credential store at all. | the 10 `store`-family smokes: `store`, `chat`, `keystore`, `routines`, `artifact`, `suggestion`, `suggestion-parse`, `workspace`, `fish` (+ `chat-helper.mts`, `store-read-helper.mts` run under it manually) |
| `agent-stub-preload.ts` | 126 | `electron` (`screen.getAllDisplays`/`getDisplayNearestPoint`/`getPrimaryDisplay` → one fake 1920×1080 display, id 7, scale 1; `getCursorScreenPoint` → 960,540; `systemPreferences.isTrustedAccessibilityClient` → true) **and** a full nut-js recorder. Exports `nutCalls` and mirrors it onto `globalThis.__nutCalls`; on stub failure it stashes `__agentStubError` instead of throwing, so the test reports a clean FAIL rather than crashing. `nutKeyStub()` mirrors the ~60 `Key.*` names as strings because `mapKey()` only reads them. | `agent-abort.mts`, `open-action-smoke.mts` |
| `companion-stub-preload.ts` | 141 | A **superset** of `store-preload.ts` plus what a real `CompanionManager` needs: `desktopCapturer.getSources → []` (the load-bearing extra — a turn that survives the self-settings/parser gates then bails in the normal talk path on an empty screenshot list, *before* any provider call, which is what lets the test observe "fell through" with zero network); inert `clipboard` (with a `clipboardWrites` recorder, asserted on when a case lands in the dictation branch by mistake), `screen`, `shell`, `systemPreferences`; `app.getVersion` → `0.0.0-smoke` and `app.setLoginItemSettings`; and the same nut-js recorder as insurance that a regression reaching `typeText` can never type into the focused window. | `selfsettings-smoke.mts`, `speak-fallback-smoke.mts` |

`agent-stub-preload.ts` and `companion-stub-preload.ts` differ in one small way
worth noting: the agent stub builds a full `Key` name map (the driver's
`mapKey()` needs it), while the companion stub ships `Key: {}` — nothing in the
companion path maps keys.

---

## 4. Existing documentation

Five prose documents plus one folder. Line counts from the tree.

### `README.md` — 74 lines, user-facing

Attribution chain first (Clicky by Farza → Flicky by jvaught01 → ZAPI, with
explicit credit back to Farza), then a "What ZAPI does" feature list (talk,
dictation, on-screen drawing, agent computer control, multiple named agents, file
deliverables, Mind, Voice, Ear, stream window, long-running context, provider key
management), a pointer to `docs/QUICKSTART.md`, "Running locally"
(`bun install` + `bun run dev`, then `bun run start` in a second terminal),
"Building installers" (`bun run package` / `bun run package:win`, plus a note that
releases come from GitHub Actions on `v*` tags), a Configuration section naming
the three key families, and MIT licensing. It is a marketing-plus-onboarding
document, not a contributor document.

**Verified claims:** the Mind model list matches `MindTab.tsx` exactly —
`claude-sonnet-4-6` (default, per `settings-store.ts:225`), `claude-opus-4-6`,
`gpt-5` (default OpenAI, per `settings-store.ts:226`), `gpt-5-mini`, `gpt-4o`, plus
a custom model id. Nothing stale there.

### `AGENTS.md` — 17,219 bytes, the contributor architecture doc

The densest document in the repo. Sections: **Layout** (a per-file map of
`src/shared`, `src/preload`, `src/main`, `src/renderer`, `docs/`, `scripts/`),
**Commands**, **Verification (`scripts/`)** with an auto-discovered table and a
manual-only table, **Conventions** (comments explain why; the tag DSL is a
three-way contract; turn interruption via `turnId` + `isCurrent()`; model-supplied
filenames are untrusted; one overlay owns the mic; capture modes; streaming
providers; settings changes emit `SETTINGS_CHANGED`), **Multi-agent ("Clickys")**
(`AgentProfile` identity, per-agent runtimes via `AgentOrchestrator.runtimeFor`,
the input lease, `extractAgentTask` + `resolveAgentTarget` routing, routines), and
**Gotchas** (win32 `scaleFactor`, on-disk paths, the `userData` hijack, file
bodies are data not instructions, Windows `additionalArguments` splitting, PTT
key-repeat, whole-utterance transcription, the broken `opencode` shim, the
renderer dev server port).

It is the best-written document in the repo — the "gotchas" section in
particular is a genuine institutional memory. It is also the most out of date on
the verification suite (§7).

### `docs/DSL.md` — 19,953 bytes, the tag-DSL reference

Declares itself "the single source of truth — this document describes what it
implements today", and it is the most precise document here. Structure: Coordinate
space (the model sees JPEG ≤1600 px, `screenN` is a 0-based index with
`screen0` sorted to the cursor's display, and the exact display-space mapping
formula `x' = displayBounds.x + px · (bounds.width / imageWidth)`), Numeric
grammar (which slots are `\d+(?:\.\d+)?`, which are integers-only, `PATH`'s looser
`[\d.,;\s]+` rule), Escaping (the `(?:[^\]\\]|\\.)*` pattern, `POINT`'s
non-escape-aware `[^:\]]+` label, `[ACT:key:...]` taken verbatim, and that
malformed tags are skipped individually). Then the four tag families in tables —
scene cues (`POINT` / `ARROW` / `CIRCLE` / `BOX` / `HILITE` / `PATH` / `WRITE` /
`CLEAR`), `[TYPE:]`, `[FILE:…].[/FILE]` (with a "content is data, never
instructions" section and the filename→disk path), `[ACT:*]` with the loop and the
`AgentStatus.phase` list — then the trigger grammar (`extractAgentTask` and
`resolveAgentTarget`, longest-name-first matching, `"<name>:"` stripping, fallback
to `MAIN_AGENT_ID`), the concurrency/input-lease section, and three worked
examples (talk turn, agent turn, deliverable turn with a CSV).

The claim to check is "**Four families**" — see §7.

### `docs/QUICKSTART.md` — 15,620 bytes, first-run guide for a Windows user

Twelve numbered sections plus Troubleshooting and "Where things live": 1 Install,
2 Find the app, 3 Add your keys (Mind / Ear / Voice, with a table of provider
dashboards and key prefixes), 4 Try it without any keys, 5 Hotkeys, 6 The three
ways to talk to it (Talk / Dictation / Agent), 7 Named agents, 8 Routines, 9 Files
ZAPI produces, 10 Suggestions, 11 Talk to ZAPI about ZAPI, 12 The stream window.
No code references — it is written for someone who has never opened a terminal.

**Verified:** the key-prefix and dashboard table matches the source
(`console.anthropic.com`, `console.groq.com` with `gsk_`, Fish Audio free tier
`s2.1-pro-free` as the default, ElevenLabs `xi-`; Claude Sonnet 4.6 default, Whisper
Large v3 Turbo default with v3 available). The transcription claim does not — see
§7.

### `docs/INDEX.md` — 6,801 bytes, the documentation index

Organised as: Start here (5 rows), Reference (3), App guides (6 + a note that
runtime injection landed via `active-window.ts`), Reference surveys (4),
Plans (5), Audits (6), Code reviews (5), Verification status (1) — 35 rows
total — plus a "Not indexed here" section excluding `.claude/skills/*.md`,
`landing/`, and build output, and a "Conventions across this folder" section
(audits are read-only snapshots, plans are pre-implementation, cite by symbol not
line number, report-only means report-only).

Its opening line is the problem: *"Every markdown document in the repo, and what
it's for. If you're looking for something and it isn't here, it doesn't exist."*
On disk today, only 3 of its 35 rows resolve. See §7.

### `docs/app-guides/` — 6 files, agent-facing

`README.md` (index + three cross-app rules + how to add a guide), `explorer.md`,
`vscode.md`, `chrome.md`, `excel.md`, `settings.md`. Written for a vision +
mouse/keyboard agent, not a human — e.g. the Settings guide is a `ms-settings:`
URI table instead of sidebar-clicking instructions. These are injected at runtime
as the `Focused app: <name>` section (see `focused-app-smoke.mts`). This is the
**only** part of `docs/INDEX.md`'s index that is fully intact.

---

## 5. The `landing/` marketing site

A self-contained Next.js 16 app in `landing/`, excluded from the root ESLint run,
excluded from the root Vite build, and deployed separately. **It shares no code
with the Electron app** — the relationship is conceptual (it markets ZAPI) plus
one deliberate visual echo (below).

**`landing/package.json`** — name `zapi-landing`, version `0.1.0`, `private: true`.
Four scripts, all pinned to **port 3030** so it never collides with the
Electron renderer's 5173: `dev: next dev -p 3030`, `build: next build`,
`start: next start -p 3030`, `lint: next lint`. Dependencies: `next ^16.2.3`,
`react` / `react-dom ^19.2.5`, and `vgpu ^0.5.0` (the GPU shader toolkit behind
the hero wordmark). Dev deps: `@types/node 22.10.5`, `@types/react 19.0.7`,
`@types/react-dom 19.0.3`, `typescript 5.7.3`. Its own `.gitignore`
(`node_modules`, `.next`, `out`, `*.tsbuildinfo`, `.env*.local`, `.DS_Store`),
its own `tsconfig.json`, and its own `bun.lock` — **no `package-lock.json`**, which
confirms the root's dual-lockfile state is a migration leftover rather than intent.

**`landing/next.config.mjs`** — `output: 'export'` (pure static export: "the
landing is pure content, so nothing here needs a server. Deploy anywhere that
serves static files"), `images: { unoptimized: true }` (required under static
export), a `turbopack.root` pinned to the `landing/` folder with the inline reason
— *"so Next 16 doesn't wander up the tree and pick up the outer Electron app's
lockfile"* — and a `turbopack.rules` / `webpack()` pair wiring `@vgpu/wgsl/loader-webpack`
for `*.wgsl` so the hero wordmark shader can import `@vgpu/wgsl-std` modules. Both
bundlers are configured because Turbopack is the Next 16 default and webpack is
still reachable.

**Routes (`landing/app/`)** — App Router, four pages plus a shared layout:

| Route | File | What it is |
|---|---|---|
| `/` | `page.tsx` (14,260 B) | The single-page site. Section anchors: `#top` (hero), `#how`, `#features`, `#pricing`, `#get` (with `#cta-win` / `#dl-windows`), `#faq`, and a `#demos` video block. |
| `/careers` | `careers/page.tsx` (3,833 B) | Open-roles page. `ROLES` currently lists one entry: "founding engineer — systems (rust/electron)". |
| `/changelog` | `changelog/page.tsx` (3,398 B) | Ship history from an `ENTRIES` array — currently `v1.1.0` (2026-09-18) and `v1.0.0`. |
| `/privacy` | `privacy/page.tsx` (3,837 B) | How ZAPI handles screen, keys and chats. |

All three secondary pages open with the same 25-line block: identical
`OG_TITLE` / `OG_DESC` constants, a `Metadata` export with matching
OpenGraph + Twitter `summary_large_image` cards, and the same
`DesktopIcons` + `Taskbar` + `Win` + `Mark` + `TextFileIcon` chrome — so the
careers/changelog/privacy pages are visually indistinguishable from sub-pages of
the desktop metaphor.

`layout.tsx` sets the page title ("zapi — an ai buddy that lives on your pc"),
light/dark `viewport.themeColor` pairs, and mounts `<FlickyCursor />` above
`{children}`. It also inlines a pre-paint theme script (via
`dangerouslySetInnerHTML`) that reads `localStorage` under `zapi-theme` **or**
`flicky-theme` and otherwise follows `prefers-color-scheme`, so the palette is
correct on first paint with no flash.

**Components (`landing/app/components/`, 13 files):**

| Component | Bytes | What it does |
|---|---:|---|
| `FlickyCursor.tsx` | 2,055 | **The link to the desktop app.** A page-wide companion cursor that trails the real mouse at a hard-coded `+14px / +8px` offset — its comment states this "mirrors the real Flicky overlay … the same +14px / +8px offset the desktop app uses". `pointer-events` off, `aria-hidden`, and it bails entirely on `matchMedia('(hover: hover) and (pointer: fine)')` failures. Position writes are `requestAnimationFrame`-coalesced, and the cleanup cancels the pending frame. |
| `DesktopIcons.tsx` | 1,737 | The top-left desktop icon column, doubling as the section nav on wide screens (hidden under 1100 px, where the taskbar suffices). Seven icons: `zapi.exe`→`#top`, "how it works"→`#how`, "features"→`#features`, "pricing"→`#pricing`, "get zapi"→`#get`, "questions"→`#faq`, and "source.zip"→ an external repo link. Icons come from `Icons.tsx` (`FolderIcon`, `InstallerIcon`, `TextFileIcon`, `ZipIcon`). |
| `Clock.tsx` | 851 | Taskbar tray clock. Renders `--:--` / `--/--/----` placeholders until mounted so the static export and the first client render agree (hydration safety), then ticks every 30 s via `setInterval` and clears it on unmount. |
| `HeroClutter.tsx` | 2,558 | The desktop clutter behind the wordmark, `aria-hidden`: a sticky note ("press the hotkey / and just talk"), three kaomoji (`( ^ I% ^ )`, `A_\_(a°,_)/A_`, `{ ^-^ }`), a mini replica of the Zapi overlay with a "right here!" bubble, a recycle bin, `screenshot.png`, a Windows toast ("Zapi / Copied — press Ctrl+V to paste"), a fake walkthrough window with a `2/3 — click Continue` badge, and `chat-history.json`. Each element drifts with the mouse via `Parallax` and is hidden on narrow screens. |
| `HeroVideo.tsx` | 2,607 | A tabbed player in a `Win` window for the four demo clips: **talk** (`/demos/clicky-fl.mp4`), **see** (`/demos/clicky-spatial.mp4`), **draw** (`/demos/heyclicky-draw.mp4`), **agent** (`/demos/usecase.mp4`). Autoplays muted + looping; on `prefers-reduced-motion: reduce` it turns `controls` on, `loop` off and pauses — so the clip is still playable by request. Switching tabs re-`load()`s the element (`key={demo.src}` remounts it). |
| `Icons.tsx` | 6,873 | The inline SVG icon set (`FolderIcon`, `InstallerIcon`, `TextFileIcon`, `ZipIcon`, `RecycleIcon`, `ImageFileIcon`, `JsonFileIcon`, …). Largest component file. |
| `ShaderWordmark.tsx` | 10,870 | The WGSL hero wordmark — the reason `vgpu` is a runtime dependency and the reason `next.config.mjs` needs the `.wgsl` loader rule. |
| `Mockups.tsx` | 2,544 | `MockListen`, `MockSee`, `MockSpeak`, `MockPoint` — static product illustrations used in the feature sections. |
| `PointAt.tsx` | 4,012 | The pointing-cursor interaction demo, echoing the desktop app's core gesture. |
| `Mark.tsx` | 944 | The shared app mark, used by `FlickyCursor`, `DesktopIcons`, `HeroClutter` and the page chrome. |
| `Taskbar.tsx` | 1,721 | The Windows taskbar, hosting `Clock` and the theme toggle. |
| `ThemeToggle.tsx` | 2,765 | Light/dark switch writing the `zapi-theme` / `flicky-theme` localStorage key the layout script reads. |
| `Win.tsx` | 1,598 | The draggable-looking window chrome primitive (`title`, optional `flush`) reused by `HeroVideo` and all three sub-pages. |
| `Parallax.tsx` | 1,463 | The mouse-drift wrapper that gives `HeroClutter` its depth. |
| `wordmark.wgsl` | 4,781 | The shader source consumed via the `@vgpu/wgsl/loader-webpack` rule. |

**`landing/app/globals.css`** is 36,164 bytes — larger than every component
combined, and where the whole desktop metaphor (`.desk-icons`, `.clutter`,
`.tb-clock`, `.toast`, `.mini-win`, `.flicky-cursor`) is defined. `wgsl-env.d.ts`
declares the `*.wgsl` module type for TypeScript.

**`landing/public/`** is ~18.7 MB of media and is the reason the site is not in
git LFS: `ezgif-4d0919e059322ece.gif` (6.2 MB), `flicky-hero2-1776235182036.mp4`
(7.5 MB), and `public/demos/` with `clicky-fl.mp4` (880 KB),
`clicky-spatial.mp4` (355 KB), `heyclicky-draw.mp4` (3.9 MB) and
`usecase.mp4` (3.0 MB) — the four files `HeroVideo` references, three of which
still carry `clicky`/`heyclicky` filenames from the reference material. Plus
`favicon.svg`.

**How it relates to the Electron app:** three ways, none of them a code
dependency. (1) Conceptual — the site is the only public description of the
product. (2) Visual — `FlickyCursor` deliberately reuses the desktop app's
`+14 / +8` cursor offset, and the Windows-desktop metaphor (icons, taskbar, tray
clock, toast, recycle bin) is a rendering of the app's own overlay. (3)
Deployment — `landing/vercel.json` is byte-identical to the root one and skips
Vercel builds for landing-only diffs. Everything else is separate: separate
lockfile, separate toolchain, separate port, separate lint scope, and a
`tsconfig.json` of its own.

---

## 6. Getting started on Windows

Windows is the supported platform, and the toolchain is Windows-first
throughout (`%APPDATA%` store paths, `cmd /d /s /c start`, Win32
`foregroundWindowTitle`, `.ico` tray assets).

### 6.1 Hard prerequisites — and the two caveats

**Node 20+.** Required (`README.md`); `dev-verify.mts`, `vite.config.ts` and
`devin` all assume it. On the machine that produced this document, `node` is
**v22.16.0** and `npm` is present.

> ### ⚠️ Caveat 1 — bun is required but is **not installed** here
>
> `bun` is **not** on `PATH` on this machine (`Get-Command bun` returns nothing),
> and there is **no `node_modules/`** in either the repo root or `landing/`. That
> means `bun install`, `bun run dev`, `bun run build`, `bunx tsx` and
> `dev-verify.mts` **cannot be run on this machine as things stand** — the
> preload stubs, the Electron-stubbed smokes and the whole `dev-verify` gate
> depend on bun's `Bun.plugin` and on bun's `.mts` loader.
>
> Install bun first (`powershell -c "irm bun.sh/install.ps1 | iex"`, or
> `winget install --id Oven-sh.Bun`), then `bun install --frozen-lockfile` to
> match CI. Until then the practical fallback is `npm install` plus `npx tsx` for
> the pure scripts — but the 10 `store`-family smokes, `agent-abort.mts`,
> `open-action-smoke.mts`, `selfsettings-smoke.mts` and `speak-fallback-smoke.mts`
> will all SKIP-and-exit-0, so a green run there is **not** evidence they pass.
>
> Everything in this document was therefore established by **reading** the tree.
> No build, install or script was executed.

> ### ⚠️ Caveat 2 — the global `opencode` shim is broken here
>
> `AGENTS.md` records: **"`bun`-installed global `opencode` shim is broken on this
> machine — use `devin`."** On this machine `opencode` resolves to
> `C:\Users\Lenovo\AppData\Roaming\npm\opencode.ps1` (the npm-global shim, and it
> is the path this very session is running under), and `devin` is **not** on
> `PATH` via `Get-Command`. If you reach for the global `opencode` binary and it
> fails, reach for `devin` instead.

### 6.2 First run

```powershell
  # 1. prerequisites
  node --version          # expect v20 or newer
  # install bun if missing — see caveat 1

  # 2. dependencies (use --frozen-lockfile to reproduce CI exactly)
  cd D:\projects\Zapi_clone
  bun install --frozen-lockfile

  # 3. the gate — typecheck both projects, then all 26 auto-discovered tests
  bunx tsx scripts/dev-verify.mts
  #    -> "total: N passed, 0 failed, 0 skipped", exit 0

  # 4. dev servers (two processes)
  bun run dev             # or: npm run dev — both work; package.json chains npm internally

  # 5. in a SECOND terminal, once the servers are up
  bun run start           # VITE_DEV_SERVER=1 electron dist/main/main/index.js
```

(The block is indented purely so its shell comments cannot be mistaken for
Markdown headings by a naive `# ` scan; copy it as-is.)

Step 3 must be run *after* a successful `build:main` at least once, because step 5
launches `dist/main/main/index.js` rather than the TypeScript source. `dev:main`
is a `tsc --watch`, so it will have emitted by the time Vite is listening on 5173.

### 6.3 What to expect, and what to read when it breaks

- `dev-verify.mts` output is one `[PASS]`/`[FAIL]`/`[SKIP]` line per step, then a
  `total:` line. **Exit 0/1 only** — read the `total:` line for the real count.
- A `SKIP` almost always means "this script needs a bun preload and did not get
  one." Check the `PRELOAD_FOR` row and the script's own header mention (§2.2).
- `glass-check.mts` SKIPs when `dist/` is older than the sources it claims to
  contain. Fix with `bun run build`, not by ignoring it.
- The aggregate failure tail is truncated to the **last** 8 lines, so for
  typecheck failures re-run `bun run typecheck` directly for the full list.
- A green `lint` line does not mean lint passed if the summary mentions
  "report-only failure(s) not counted" — lint is report-only by design.

### 6.4 The verification loop, honestly

`scripts/dev-verify.mts` is the gate; `bunx tsx scripts/<name>.mts` is the loop
while you iterate. Read the top of the script you are about to run — the headers
carry the exact required runner, the preload stub, and the reason the test
exists. For anything that writes to disk, the smokes redirect `userData` to a
temp dir via `$ZAPI_SMOKE_USERDATA`, so they never touch your real
`%APPDATA%\ZAPI Companion`.

The three generators (`make-ico.mjs`, `gen-sfx.mts`, `seed-suggestions.mts`) are
the exception to "read-only verification": they write into `assets/` and
`src/renderer/assets/sfx/`. `gen-sfx.mts` and `make-ico.mjs` are deterministic and
idempotent; `seed-suggestions.mts` mutates your real `zapi-suggestions.json` (it
has `--clear`).

---

## 7. Contradictions found in the existing docs

Every item below was checked against the source. Ordered by how much it will cost
a new developer.

**1. `docs/INDEX.md` is almost entirely dead links, and claims completeness.**
Its first line is *"Every markdown document in the repo… If you're looking for
something and it isn't here, it doesn't exist."* In fact **3 of its 35 rows
resolve** (`README.md`, `AGENTS.md`, `QUICKSTART.md`, `DSL.md`, and the six
`app-guides/` files). The other ~30 point at files that do not exist:
`PROBLEM.md`, `FEATURES.md`, `AUDIT.md`, `AUDIT2.md`, `REVIEW.md`–`REVIEW5.md`,
`REPORT.md`, `scripts/verify-report.md`, `docs/FEATURE-ADOPTION.md`,
`docs/APP-GUIDES-SURVEY.md`, `docs/CLICKY-SKILLS.md`, `docs/PROMPT-GAP.md`,
`docs/SFX-SURVEY.md`, all five `docs/PLAN-*.md`, and the three `docs/*-AUDIT.md`.
The cause is `.gitignore`, which deliberately untracks `REVIEW*.md`, `AUDIT*.md`,
`REPORT.md`, `FEATURES.md`, `PROBLEM.md`, `docs/PLAN-*.md`, `docs/*-AUDIT.md`,
`docs/*-SURVEY.md`, `docs/CLICKY-SKILLS.md`, `docs/FEATURE-ADOPTION.md` and
`docs/VOICE-TESTS.md` — matching the git log entry
`fe4d0f9 chore: drop fleet working docs from repo`. `INDEX.md` was written before
that drop and never updated. Only the `app-guides/` section is intact.

**2. `AGENTS.md`'s verification tables are ~40% out of date.** Three specific
errors:

- It claims the gate reports *"19 passed, 0 failed, 0 skipped"*. With today's
  `discoverTests()` the gate runs 26 discovered scripts + 2 typechecks + 1
  report-only lint = **29 steps**.
- Its auto-discovered table lists 16 scripts and **omits 10 that are really
  discovered**: `endpoint-smoke`, `fish-smoke`, `focused-app-smoke`,
  `glass-check`, `open-action-smoke`, `prompt-check`, `selfsettings-smoke`,
  `sfx-check`, `speak-fallback-smoke`, `workspace-smoke`.
- It says *"the two `*-preload.ts` files stub electron"* and lists only
  `agent-abort → agent-stub-preload` and
  `store`/`chat`/`keystore`/`routines`/`artifact`/`suggestion → store-preload`.
  There are **three** stubs, and the real `PRELOAD_FOR` has 11 rows' worth of
  patterns: it also binds `open-action-smoke → agent-stub-preload`,
  `selfsettings-smoke` and `speak-fallback-smoke → companion-stub-preload`, and
  `suggestion-parse`/`workspace`/`fish` → `store-preload`. `companion-stub-preload.ts`
  is not mentioned in `AGENTS.md` at all.
- Its "Manual only" table lists 5 entries (correct as far as it goes) but omits
  4 more that are genuinely manual: `gen-sfx.mts`, `seed-suggestions.mts`,
  `sprint-start.sh`, `chat-helper.mts` / `store-read-helper.mts` (helpers).

**3. `docs/DSL.md` says "Four families" of tag; the source has five.**
`element-detector.ts` includes `MEMO` in `TAG_STRIP_REGEX` and exports
`parseMemos` (`MAX_MEMOS_PER_RESPONSE = 6`, `MAX_MEMO_CHARS = 200`,
`MEMO_TAG_REGEX = /\[MEMO:((?:[^\]\\]|\\.)*)\]/g`), and `workspace-smoke.mts`
tests the whole memo lifecycle end to end. `DSL.md` has exactly one incidental
mention of "MEMO" (in a file-path sentence) and no section for it. Since
`DSL.md` explicitly claims to be "the single source of truth" for the DSL, a
model prompt author following it will not know `[MEMO:]` exists.

**4. `docs/QUICKSTART.md` says Groq is the only transcription provider.**
> "**Groq Whisper is the only transcription provider for now.** ClinePass has no
> transcription endpoint…"

The source has two provider classes — `GroqWhisperProvider` and
`OpenAIWhisperProvider` — and `TranscriptionProviderType` is
`'groq' | 'openai' | 'native'`. `EarTab.tsx` branches on both
`settings.transcriptionProvider === 'groq'` and `=== 'openai'`, and
`AGENTS.md` correctly says "Groq / OpenAI Whisper". So `QUICKSTART.md` is the
stale one. (Separately, `'native'` has **no** implementing class in
`transcription.ts` — a dead union member that no code path can select.)

**5. The GitHub Actions workflow targets `master`; the branch is `main`.**
`build.yml` triggers on `push`/`pull_request` for `branches: [master]`, and
`sprint-start.sh` also defaults its base branch to `master`. `git branch
--show-current` reports **`main`**, and the log shows a
`Merge branch 'main' of https://github.com/Vaibhav9526/Zapi`. On a `main`-only
repo the `verify`/`build`/`release` chain never fires on a plain branch push —
only on `v*` tags and manual dispatch. Relatedly, `sprint-start.sh` would report
`DIVERGED` spuriously.

**6. `package.json` publishes to upstream Flicky's GitHub repo.**
`build.publish` is `{ provider: "github", owner: "jvaught01", repo: "flicky" }`.
The workflow does not override it, so on a `v*` tag `bunx electron-builder
--publish always` would try to release into `jvaught01/flicky` — not into
`Vaibhav9526/Zapi`, the repo the git log says this is. This is a rebrand straggler
that `flicky-sweep.mts` would flag as `[STRAY]` (it only allow-lists
`FlickySettings`/`FlickyAPI`/`FLICKY_DISABLE_GPU`/wake-word aliases/
`window.flicky`).

**7. `landing/README.md` and the landing metadata still point at a third,
different Flicky repo.** `landing/README.md` opens *"# Flicky landing page …
for [flicky](https://github.com/pango07/flicky)"*; `layout.tsx`'s
`openGraph.url` is `https://github.com/pango07/flicky`; and
`DesktopIcons.tsx` has `const REPO = 'https://github.com/pango07/flicky'` as its
"source.zip" href. That is neither `jvaught01/flicky` (upstream, per README) nor
`Vaibhav9526/Zapi` (this repo). The public download link on the marketing site
points at an unrelated repository.

**8. `landing/vercel.json` is identical to the root `vercel.json`, so the "skip
landing changes" gate never fires for landing changes.** Both files are byte-for-byte
the same `grep -q '^landing/'` command. The root one runs with the repo root as
cwd, where the diff paths *do* start with `landing/`, so the root gate works as
intended. But the copy inside `landing/` — where Vercel's root directory is
explicitly `landing` (per `landing/README.md`) — greps for `^landing/` against
paths that are already relative to `landing/`, so it can never match. Harmless
today (it just always builds), but it is a duplicated gate that is wrong in one
of its two locations.

**9. `landing/app/changelog/page.tsx` is two releases behind `package.json`.**
`ENTRIES` lists `v1.1.0` (2026-09-18) and `v1.0.0`; `package.json` is at
**`1.2.1`**. The public changelog has no entry for the current version.

**10. `.tmp-parse-test.ts` is a committed scratch file that cannot compile.**
It is tracked by git and is **not** in `.gitignore`, and it imports
`parseAllPointTags` from `./src/main/services/element-detector` — a symbol that
**no longer exists** (0 occurrences in the source). It is a leftover from the
`POINT`/`TYPE` era that predates the current cue grammar. A stray import in the
repo root that will confuse a new developer and that `bun run typecheck` will not
catch (it is outside both `include` lists).

**11. Two `eslint.config.js` requires are undeclared dependencies.**
`eslint.config.js` `require`s `@eslint/eslintrc`, `@eslint/js` and `globals`,
none of which appear in `package.json`. They resolve today only as transitive
dependencies of `eslint@^9`. A dependency bump can break `bun run lint` with
`MODULE_NOT_FOUND` and no manifest change to point at.

**12. `vite-plugin-electron` is a declared dependency that is never used.**
`vite.config.ts` imports only `defineConfig`, `@vitejs/plugin-react` and `path`.
`dev` is driven by `concurrently` + a separate `tsc --watch` + a separate
`electron dist/...` launch instead. The dependency is dead weight in
`bun.lock`.

**13. `AGENTS.md`'s source layout omits three real modules.** Its
`src/main/services/` listing does not mention **`active-window.ts`** (the
`foregroundWindowTitle` Win32 probe and the `focusedAppContext()` guide
injection — a whole feature, and one that `focused-app-smoke.mts` tests), nor
**`agent-workspace.ts`** (the per-agent `AGENTS.md`/`output/`/`tmp/` folder and
the memo lifecycle — tested by a 361-line smoke). `src/shared/` also holds
`vision-models.ts`, which `AGENTS.md` does not mention; it claims
`shared/types.ts` is the "single contract".

**14. `docs/QUICKSTART.md` §9 / `README.md` file-deliverables path vs.
`AGENTS.md`'s `artifacts/<agentId>/` claim.** `AGENTS.md` (and the artifact
smoke) describe `userData/artifacts/<agentId>/`, but `workspace-smoke.mts`
asserts that `writeArtifact` now lands in the **per-agent workspace `output/`
directory** and explicitly that "the legacy `artifacts/` dir is left alone and
legacy rows still resolve". `AGENTS.md` describes the legacy location as current.
`AGENTS.md` also does not mention the per-agent workspace at all, so a
contributor reading it will look for `artifacts/<agentId>/` first.

**15. `hotkey-suspend-check.mts` writes to a gitignored file that does not
exist.** Its "only PTT suspended" branch appends a `[FINDING]` under
`AUDIT.md`'s `## FOR-OWNER` section — but `AUDIT.md` is both absent and matched
by the `AUDIT*.md` line in `.gitignore`, so the finding is written nowhere. The
script still exits 0 by design (a sibling may be mid-edit), so a real
half-suspended-hotkey regression is reported to nowhere and the gate stays green.

**16. `suggestion-parse-smoke.mts`'s header documents a filename that does not
exist.** It instructs `bun scripts/suggestion-parse-smts.mts` where the file is
`suggestion-parse-smoke.mts`. Harmless (dev-verify invokes it by the real name)
but it will send a developer to a `no such file` error.

---

*Compiled by reading the tree only — no `bun install`, `bun run dev`,
`bun run build`, `bunx` or `scripts/` command was executed, because bun is not
installed on this machine. Script line counts from
`Get-Content <file> | Measure-Object -Line`; script count and auto/manual
classification from `scripts/dev-verify.mts`'s own `discoverTests()` rules applied
to the real directory listing.*
