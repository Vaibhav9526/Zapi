# File Explorer (Windows)

The cheapest app here to drive, and the one ZAPI already depends on — artifact
piles resolve to a folder, and "open"/"reveal" are just `shell.openPath` and
`shell.showItemInFolder`.

**Mental model:** the address bar is a *navigator*, the search box is a *searcher*.
Nearly every Explorer failure an agent hits comes from confusing the two, or from
clicking folder names in a thumbnail view instead of typing a path.

Use for *where is this file / move it / rename it / what's in this folder*. To open
a file in its app, hand off to [vscode.md](vscode.md) or [excel.md](excel.md).

---

## Common tasks

### "Open the folder that has my file"

Type the path; do not click through the tree. Deep trees are where click-chains
break — each hop depends on scroll position and thumbnail rendering.

```
[ACT:key:ctrl+l]            # focus address bar, selects existing text
[ACT:type:C:\Users\me\Documents\Reports]
[ACT:key:enter]
```

`Ctrl+L` selects whatever is already there, so typing replaces it. If the path has
spaces you do **not** need quotes — the address bar is not a shell.

### "Find a file whose name I half-remember"

Two different tools; pick deliberately. If you know roughly where it is, `Ctrl+L`
→ partial folder → `Enter` → sort by name: faster and never scans the disk. If you
don't, search from a high folder — `Ctrl+E` focuses the search box. Searching
`C:\` is slow but correct; searching the index scope (User / This PC) is faster
but misses excluded paths.

### "Rename these files"

`F2` renames in place and does **not** select the extension. Selecting all
(`Ctrl+A`) then `F2` renames everything at once into `name (2).txt`, `name (3).txt`
— a data-loss shape, not a bulk rename. To bulk rename on purpose: `Ctrl+A`, click
the file-name column header once, then `F2` — the shared prefix lands in an edit
box.

### "Move / copy these into another folder"

`Ctrl+X` / `Ctrl+C`, then `Ctrl+V` **inside the destination window**. Paste is
per-window and keyboard-driven; drag-and-drop across windows is the one operation
here with no keyboard equivalent and should be avoided. Pasting onto an existing
same-name file prompts *Keep both / Replace / Skip* — prefer **Keep both**; it is
non-destructive and matches ZAPI's `uniquePath` behavior for artifacts.

### "What are this file's details / permissions / hashes"

`Alt+Enter` opens Properties. Not `Enter` — this is the most useful Explorer
shortcut and the easiest one for an agent to miss, because `Enter` opens the file.

### "Show hidden items / file extensions"

`View` → `Show` → **Hidden items** and **File name extensions**. Neither has a
keyboard default (a terminal can do `attrib -h`). Without extensions visible,
`report.pdf` and `report.pdf.txt` look identical and renaming is guesswork.

### "Open a terminal in this folder"

`Shift`+right-click in empty space → **Open in PowerShell window**. There is no
keyboard equivalent, so click once into the empty pane first to make the
coordinates predictable.

---

## Keyboard-first paths

| Intent | Keys |
|---|---|
| Focus the address bar / search box | `Ctrl+L` / `Ctrl+E` |
| Go to a path; jump by segment | type after `Ctrl+L` then `Enter`; `/` or `?` mid-path |
| Back / forward / up one folder | `Alt+←` / `Alt+→` / `Alt+↑` |
| New folder / new tab / close tab | `Ctrl+Shift+N` / `Ctrl+T` / `Ctrl+W` |
| Rename in place / properties | `F2` / `Alt+Enter` |
| Select all; cut / copy / paste | `Ctrl+A`; `Ctrl+X` / `Ctrl+C` / `Ctrl+V` |
| Switch view | `Ctrl+Shift+1` extra-large icons · `2` large · `3` list · **`4` details** · `5` tiles · `6` content |
| Open the app | `Win+E` |
| Terminal in the current folder | `Shift`+right-click → PowerShell |

**Set the view first.** `Ctrl+Shift+4` (details) gives predictable row positions;
large-icons gives variable-height rows that break any cached coordinate.

---

## Gotchas for screen agents

- **Never click a folder name to navigate.** Click once to select, then `Enter`, or
  go straight to `Ctrl+L`. A double-click on a large-icons thumbnail lands on the
  icon's padding rather than the label — and in that view a truncated name is
  unreadable, so an agent cannot even verify it opened the right place. Switch to
  details view (`Ctrl+Shift+4`) or navigate entirely by address bar.
- **The search box and the address bar look alike and are not.** `Ctrl+E` then
  typing searches the *current subtree*; `Ctrl+L` then typing navigates. Typing a
  path into the search box returns an empty result set plus a slow scan — which
  reads as "file not found".
- **`Alt+Enter` vs `Enter` is silent when wrong.** `Enter` on a `.exe` or `.bat`
  launches it. Never use `Enter` to open anything whose extension you have not
  read in the details view.
- **OneDrive owns some Known Folders.** Documents and Desktop may be under
  `%USERPROFILE%\OneDrive\…`, not `%USERPROFILE%\…`, and the original path then
  prompts *"Some of your files have been moved or deleted"*. Resolve via
  `shell:personal` and `shell:onedrive` instead of guessing.
- **Deleting is file-losing and prompts on multi-select.** `Delete` (Recycle Bin)
  and `Shift+Delete` (permanent) are both easy to fire blind; the second prompts
  only over the Recycle Bin size limit. `Ctrl+Shift+Delete` is *Empty Recycle
  Bin*, not a permanent delete. Never delete without a confirmed selection.
- **UAC cannot be driven.** Explorer relaunching itself elevated puts a consent
  prompt on the secure desktop: no screenshot reaches it and no click lands on it.
  Navigate to the folder and let the user elevate.
- **Toasts and DPI both move the target.** A "Copied" toast covers the top-right,
  and 125%/150% scaling shifts every row — ZAPI re-captures per step, so always
  reason about the capture that immediately precedes the click.
