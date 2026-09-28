# Onboarding & first-run audit

Date: 2026-09-28. **Report-only - no source file was modified by this pass.**
The only file written is this document.

> **Tree state (read this before trusting a line number).** Two files were being edited by
> another process *while* this audit ran: `src/main/companion-manager.ts` (rewritten 10:17:29
> local) and `src/main/index.ts` (rewritten 10:19:18 local). Every citation was re-derived
> against the tree as of 10:20 local, and the checks in section 5 were re-run afterwards -
> the *logic* at every cited site is unchanged, only line numbers moved (+12 and ~+41
> respectively). If a number looks stale, anchor on the named function/field in the prose
> (`playDemoScene`, `stopMicTest`, `PTT_TEST_EXPIRY_MS`, `setPttTestMode`, ...). Citations
> use a bare `file.ts:line` shorthand for the file named in the surrounding bullet.

Scope (read end-to-end, plus the callers and the paths each claim depends on):

- `src/renderer/components/panel/Onboarding.tsx` (all 10 steps, 921 lines)
- callers: `src/renderer/components/PanelApp.tsx`, `src/renderer/panel.tsx`,
  `src/main/index.ts` (IPC wiring, tray, PTT handler, window lifecycle),
  `src/preload/index.ts`, `src/shared/types.ts`, `src/main/services/settings-store.ts`,
  `src/main/services/analytics.ts`
- mic/always-on path: `src/main/companion-manager.ts` (mic-test, VAD, capture modes),
  `src/renderer/components/OverlayApp.tsx` (capture gate + VAD + scene render),
  `src/renderer/components/InkLayer.tsx` (scene drawing),
  `src/main/services/audio-capture.ts`, `src/main/windows.ts`
- demo-scene path: `CompanionManager.playDemoScene` / `buildDemoScene` / `startScene`,
  the `onScene` / `onSceneCue` callbacks in `src/main/index.ts`, `InkLayer`, and the
  tray item that also triggers it.

Taxonomy used below:

- **[CRITICAL]** - guaranteed, user-visible defect with data/privacy/credit consequences.
- **[MAJOR]** - user-visible defect under a common sequence of actions.
- **[MINOR]** - latent risk, confusing state, or missing affordance (recoverable).
- **[NOTE]** - verified-correct behaviour worth keeping, or an informational trap.

---

## 1. Verdict summary

| # | Claim under test | Verdict | Strongest evidence |
|---|---|---|---|
| A | Demo scene plays **without API keys** | **PASS** | `companion-manager.ts:1069-1096` -> `:1027-1059` -> `index.ts:339-352` -> `InkLayer.tsx:262-288`; no provider is touched on the path (speech is only reachable from the turn pipeline, `companion-manager.ts:1420-1426`, `:1599-1605`, `:2024-2028`) |
| B | `onboardingComplete` is **set + respected** | **PASS** | set: `companion-manager.ts:580-583` -> `settings-store.ts:267-274` (atomic disk write); respected: `PanelApp.tsx:52-54`, and nothing else in main gates on it |
| C | **Replay works** | **PASS** | `GeneralTab.tsx:292-299` / `:387-394` -> `preload:248` -> `index.ts:800` -> `companion-manager.ts:585-589` -> `SETTINGS_CHANGED` -> `PanelApp` re-renders `<Onboarding>` from step 0 |
| D | **Mic test with always-on restores VAD** | **PASS (with caveats)** | `companion-manager.ts:994-1009` (stop + `'vad'` re-arm), mirrored by `index.ts:716-730`; `isRecording` / `'acting'` guards present |
| E | **No dead ends** | **PASS with 3 qualifications** | rail "Skip setup" (`Onboarding.tsx:87-93`) is reachable from every step; see F1, F4, F8 |

Claims A-C and the happy path of D follow from reading the code; E is a per-step
walk-through in section 4. No runtime Electron session is available in this environment,
so nothing here is a click-through result - section 5 lists what *was* executed.

---

## 2. Evidence chains

### A. Demo scene without API keys

1. Trigger (first completion): `index.ts:801-810` ->
   `setTimeout(() => companion.playDemoScene(), 800)`. Secondary trigger, not advertised
   to the user: the tray item "Play ink demo" (`index.ts:1176`, unconditional - it is
   in the menu rebuilt at boot).
2. `playDemoScene` (`companion-manager.ts:1069-1096`) - no key, no provider, no network:
   guards (`isRecording` / `pendingStart` / `voiceState !== 'idle'`),
   `screen.getPrimaryDisplay()` inside a try/catch, a fresh `turnId`, `clearSceneTimers()`,
   `onScene(null)` + `onSceneCue(null)` reset, then `setVoiceState('responding')` and
   `startScene(buildDemoScene(bounds), isCurrent, onDone)`.
3. `buildDemoScene` (`:1103-1134`) is fully canned: 6 cues - `arrow`, `box`, `write`,
   `circle`, `path`, `point` - anchored inside the primary display bounds via `px()/py()`,
   all `screenIndex: 0`.
4. `startScene` (`:1027-1059`) emits the cue list once (`callbacks.onScene`), then one beat
   index per cue on computed timers, then `onSceneCue(null)` + `onScene(null)` + `onDone`
   after `cursor + 4000 ms`. `onDone` runs only when `isCurrent()`, so a turn that
   supersedes the demo cannot have its state reset by the stale demo timer.
5. `index.ts:339-352` broadcasts the scene to **every** overlay and `:313-323` broadcasts
   beats; `OverlayApp.tsx:867-928` stores the cue list; `InkLayer.tsx:262-288` reveals
   `cues[0..beat]` cumulatively and culls cues outside the window's own bounds. Every kind
   the demo uses is rendered (`InkLayer.tsx:340-467`); `point` is deliberately skipped for
   ink (`:276`) and drives the cursor instead (`OverlayApp.tsx:909-928` -> `hopToScenePoint`).
6. Nothing on this path consults `apiKeyStatus`, `mindProvider` or a TTS provider.
   `setVoiceState('responding')` (step 2) only fans out (`index.ts:321-325`); speech
   synthesis is called exclusively from the turn pipeline
   (`companion-manager.ts:1420-1426`, `:1599-1605`, `:1840-1841`, `:2024-2028`),
   never from the state setter.

Derived timeline (from `dwellFor`, `:1031-1038`): arrow 1.1 s, box 1.1 s, write 2.0 s
(28 chars, capped), circle 1.1 s, path 1.1 s, point 3.32 s (19 chars) = ~9.7 s of drawing
plus the 4 s hold = **~13.7 s in `voiceState: 'responding'`** with no audio produced.

### B. `onboardingComplete` set + respected

- Field: `shared/types.ts:486` (FlickySettings), `settings-store.ts:169` (StoredSettings);
  default `false` in both (`types.ts:539`, `settings-store.ts:212`).
- Set: `companion-manager.ts:580-583` -> `settingsStore.set('onboardingComplete', true)`,
  which mutates the in-memory cache and writes `zapi-settings.json` atomically
  (`settings-store.ts:259-274`). `readDisk` merges the file over `DEFAULTS`
  (`:227-252`), so the flag survives a restart and a malformed/short file.
- Respected: `PanelApp.tsx:50-54` returns `<Onboarding>` while the flag is false and the
  normal shell after. It is the *only* gate - `onboardingComplete` appears in `src/main`
  just as the read inside the `COMPLETE_ONBOARDING` handler (`index.ts:805`) and the two
  setters. The tray, global shortcuts, always-on and the agent pipeline therefore stay
  live *behind* the wizard (relevant to F2/F3).
- Both transitions need no reload: `emitSettings()` (`companion-manager.ts:2142`) ->
  `onSettingsChanged` (`index.ts:387-393`) -> `SETTINGS_CHANGED` -> `PanelApp.tsx:26-33`.

### C. Replay works

1. Two entry points, both `window.flicky.replayOnboarding()`: `GeneralTab.tsx:297-299`
   (Setup section) and `:392-394` (Companion section, "Run setup again").
2. `preload/index.ts:248` -> `IPC.REPLAY_ONBOARDING` -> `index.ts:800` ->
   `companion-manager.ts:585-589`: flag to false, `analytics.trackOnboardingReplayed()`,
   `emitSettings()`.
3. `PanelApp` re-renders into `<Onboarding>`; because the component was unmounted while the
   flag was true, `index` starts at `0` (`Onboarding.tsx:63-67`) - the wizard restarts
   rather than resuming mid-flow.
4. Keys and settings survive: the handler writes only `onboardingComplete`; every step
   reads live settings and every setter is the normal `settingsStore` path, so replaying
   cannot clobber a working config (`GeneralTab`'s copy says exactly that).
5. Coming back out returns to the tab `PanelApp` was on (`PanelApp.tsx:19`).

### D. Mic test with always-on restores VAD (the fix under test)

Chain (companion-manager line numbers are the post-edit ones):

1. `MicStep` mounts -> `window.flicky.startMicTest()` (`Onboarding.tsx:728-731`) ->
   `preload:162` -> `index.ts:716` -> `companion-manager.ts:988-992`: sets
   `micTestActive`, and opens the single capture gate in **`'ptt'`** mode.
2. `MicStep` unmounts (Continue, Back, "Skip anyway", rail skip, or completing setup) ->
   `stopMicTest()` (`Onboarding.tsx:744-749`) -> `index.ts:716-730` ->
   `companion-manager.ts:994-1009`:
   - `micTestActive = false`;
   - `if (this.isRecording) return;` (`:999`) - a real PTT turn that grabbed the mic
     mid-test is left alone, and its own `finally` re-arms VAD (`:1243-1255`);
   - otherwise `onStopAudioCapture()` (`:1000`) -> `stopCapture()` (`index.ts:263-271`),
     then `if (alwaysOnEnabled && !isRecording && voiceState !== 'acting')` (`:1006`) ->
     `onStartAudioCapture('vad')` (`:1007`).
3. `index.ts:723-729` repeats the same condition and calls `startCaptureOn('vad')` a second
   time ("stopMicTest stops capture outright - with always-on enabled the VAD gate would
   stay dead"). Both copies are idempotent on the overlay side: `startMic` re-sets
   `captureModeRef`, resets the VAD buffer and posts `'start'`
   (`OverlayApp.tsx:644-667`), and `ensureGraph` returns the existing node without a second
   `getUserMedia` (`:567-642`). See F7 - the second copy is redundant but harmless, and it
   does cover the in-flight-start race.
4. Result: `vadGateOpen` goes true again (`OverlayApp.tsx:665`), the overlay's VAD ships
   finished utterances (`:607-611`) and `handleVadUtterance` accepts them because
   `micTestActive` is false (`companion-manager.ts:862-865`). **The documented fix holds.**
5. The reverse-order case also holds: `startRecording` clears `micTestActive` and switches
   the gate to `'ptt'` (`:1172-1173`), so a PTT turn during the test is not blocked and the
   later cleanup is a correct no-op (`:995`). Verified safe under `React.StrictMode`
   (`panel.tsx:10`): the dev double-invoke produces start -> stop -> start, and the stop
   step's re-arm is immediately superseded by the test's `'ptt'` gate in IPC order.

### E. No dead ends - summary

Every step is reachable with Back (`Onboarding.tsx:66-67` clamps both ways) and the rail's
"Skip setup" (`:87-93`) calls `completeOnboarding()` from anywhere, so no step is a hard
trap. The wizard also always opens with the panel: `togglePanel()` runs at the end of
`app.whenReady` (`index.ts:1097`), and the Done step tells the user where the app lives
(`:906-907`). Two gated steps offer a per-step escape (`MicStep` "Skip anyway" `:806`,
`TryStep` "Skip" `:881`); one does not (see F8). The per-step table is in section 4.

---

## 3. Findings

### F1 [MAJOR] The shortcut step's "verification window" silently expires after 10 s - later presses start a real turn

`ShortcutStep` mounts, calls `startPttTest()` (`Onboarding.tsx:620-623`) and the step
comment promises the shortcut is safe to mash: *"While on this step the accelerator only
reports itself - it doesn't open the mic - so the user can mash it freely"* (`:618-619`).

That promise is time-boxed. `PTT_TEST_START` -> `setPttTestMode(true)` (`index.ts:560`)
arms `PTT_TEST_EXPIRY_MS = 10_000` (`index.ts:122-140`), after which `pttTestMode` flips back
to false **by itself**. The step is not notified, and nothing re-arms it while the step
stays mounted (its effect has `[]` deps, `Onboarding.tsx:620-623`).

The badge keeps working, which hides the change: `pttHandler` sends `PTT_SHORTCUT_FIRED`
*before* the test-mode gate (`index.ts:509-513`), so `Onboarding.tsx:627-634` still lights up
"it works - I received the shortcut". The same press now falls through to the real path
(`index.ts:515-557`) and runs a genuine turn:

- `startPushToTalk` -> `startRecording` opens the mic and switches the gate to `'ptt'`
  (`companion-manager.ts:1154-1173`);
- on release the room audio is uploaded to Groq and a transcript is emitted
  (`:1202-1224`), a screenshot goes to the LLM, and the reply renders into a panel that is
  still showing the Shortcut step - so nothing in it is visible;
- if the Voice step enabled TTS, the answer is also spoken aloud (`:2024-2028`).

So a user who reads the step for more than ten seconds and then presses the key gets an
unattended, invisible, billed turn - plus `analytics.trackUserMessageSent` (`:1224`) on
whatever the mic picked up.

Fix candidates: keep `pttTestMode` true while `PTT_TEST_START` has not been cancelled (drop
the expiry, or re-arm it from the step on an interval / on interaction); or gate
`PTT_SHORTCUT_FIRED` behind `pttTestMode` so the badge cannot claim success from a press
that is about to become a real turn.

### F2 [MAJOR] Always-on is never armed at boot - the toggle reads "on" after a restart while the mic is closed

There are exactly five places that open the capture gate in `'vad'` mode:

| site | when |
|---|---|
| `companion-manager.ts:385` | `setAlwaysOn(true)` from the panel toggle (`GeneralTab.tsx:211-212`) or the tray checkbox (`index.ts:1152-1158`) |
| `companion-manager.ts:1007` | leaving the setup mic check |
| `companion-manager.ts:1253` | `finally` of a completed push-to-talk turn |
| `index.ts:728` | duplicate of the mic-check resume |
| `index.ts:1243` | `handleLostCapture` - only re-arms a capture that was already active |

Nothing arms it at startup: `app.whenReady` builds the tray and the overlays
(`index.ts:425-463`), and `rebuildOverlays()` ends in `handleLostCapture(lostCaptureMode)`
with `lostCaptureMode === null` (`index.ts:1294`, `index.ts:1304`), which returns immediately (`index.ts:1235`).
The overlay never self-arms either - `OverlayApp.tsx` uses `alwaysOnEnabled` only for the
idle hint and its own UI state (`:364`, `:825`, `:1051-1062`) - and the only IPC an overlay
receives on load is `display-info` (`windows.ts:191-192`).

Consequence on a second launch (or a reboot with launch-at-login): the General toggle, the
tray checkbox (`index.ts:1155`) and the Home chip (`HomeTab.tsx:283-285`) all say always-on
is on, the hot-mic indicator is *not* drawn (it requires a live `vadGateOpen`,
`OverlayApp.tsx:1274`), and no utterance is ever delivered - `handleVadUtterance` is never
called, so not even the `'vad drop'` logs fire. Recovery paths: complete one PTT turn
(`:1253`), or toggle the setting off/on, or use the tray checkbox. This is the same failure
class the mic-check fix was written for ("the mic looked live and nothing arrived",
`companion-manager.ts:1001-1005`), reached through a different door.

Fix candidate: after `rebuildOverlays()` (and after a display rebuild), if
`settingsStore.get('alwaysOnEnabled')` then `startCaptureOn('vad')` - the same condition
already used at `index.ts:723-729`.


### F3 [MINOR] A running setup mic check survives the panel being hidden - mic open, VAD dead, no indicator

Closing the panel hides it rather than destroying it (`index.ts:1211-1219`,
`panelWindow.on('close')` -> `hide()`), so `MicStep` stays mounted and its cleanup
(`Onboarding.tsx:744-749`) never runs. While `micTestActive` is true:

- the capture gate stays open in `'ptt'` mode, so the microphone is genuinely hot with the
  panel hidden and no visible cue (the overlay's hot-mic dot requires `vadGateOpen`,
  `OverlayApp.tsx:1274`, which is false in `'ptt'` mode);
- every always-on utterance is dropped (`companion-manager.ts:862-865`,
  "vad drop: mic test in progress") - i.e. on a replay with always-on enabled, always-on is
  silently dead until the user reopens the panel and leaves the Mic step.

Recovery is implicit (reopen the panel, then Continue/Skip). Consider stopping the test on
panel `hide`, mirroring `setPttTestMode(false)`, which is already wired to `hide` /
`did-start-loading` (`index.ts:1209-1221`).

### F4 [MINOR] The mic-level meter can die with no explanation and no Retry affordance

`MicStep` starts the test once on mount (`Onboarding.tsx:728-750`) and offers "Retry"
**only** in the MIC_ERROR branch (`:782-791`). Anything else that closes the shared capture
gate leaves the meter frozen at 0 with the copy "listening… say hi zapi" (`:778-780`) and
no way to re-arm short of navigating Back then Continue (which remounts the step). Three
reachable paths do exactly that:

1. **Pressing the PTT shortcut while on the Mic step.** The step actively invites it
   ("This uses the same capture path as push-to-talk", `:758-759`). `startRecording` clears
   `micTestActive` and re-opens the gate as `'ptt'` (`companion-manager.ts:1172-1173`); the
   release closes the gate (`:1189`) and, with always-on off, nothing re-arms it (`:1252`);
   the step's own cleanup is then a no-op because `micTestActive` is already false (`:995`).
   The meter is dead for the rest of the visit.
2. **Arriving from the Shortcut step while a turn is still in flight** (see F1 - that turn
   is real). `startMicTest` returns early on `isRecording` (`:989`) and reports nothing, so
   the gate never opens for the step.
3. **Toggling "Always-on listening" off in the tray (or General) during the step.**
   `setAlwaysOn(false)` calls `onStopAudioCapture()` whenever `!isRecording` (`:386`)
   without consulting `micTestActive` - the gate is closed under the test and never
   re-opened. (Toggling it *on* is harmless for the meter - `MIC_LEVEL` is reported in both
   capture modes, `OverlayApp.tsx:598-611` - but it silently converts the test's gate to
   `'vad'`, so the test stops exercising the path its copy claims it does.)

Fix candidates: re-arm `startMicTest()` when the step regains visibility or when
`voiceState` returns to idle, show Retry whenever `peak === 0` after a moment, and/or have
`setAlwaysOn` defer to an active mic check the way `startRecording` does.

### F5 [MINOR] The first-run demo can be vetoed silently, with only an undiscoverable recovery

`playDemoScene` returns with no log and no UI when `isRecording || pendingStart` or
`voiceState !== 'idle'` (`companion-manager.ts:1073-1074`). The 800 ms delay
(`index.ts:808`) makes the realistic case likely: the user presses "Skip" on the Try step
while the reply is still being spoken (`Onboarding.tsx:881`), or clicks "Start using zapi"
straight after a successful try, and the demo never plays. Nothing tells them, and the only
way back is the tray's "Play ink demo" (`index.ts:1176`) - a menu item with no counterpart
in the panel UI, which a user has no reason to look for.

Suggestion: `console.log` the veto reason (the VAD guards already do this,
`companion-manager.ts:856-876`), and/or expose "Play ink demo" in the panel next to
"Replay onboarding" in General.


### F6 [MINOR] `firstTime` cannot be false for an intended completion, and the funnel is half-wired

`index.ts:801-810` computes `firstTime = !companion.getSettings().onboardingComplete`
*before* setting it. But the wizard only renders while that flag is false
(`PanelApp.tsx:52`), so for every completion the read is `false` -> `firstTime` is always
`true`. The comment ("First completion only … never on plain launches") describes behaviour
the code does not implement: **the demo also plays when onboarding is replayed** from
General. The only way to get `firstTime === false` is a duplicate completion inside one
settings flush (double-click on "Start using zapi" or on "Skip setup") - which is what the
guard actually protects against.

Analytics is in the same state: `trackOnboardingStarted`, `trackOnboardingDemoTriggered` and
`trackOnboardingVideoCompleted` are exported (`analytics.ts:41-44`) but called from nowhere
- a repo-wide search finds only `trackOnboardingReplayed` (`companion-manager.ts:587`).
There is also no video step in `STEPS` (`Onboarding.tsx:42-53`), so the third is stale. The
result is a funnel with a replay event but no start, no completion and no demo trigger.

If per-completion demo playback is intended, say so in the comment; if it is not, the check
belongs on a persisted "demo shown" flag (or on the analytics event that was clearly meant
for it).

### F7 [MINOR] Two owners for the mic-check VAD resume

`stopMicTest` already re-arms `'vad'` when always-on is enabled
(`companion-manager.ts:1001-1008`), and `index.ts:716-730` repeats the identical condition
right after the call. The comment on the main-side copy implies the companion does not do
it ("only stopRecordingAndProcess / setAlwaysOn ever handed it back"), which is no longer
true. Not a bug today - the duplicate start is idempotent (`OverlayApp.tsx:644-667`) and it
does cover the in-flight-`ensureGraph` race - but the two conditions can drift
(`voiceState !== 'acting'` in the companion vs the cached `lastVoiceState !== 'acting'` in
main) and future edits will have to update both. Keep one, or fold the race cover into
`stopMicTest` and comment why.

### F8 [NOTE] The Ear step is the one hard gate with no per-step escape

`EarStep` gates Continue on `settings.apiKeyStatus.groq` with the hint "Required - without
it I can't hear you" (`Onboarding.tsx:434-470`). Unlike Mind (local endpoints also
qualify), Voice ("Skip - text only", `:482-485`, `:552-554`), Mic ("Skip anyway", `:806`)
and Try ("Skip", `:881`), there is no way past this step except the rail's "Skip setup"
(`:87-93`), which abandons the whole wizard including the mic check and the try-it turn.

The step is *consistent with the app as shipped*: `transcriptionProvider` has no setter
anywhere (read-only at `EarTab.tsx:25-50` and `companion-manager.ts:1158`), so the only
reachable provider is the `'groq'` default (`types.ts:507`), and `OpenAIWhisperProvider`
(`transcription.ts:245`, reachable at `:334`) is effectively dead code. The practical effect
is worth knowing: a user whose only key is OpenAI - which they may have just pasted in the
Mind step - cannot get through Ear. Either accept an OpenAI transcription key in the step
(and wire the provider switch), or make the skip explicit.


### F9 [NOTE] Verified-correct details, and two traps

- **Demo needs no keys, confirmed end to end** - the strongest single argument is that
  `synthesizeSpeech` is only reachable from the turn pipeline
  (`companion-manager.ts:1420-1426`, `:1599-1605`, `:1840-1841`, `:2024-2028`) and that
  `playDemoScene` never calls into a provider or `keyStore`.
- **F9a (cosmetic mismatch)** - for the demo's ~13.7 s the whole UI reports
  `voiceState: 'responding'` ("speaking…" in the Try step's own label set,
  `Onboarding.tsx:842-848`; the stream window also pops up if
  `streamVisibility === 'responses'`, `index.ts:1427-1442`), while the demo is silent. In
  that window the VAD also drops utterances by design
  (`companion-manager.ts:873-876`), so a user who enabled always-on and speaks immediately
  after finishing setup is ignored.
- **Demo interruption is correct** - a PTT press during playback bumps `turnId`, so
  `isCurrent()` fails and the stale demo timers neither draw nor reset the new turn's state
  (`companion-manager.ts:1042-1057`, `:1093-1095`).
- **Mic-check capture mode switching is safe** - `startMic`/`stopMic` mute/re-use one
  AudioWorklet graph instead of tearing it down (`OverlayApp.tsx:567-680`), which is why
  repeated stop/start pairs (panel close/reopen, StrictMode double-invoke, the duplicate
  resume in F7) do not leak a second `getUserMedia`.
- **Key entry cannot dead-end the wizard** - `KeyEntry` round-trips the key and exposes
  "Save anyway" on failure (`KeyEntry.tsx:44-54`, `:102-107`); a successful save emits
  settings (`companion-manager.ts:650-653`), so `hasKey` / `apiKeyStatus` update immediately
  and Continue unlocks.
- **Bounds trap (informational)** - `InkLayer` draws *every* cue when `bounds` is null
  (`InkLayer.tsx:279-281`), so if `display-info` had not reached an overlay yet, the demo's
  `screenIndex: 0` cues would be painted on every display. In practice the bounds ride in on
  `did-finish-load` (`windows.ts:191-192`) long before onboarding completes.
- **Multi-display demo** - the scene is broadcast and each overlay culls by its own bounds
  (`index.ts:339-364`, `InkLayer.tsx:281-284`); the closing `point` cue only renders on the
  display that owns the anchor (`OverlayApp.tsx:909-928`). (The `REPORT.md` / `AUDIT2`
  note claiming scenes route to a single overlay no longer matches the code.)

---


## 4. Per-step dead-end map

Steps in order (`Onboarding.tsx:42-56`; `permissions` is filtered out on Linux, so macOS and
Windows get 10 steps and Linux 9).

| # | Step | Gate on Continue | Escape if the gate is not met |
|---|---|---|---|
| 1 | Welcome | none | Continue |
| 2 | Permissions | none (`nextDisabled={false}`, `:332-337`) - warns that the later mic check will fail | Continue; per-row "Open settings" (`:288`, `:313`) |
| 3 | Mind | `nextDisabled={!ready}` (`:422-427`); ready = key, or Local (always "ready", and the card tells you to add an endpoint later, `:355`, `:383-391`) | Back; rail Skip |
| 4 | Ear | `nextDisabled={!hasKey}` (Groq only, `:465-470`) | rail Skip only - see F8 |
| 5 | Voice | only when a key exists (`:548-556`) | "Skip - text only" (`:482-485`) |
| 6 | Modes | none | Continue |
| 7 | Shortcut | `nextDisabled={!fired}` (`:707-712`) | rail Skip; "Change shortcut" with bind-error reporting (`:649-661`, `:685`) - but see F1 for the 10 s trap |
| 8 | Mic check | `nextDisabled={!heard}` (`:801-807`) | "Skip anyway" (`:806`); Back/Continue remount; Retry only on MIC_ERROR (see F4) |
| 9 | Try it | `nextDisabled={!completed}` (`:876-882`) | "Skip" (`:881`); the step shows live transcript/reply and AI errors (`:822-839`, `:872`) |
| 10 | Done | none | "Start using zapi" (`:919`) |

Global escape from every step: rail "Skip setup" (`:87-93`, with a tooltip pointing at
General). Wizard state is a single `index` with clamped `next`/`back` (`:66-67`) and every
step re-mounts on `key={step.id}` (`:96`), so step-local `useEffect` cleanup is
unambiguous - which is why the mic check reliably stops when you leave the step, and why
Back -> Continue reliably restarts it.

Also verified: the panel is opened unconditionally at boot (`index.ts:1097`), so the wizard
never strands the user behind a hidden panel, and the Done step documents the replay path
(`Onboarding.tsx:915-918`).

---

## 5. What was executed (read-only)

| Check | Command | Result |
|---|---|---|
| Typecheck (main) | `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit` | **PASS** |
| Typecheck (renderer) | `node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit` | **PASS** |
| Preload/IPC contract | `bun scripts/preload-check.mts` | 337 passed, 9 failed, 0 findings. All onboarding/mic/scene channels **PASS**: `REPLAY_ONBOARDING`, `COMPLETE_ONBOARDING`, `MIC_TEST_START/STOP`, `MIC_LEVEL`, `MIC_ERROR`, `PTT_TEST_START/STOP`, `PTT_SHORTCUT_FIRED`, `SCENE`, `SCENE_CUE`, `SETTINGS_CHANGED`, plus raw `start-audio-capture` / `stop-audio-capture` listener-to-emitter evidence. The 9 failures are pre-existing, unrelated drift: `ARTIFACT_LIST/OPEN/REVEAL`, `SUGGESTION_LIST/ACCEPT/DISMISS/REFRESH`, `CHAT_MARK_READ`, `TEXT_TURN` have preload methods but no `ipcMain` handler (re-confirmed after the mid-session edit). |
| Settings contract | `bun scripts/settings-parity.mts` | **PASS** - "no contract drift detected", 5/5 checks, 0 errors (9 expected notes, all about runtime-derived fields) |

Note on invocation: the `bunx tsx ...` form used in `REPORT.md` does not resolve in this
environment (`node_modules\.bin` holds bun-style shims, not `tsx.cmd` / `tsc.cmd`), so the
direct `node` / `bun` paths above were used instead.

## 6. Limits of this pass

- No Electron runtime, mic or overlay was available, so no behaviour was exercised
  end-to-end; every claim above is a code-path argument, and the timing figures are
  arithmetic from `dwellFor`, not measurements.
- `scripts/chat-smoke.mts` and the other stub-preload harnesses need a bun `--preload`
  electron stub that does not work here, so nothing was run against `CompanionManager`
  itself. An instantiation test of `playDemoScene` plus the mic-test flag transitions is the
  natural next wave: it needs only a stub `screen` / `app` and a fake callback set.
- There is no test suite for this area: no `test` script in `package.json`, no
  `*.test.ts(x)` anywhere in `src/`, and no harness that covers `Onboarding.tsx` or
  `playDemoScene`. Everything above is protected only by typecheck plus the two contract
  scripts.
- Only these flows were audited: the onboarding steps, the demo scene, the
  `onboardingComplete` flag, replay, and the mic-check / always-on capture interplay. Agent
  mode, routines, dictation and the stream window were followed only as far as onboarding
  touches them.

## 7. Suggested fix order

1. **F1** - the shortcut step can start an invisible real turn. The cheapest correct fix is
   in `pttHandler` / the step, and it removes a privacy-adjacent surprise on day one.
2. **F2** - arm always-on at boot; a setting that reads "on" while the mic is closed is the
   same class of bug the mic-check fix addressed, and it hits every returning user.
3. **F4** (with F3) - give the mic step a re-arm plus an always-visible Retry, and stop the
   test when the panel hides.
4. **F5 / F6** - log the demo veto, make the "first time" comment match reality, and either
   wire the unused funnel events or delete them.
5. **F7 / F8** - de-duplicate the resume; decide whether Ear should accept an OpenAI
   transcription key or offer a skip.

