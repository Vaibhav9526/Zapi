# Google Chrome (Windows)

Highest-frequency target for a screen-aware assistant, and the app where ZAPI's
loop is easiest to run well: everything important is reachable from the keyboard
and the page is the visible proof.

**Mental model:** Chrome's chrome (the toolbar) is the only part that matters to
you — the viewport below it belongs to the site. Scope every screenshot-based
decision to the toolbar region and ignore page reflow entirely.

Applies to Edge and any Chromium browser with the same shortcut set — Edge's
`Alt+←` / `Alt+→` back/forward are unchanged.

---

## Common tasks

### "Open this URL"

```
[ACT:key:ctrl+l]           # focuses and SELECTS the address bar text
[ACT:type:https://example.com/pricing]
[ACT:key:enter]
```

Always `Ctrl+L`, never click the omnibox. Clicking it places a caret at the click
position, so a subsequent `[ACT:type:]` can *insert into* the existing URL instead
of replacing it — producing something like `https://exahttps://mple.com`.

### "Open a new tab"

`Ctrl+T`. Do **not** click the `+` on the tab strip: the strip's width depends on
how many tabs are open, so the `+` position moves every time a tab is added.

### "Reopen the tab I just closed"

`Ctrl+Shift+T`. It restores in reverse-closure order, including whole closed
*windows*. If you closed the wrong thing, one press may restore an entire window
that was not the thing you lost.

### "Back / forward"

`Alt+←` and `Alt+→`. Do not click the back arrow — it is disabled (greyed) at the
start of history and *looks* clickable, so a blind click can hit the disabled
button and then the reload button beside it.

### "Hard reload (bypass cache)"

`Ctrl+Shift+R`. Needed after a deploy, when the ordinary `Ctrl+R` serves a stale
bundle from cache.

### "Open DevTools"

`F12` toggles it; `Ctrl+Shift+J` opens straight to the Console, `Ctrl+Shift+C` to
inspect-element mode. After `F12` **the viewport shrinks and everything reflows** —
any coordinate remembered from before is wrong. Re-capture after the toggle and
never reuse pre-toggle coordinates.

---

## Keyboard-first paths

| Intent | Keys |
|---|---|
| Focus the address bar | `Ctrl+L` |
| New tab / close tab | `Ctrl+T` / `Ctrl+W` |
| Reopen closed tab or window | `Ctrl+Shift+T` |
| Go to tab *n* | `Ctrl+1` … `Ctrl+9` (`Ctrl+9` = last) |
| Cycle tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Back / forward | `Alt+←` / `Alt+→` |
| Reload / hard reload / stop | `Ctrl+R` / `Ctrl+Shift+R` / `Esc` |
| Find on page / find next match | `Ctrl+F` / `Ctrl+G` |
| Bookmark / bookmarks bar | `Ctrl+D` / `Ctrl+Shift+B` |
| History / downloads | `Ctrl+H` / `Ctrl+J` |
| Incognito window | `Ctrl+Shift+N` |
| DevTools / Console | `F12` / `Ctrl+Shift+J` |
| Zoom in / out / reset | `Ctrl++` / `Ctrl+-` / `Ctrl+0` |

`Ctrl+1`…`Ctrl+9` is the reliable way to reach a specific tab: strip *order* shifts
with pinning and overflow, but the index space does not. Never click the back
arrow — it is disabled at the start of history and still *looks* clickable, so a
blind click can land on the reload button beside it.

---

## Gotchas for screen agents

- **`Ctrl+L` selects; clicking does not.** The highest-value fact in this guide.
  Typing after a click *inserts into* the existing URL; typing after `Ctrl+L`
  replaces it.
- **The omnibox doubles as a search box.** A bare word with no scheme goes to the
  default engine. Always include a full `https://` — a bare domain may resolve to a
  results page for that word rather than the site.
- **Chrome's own overlays steal the click.** The "Restore pages?" bubble (top-left,
  covers the tab strip), the download shelf (bottom, covers page content), and
  page permission prompts (under the omnibox) each take one click and leave the
  real target unmoved. "I clicked it and nothing happened" almost always means the
  first click dismissed a bubble. Wait for the download shelf to auto-clear.
- **Tab-strip geometry is unstable.** Pinned tabs are narrow and sit left of the
  rest; overflow hides tabs behind `»`. Prefer `Ctrl+<index>`, or close tabs until
  the strip fits.
- **Profile first-run is a full-screen takeover.** A fresh or reset profile shows a
  "Welcome to Chrome" / "Set Chrome as default" flow that shares none of the toolbar
  geometry — every coordinate is invalid until it is dismissed. Look for
  **Skip**/**Not now**, not for the page.
- **`Esc` stops loading but also closes some overlays** (autoplay dropdowns, find
  bar). Prefer `Ctrl+Shift+R` plus a re-capture over an `Esc`-then-click plan.
- **Zoom persists per-site**, so a site left at 150% looks unfamiliar next task.
  `Ctrl+0` resets, and it is cheap — do it before reasoning about layout.
