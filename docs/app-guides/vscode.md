# VS Code (Windows)

The one app here where the keyboard beats the mouse for almost everything — and
also the one with the most *modal dialogs* that steal a run's focus. Treat it as:
fast keyboard surface, hostile modal surface.

**Mental model:** VS Code is a **command palette wrapped around an editor**.
Anything you cannot do in two keystrokes is usually reachable from `Ctrl+Shift+P`
by typing three words — often more reliable than clicking a button whose position
moves with sidebar state.

Use for open / edit / save / search / run / commit. Do not use for installing
extensions or changing system settings — see [settings.md](settings.md), and read
the Workspace Trust gotcha before your first automated edit.

---

## Common tasks

### "Open this file"

`Ctrl+P` then the path. `Ctrl+P` beats `Ctrl+O` for agents: it fuzzy-matches on
path so partial names work, and it does **not** spawn the OS file dialog — which is
a *separate window* with its own address bar and its own coordinates. `Ctrl+O`
hands control to a surface ZAPI has no guide for.

### "Find where this text is used"

`Ctrl+F` for the current file (widget anchored bottom-right); `Ctrl+Shift+F` across
the project (results tree in the sidebar). For a project-wide regex, `Ctrl+Shift+F`,
enable the regex toggle in the widget, then type — the syntax is VS Code's
(JS-flavored), not Python's.

### "Add a line above / below, duplicate, or delete a line"

`Ctrl+Enter` inserts a line below the caret, `Ctrl+Shift+Enter` above,
`Shift+Alt+↓` duplicates downward, `Ctrl+Shift+K` deletes. Both arrow-key and
line-oriented commands preserve indentation, which typing a raw newline does not —
and none depend on a rendered selection the way a drag-select does.

### "Run the task / the tests"

``Ctrl+` `` reaches the integrated terminal; run it there. Prefer the terminal for
anything whose output you need to read — a transcript is easier to verify from a
screenshot than the results panel. `Ctrl+Shift+P` → `Tasks: Run Task` is the
menu route.

### "Save / Save All"

`Ctrl+S` saves the active editor, `Ctrl+K S` saves every dirty one. Saving triggers
format-on-save if enabled, so **the buffer can change after the keystroke** —
re-screenshot before asserting anything about file contents.

---

## Keyboard-first paths

| Intent | Keys |
|---|---|
| Command palette | `Ctrl+Shift+P` |
| Quick Open (file by path) | `Ctrl+P` (`:` line number, `@` symbols in file) |
| Go to symbol across the project | `Ctrl+T` |
| Toggle integrated terminal | ``Ctrl+` `` |
| Toggle sidebar / Explorer sidebar | `Ctrl+B` / `Ctrl+Shift+E` |
| Find in file / across project | `Ctrl+F` / `Ctrl+Shift+F` |
| Go to line / go to definition | `Ctrl+G` / `F12` |
| Rename symbol (all refs) | `F2` *with the caret on a symbol* |
| Select next occurrence | `Ctrl+D` |
| Toggle line comment | `Ctrl+/` |
| Settings UI / keyboard shortcuts | `Ctrl+,` / `Ctrl+K` `Ctrl+S` |
| Move line up / down | `Alt+↑` / `Alt+↓` |
| Close editor / all editors | `Ctrl+W` / `Ctrl+K` `Ctrl+W` |
| Toggle word wrap | `Alt+Z` |
| Format document | `Shift+Alt+F` |
| Suggestion / accept | `Ctrl+Space` / `Tab` |

`F2` means **rename symbol** here and **rename file** in Explorer. Same key, two
very different consequences — check which window is focused before pressing it.

---

## Gotchas for screen agents

- **The Workspace Trust dialog is a hard block.** First open of an unfamiliar
  folder shows a modal asking you to trust the authors, and Restricted Mode
  disables most extensions, tasks, and debugging. It is keyboard-driven
  (**Yes, I trust the authors**, `Enter`) so it *is* drivable — but it appears at an
  unpredictable moment and eats your keystrokes. Treat "nothing responds" as "a
  modal is up" before treating it as a hang.
- **The integrated terminal is a separate focus world.** After ``Ctrl+` `` every
  keystroke goes to the shell. A `[ACT:type:…]` meant for the editor gets executed
  by PowerShell, happily. Confirm which pane has focus (cursor in the terminal
  panel vs a blinking caret in the editor) before typing anything not obviously
  shell-safe.
- **Suggestion popups eat `Enter` and `Tab`.** With IntelliSense open, `Enter`
  accepts a completion instead of inserting a newline. Accept explicitly with `Tab`,
  or `Escape` first, then press `Enter` for the line break.
- **Format-on-save mutates the buffer *after* `Ctrl+S`.** If the task is "format
  this file", use `Shift+Alt+F` and then save, so the screenshot you verify is the
  one you produced.
- **Search results are async.** `Ctrl+Shift+F` populates over time; an empty tree
  one frame after the search is not a result. Wait on the find widget's counter
  (`No results` vs a count), not on pixels.
- **Toasts cover the minimap and status text.** Extension-recommendation toasts sit
  bottom-right. Read state from the **title bar** instead: `● explorer.ts — Visual
  Studio Code` means unsaved, and is cheaper and more reliable than reading file
  contents to check whether an edit landed.
- **The palette returns focus to the caret, not to a fixed place.** After a
  `Ctrl+Shift+P` action the caret is still where it was — do not assume focus moved
  to the palette input, or that it moved back somewhere specific.
- **Multi-root workspaces make `Ctrl+P` ambiguous.** The same filename in two roots
  makes fuzzy-match order unstable; include a directory fragment in the query.
- **WSL / Dev Containers change what a path means.** A remote badge in the status
  bar means explorer paths are not `C:\` paths, and "reveal in file explorer" can
  open nothing. Check the badge before reasoning about paths.
