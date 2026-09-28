# Microsoft Excel (Windows)

The densest intent-per-pattern mapping of any app here — almost every request
("sort this", "sum that column", "why is this wrong") maps to a named box or a
fixed shortcut. That makes Excel unusually *safe* for an agent; the ribbon is the
only navigation problem.

**Mental model:** two focus worlds. The **grid** (arrows move a selection) and the
**formula bar** (typing edits one cell). `Enter` commits and moves down, `Tab`
commits and moves right. A screenshot showing a selection outline is the grid; one
showing a caret in the formula bar is editing.

Applies to Excel for Microsoft 365 and desktop Excel. LibreOffice Calc shares
`Ctrl+G`, `Ctrl+F`, `F2`, and `Ctrl+Arrow` but not the ribbon or `Alt+=`.

---

## Common tasks

### "Go to a cell / a range"

`F5` (or `Ctrl+G`) opens Go To, then type and `Enter`. `F5` beats clicking the Name
Box because it also accepts **defined names** — `Ctrl+Sales` jumps to a named
range. For a range, `F5`, `B12:D40`, `Enter` selects the block in one step; that
is the right primitive for anything ending in "…then do this to all of them".

### "Select the whole used range / a data block"

`Ctrl+A` once selects the **block** (the contiguous used range around the active
cell); twice selects the entire sheet. The difference is enormous — one press is
what you want for a data table, two is a disaster for "format all cells". To reach
the edge of a region: `Ctrl+↓` / `Ctrl+←` from a cell inside it. `Ctrl+Space`
selects the column, `Shift+Space` the row.

### "Enter a formula"

`F2`, then `[ACT:type:=SUM(B2:B40)]`, then `Enter`. Type formulas as text — Excel's
`=` prefix and reference syntax *are* the target, so no translation is needed. Do
**not** click cells to build a reference: a click inserts a *relative* reference
that shifts when the formula is copied, which is exactly the bug a fill task is
trying to avoid.

### "Fill a formula down a column"

Best primitive: select the range with `F5` + `B2:B40` + `Enter`, type the formula,
press **`Ctrl+Enter`** — every selected cell receives it with its own relative
reference. Otherwise: copy the source cell, select the range, `Ctrl+V`.

### "Make a reference absolute"

`F4` with the caret inside a reference cycles `B2` → `$B$2` → `B$2` → `$B2` → `B2`.

### "Sort / filter"

`Ctrl+Shift+L` toggles AutoFilter, then `Alt+↓` in the header cell drives the
filter list. Sort has no default shortcut — it is a ribbon-click task, so click
the `AZ↓` icon under **Data → Sort** rather than a menu, to get one dialog with
header detection already on.

### "Format cells"

`Ctrl+1` opens Format Cells. To skip the dialog: `Ctrl+Shift+1` two decimals ·
`Ctrl+Shift+%` percent · `Ctrl+Shift+~` General · `Ctrl+B` bold · `Ctrl+U`
underline · `Ctrl+Shift+$` currency.

### "See the formulas instead of the values"

``Ctrl+` `` toggles Show Formulas — the single most valuable diagnostic step before
changing a spreadsheet, because it shows what each cell actually computes. Toggle
it back before anything else; it doubles row heights.

### "Recalculate"

`F9` recalculates, `Shift+F9` recalculates only the active sheet. A value that looks
stale usually means the workbook is on manual calculation.

---

## Keyboard-first paths

| Intent | Keys |
|---|---|
| Go To (cell, range, or defined name) | `F5` / `Ctrl+G` / `Ctrl+<name>` |
| Select current block / whole sheet | `Ctrl+A` once / twice |
| Jump to edge of data | `Ctrl+↓` `Ctrl+↑` `Ctrl+→` `Ctrl+←` |
| Select entire column / row | `Ctrl+Space` / `Shift+Space` |
| Edit cell; commit right / down | `F2`; `Tab` / `Enter` |
| Line break inside a cell | `Alt+Enter` (grid focus only) |
| Autosum / fill the selection | `Alt+=` / `Ctrl+Enter` |
| Fill handle downward | `Ctrl+D` |
| Toggle formulas view | ``Ctrl+` `` |
| Cycle a reference's `$` markers | `F4` |
| Recalculate / this sheet | `F9` / `Shift+F9` |
| Format Cells / AutoFilter | `Ctrl+1` / `Ctrl+Shift+L` |
| Find / go to `A1` | `Ctrl+F` / `Ctrl+Home` |
| Next / previous sheet | `Ctrl+PageDown` / `Ctrl+PageUp` |
| Save / Save As / undo | `Ctrl+S` / `F12` / `Ctrl+Z` (repeats) |
| Insert date / time | `Ctrl+;` / `Ctrl+Shift+;` |

---

## Gotchas for screen agents

- **Protected View blocks everything.** A workbook downloaded from the web opens
  in a yellow-bannered Protected View where editing is disabled and the ribbon is
  greyed out. Dismiss with **Enable Editing** — a ribbon-tab button, not a dialog —
  then re-capture, because the grid re-lays-out when the banner disappears.
- **The legacy-format save dialog is modal.** Saving into `.xls` pops "Keep this
  format?", which defaults to *Use Excel 97-2003 Format* and blocks every
  subsequent keystroke. Choose **Use Excel 2007-365 Format** unless the task needs
  legacy — an unhandled run gets stuck here.
- **The locale changes the formula separator.** On a European locale
  `=SUM(B2;B40)` is valid and `=SUM(B2,B40)` is not. Read a formula bar sample
  first: `;` between references means use `;`. Decimal separators differ too.
- **Text vs number is invisible except by alignment.** `1234` and `"1234"` look
  identical; only right- vs left-alignment distinguishes them. A column imported as
  text is the most common "the sum is wrong" bug — check alignment before assuming
  the arithmetic is wrong. Floating point compounds it: `=0.1+0.2` renders `0.3`
  but is not `0.3`, so never verify exact equality from a rendered cell.
- **`Ctrl+A` twice then `Delete` is a data-loss shape.** A whole-column delete
  formats a million rows and can bloat the file. Prefer `Ctrl+A` once, or `F5` +
  range.
- **OneDrive autosave puts the workbook in a lock.** While the title bar reads
  *Saving…*, `Ctrl+S` can be a no-op. Wait for it to clear before asserting the
  edit persisted.
- **The formula bar truncates with a scroll arrow**, so a long formula cannot be
  read from a screenshot of the bar. Toggle ``Ctrl+` `` and read the cell instead.
  Frozen panes likewise break `Ctrl+Home` and `Ctrl+↓`, which land in a header
  region that looks like row 1.
