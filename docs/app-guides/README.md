# App guides

Reference material for a future focused-app injection. These are **pure docs** —
nothing here is wired to code yet. The consumer would be ZAPI's agent loop: when
an agent run is focused on one of these windows, the matching guide is the
cheapest available context for *how that app is actually driven*.

**Who this is for.** A vision + keyboard/mouse agent. Not a shell agent. The
shortcuts below are not advice for a human — they are the sequences to emit as
`[ACT:key:…]` and `[ACT:type:…]`, chosen because they are deterministic where
clicking is not.

Each guide follows the same three-section shape:

| Section | What it is for |
|---|---|
| `## Common tasks` | Intent-keyed, in the user's phrasing. One action per step. |
| `## Keyboard-first paths` | The shortcut table to emit, plus the one or two keys whose meaning inverts across apps. |
| `## Gotchas for screen agents` | Failure modes specific to driving this app from screenshots: layout shifts, silent misclicks, modal dialogs that eat keystrokes. |

## The guides

| Guide | App | Highest-value fact in it |
|---|---|---|
| [explorer.md](explorer.md) | File Explorer | Address bar *navigates*, search box *searches* — confusing them looks exactly like "file not found". `Alt+Enter` for properties, `Enter` for open |
| [vscode.md](vscode.md) | VS Code | `Ctrl+P` beats `Ctrl+O` because it never hands control to the OS file dialog; trust dialogs and the integrated terminal are the two focus traps |
| [chrome.md](chrome.md) | Chrome / Edge | `Ctrl+L` **selects** the address bar, clicking does not — this is the difference between navigating and corrupting a URL |
| [excel.md](excel.md) | Excel | `Ctrl+Enter` fills a formula across a selected range; Protected View and the legacy-format save dialog block runs silently |
| [settings.md](settings.md) | Windows Settings | `ms-settings:` URIs beat clicking the sidebar on every release, because a URI survives a Windows update and a coordinate does not |

## Why Windows-specific

Every guide is written against Windows behaviour, not generic desktop practice:
Explorer `Alt+Enter`, Win11's `Windows + E`, the NSIS/unsigned installer reality,
UAC's secure desktop, DPI scaling changing cached coordinates between steps, and
notification toasts landing on top of the toolbar. The macOS-first reference
bundle surveyed in [../APP-GUIDES-SURVEY.md](../APP-GUIDES-SURVEY.md) has no
analogue for most of these.

Three cross-app rules that apply to all five:

1. **Prefer a keystroke to a click whenever both exist.** Toolbar layouts reflow
   with window width, sidebar state, and notification banners; keystrokes do not.
2. **Re-capture after anything that changes layout.** DevTools, Protected View,
   ribbon tabs appearing, zoom — all invalidate every coordinate you held.
3. **A click that "did nothing" usually consumed a dismissal.** Permission
   bubbles, confirmation dialogs, and trust prompts take the first click and leave
   the target unmoved.

## Adding a guide

Follow the three-section shape above. Cap it at ~100 lines; if a guide wants to be
longer, that is a signal to split it. Depth that belongs to one app's advanced
flows should go in a sibling file rather than lengthening the entry point — the
reference bundle's worst guide is 744 lines and its best is 134, and the difference
is entirely budget discipline.

Two habits worth copying from the existing reports: cite the Windows version when
a shortcut or pane differs, and state what the OS will not let you do rather than
implying full coverage. See [../APP-GUIDES-SURVEY.md](../APP-GUIDES-SURVEY.md)
§4 for the pattern survey these habits came from.
