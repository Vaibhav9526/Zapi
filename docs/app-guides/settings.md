# Windows Settings

The one app here where **clicking is the wrong default approach**. Every pane has
an `ms-settings:` URI, and the URI is faster and immune to the layout shifts that a
click on the sidebar is not.

**Mental model:** `ms-settings:<pane>` is a **deep link**. `Win+R` + the URI lands
directly on the page you need; `Win+I` + clicking walks the navigation tree and
lands wherever the layout puts it.

Use for privacy/permission toggles, default apps, display/sound, and system
about. Do not use it for anything an app owns better — the app's own guide
([explorer.md](explorer.md), [vscode.md](vscode.md)) should handle that app's
settings.

---

## `ms-settings:` URI table

Open any row with `Win+R`, paste the URI, `Enter`.

| Task | URI |
|---|---|
| Settings home | `ms-settings:` |
| Microphone / camera privacy | `ms-settings:privacy-microphone` / `ms-settings:privacy-webcam` |
| Location / broad privacy | `ms-settings:privacy-location` / `ms-settings:privacy` |
| Notifications | `ms-settings:notifications` |
| Display, scaling, night light | `ms-settings:display` |
| Sound, output device, volume | `ms-settings:sound` |
| Bluetooth | `ms-settings:bluetooth` |
| Network & internet / Wi-Fi / VPN | `ms-settings:network` / `network-wifi` / `network-vpn` |
| Power & battery | `ms-settings:power` |
| Themes / personalization | `ms-settings:themes` / `ms-settings:personalization` |
| Taskbar / multitasking | `ms-settings:taskbar` / `ms-settings:multitasking` |
| Apps & features, default apps | `ms-settings:apps-features` / `ms-settings:defaultapps` |
| Windows Update / Windows Security | `ms-settings:windowsupdate` / `windowsdefender:` |
| Time & language / region | `ms-settings:timeandlanguage` / `ms-settings:region` |
| Accessibility | `ms-settings:easeofaccess` |
| Storage / optional features | `ms-settings:storage` / `ms-settings:optionalfeatures` |
| About (version, device name) / activation | `ms-settings:about` / `ms-settings:activation` |

---

## Common tasks

### "Enable the microphone for this app"

The most common Settings task for a screen-aware assistant, because a missing mic
grant looks exactly like broken hardware.

```
[ACT:key:super]
[ACT:type:ms-settings:privacy-microphone]
[ACT:key:return]
```

Then find the app's row and flip the toggle. `Win+I` also works, but it lands on
the home page and needs the sidebar walked.

### "Make this app the default for PDFs / browsers"

`ms-settings:defaultapps` → **Set defaults for file types**. Note the trap: the
per-extension right-click menu in Explorer offers **"Set default by file type"**
for a single file, which is the faster route when Explorer is already open.

### "Check the Windows version / device name"

`ms-settings:about`. Field labels change between releases (*"Windows
specifications"* vs *"Device specifications"*), so read the current pane rather
than clicking from a memorized offset.

### "Turn off a startup app"

`ms-settings:apps-features` → **Startup** tab. The list is alphabetical with
right-aligned toggles, and long app names truncate — widen the window before
reading names.

---

## Keyboard-first paths

| Intent | Keys |
|---|---|
| Run a URI (primary) | `Win+R`, type `ms-settings:…`, `Enter` |
| Open Settings directly | `Win+I` |
| Close Settings | `Alt+F4` (it is a normal window) |
| Cycle sidebar groups / move within one | `Ctrl+Tab` / arrows |
| Jump to a Settings search result | `Ctrl+F` inside Settings |
| Toggle the focused switch | `Space` |
| Return to the previous pane | `Alt+←` |

`Win+R` is the primary path, not `Win+I`. `Win+I` costs a sidebar navigation that
has to be re-derived whenever the layout changes; `Win+R` is a fixed string and a
fixed `Enter`.

---

## Gotchas for screen agents

- **UAC cannot be driven, and several panes need it.** Mic/registry pages do not,
  but *Default apps*, *Windows Update activation*, and anything editing a system
  path put a consent dialog on the **secure desktop** — no screenshot reaches it
  and no click lands on it. If a run appears to hang the moment Settings opens,
  suspect UAC and **stop** rather than retrying; the user has to click it.
- **A bad URI does not error cleanly.** Older builds open Settings and silently
  show the home page, so "wrong page" means *my URI is wrong for this build*, not
  that navigation broke. Watch the family words too: `privacy-camera` does not
  exist — the camera pane is `privacy-webcam`, and a wrong guess lands on home.
- **Privacy toggles are tri-state per app.** The header row is *all apps*, and an
  app's own row can be Off, On, or **not listed** — and an unlisted app cannot be
  granted from that page. Check **Apps → Optional features** or the app's own
  permissions page instead.
- **Settings is versioned and the sidebar order shifts.** A `ms-settings:` URI
  survives a Windows update; a memorized click coordinate does not. This is the
  strongest argument for URI-first on this app specifically.
- **Some toggles are per-user, some machine-wide.** A change under a different
  Windows or domain account does not apply, and the UI gives no hint. Verify
  whose account is signed in via `ms-settings:about` if a toggle won't stick.
- **`windowsupdate` and `power` are destructive by proximity.** The first will
  install pending updates and restart the machine, destroying the run and every
  unsaved artifact; the second is one click from a "Change battery settings"
  shutdown dialog. Never navigate there without explicit instruction.
- **A green microphone toggle does not mean a working mic.** It only records
  permission. Verifying that audio actually arrives is an app-level action (the
  panel's own mic check), not a Settings state.
