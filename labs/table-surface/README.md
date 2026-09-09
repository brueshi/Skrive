# table-surface — a document table with an explicit host

A lab for the table block: the editable table a writer puts in a document,
built as a library with a written contract to the editor it lives in. The
terminal question: can the table own everything perceptual (layout, chrome,
selection, keyboard grid, clipboard grid, overflow, motion) while the editor
keeps everything textual (inline editing, caret, history, persistence), with
a seam thin enough that a second host is a real option and not a slogan?

It exists because the table is the weakest block on Skrive's surface and no
existing library helps: every "table library" for rich editors is a plugin
for one editor framework, only as good as that framework's caret and
selection model. A document table cannot be separated from its editor's
selection model, so the honest shape is a library that owns the grid and
defers the text. That is also the reimagining's substrate line (commitment V,
Stage 9) tried on one block type before it is tried on the whole surface.

## Who owns what

| The library owns | The host owns |
| --- | --- |
| grid layout and the cell elements | the inline DOM inside a cell |
| hover chrome: handles, rails, resize strips, drop lines | the per-slice menu UI |
| measured geometry, content-coordinate overlays | the scroller and its coordinate origin |
| grid selection: cell rectangle, slice, whole table | routing Delete, typing, and copy for a selection |
| keyboard grid navigation and rectangle extension | the keydown listener itself |
| clipboard grid encoding and decoding | clipboard events and cell text parsing |
| overflow, sticky header, column widths as weights | persisting the model, history steps |
| motion, driven by parameters the host supplies | the token source those parameters come from |

## The five rules

1. **The library never creates a contenteditable.** It renders into an element
   the host provides inside the host's own editable. Skrive's typing latency
   comes from one editable host; a nested editor island is the pattern the
   Stage 2 spike rejected.
2. **Cells are opaque.** The library compares cells by reference and never
   reads inside one. Insert operations ask the host for an empty cell. This is
   what keeps the library ignorant of the inline model and honest about being
   host-agnostic.
3. **Gestures become intents; the host applies them.** The library never
   mutates the host's document. It offers a pure `reduce` for hosts that want
   its arithmetic, and the host commits the history step.
4. **Nothing happens on the keystroke path.** Re-render is driven by
   `update(model)` with reference-diffing per cell. Chrome rebuilds on
   structural change only. Typing in a cell is the host's, in place.
5. **Perception is data.** Colors, radii, spacing, and motion arrive as typed
   values and leave as CSS custom properties. The library ships no stylesheet
   that names a host token, and no motion implementation, only parameters.

## Selection model

One primitive: a cell rectangle, `{ anchor, focus }`. A row or a column is a
rectangle that spans the table, and the shape (cell, cells, row, column,
table) is derived against the model when a menu or a key needs it. This
replaces the shipped pair of a grip-selected slice and a cross-cell rectangle
inferred from native text selection.

Pointer:

- Click in a cell places the caret. Dragging past the origin cell hands the
  pointer to the library, which paints the rectangle; no text highlight runs
  across cells.
- Shift+click extends the rectangle from the caret's cell.
- A handle click selects its row or column. Nothing else happens.
- A handle drag reorders, as shipped. The resize strips are unchanged.
- Right-click, or the keyboard menu key, asks the host for its menu for the
  current selection. The menu is on demand and never the side effect of a
  click.

Keyboard:

- Shift+Arrow extends from the caret's cell.
- Cmd+A escalates: the cell's text, then the cell, then the table.
- Escape steps back down: rectangle to caret, caret to the table as a block.
- Backspace and Delete clear the rectangle's cells. Cmd+Backspace removes the
  row or column when the rectangle spans one in full. Removing structure
  takes a modifier because a plain Delete on a selected row destroyed data
  with nothing in the way.
- Typing over a rectangle clears it and types into the anchor cell, as
  shipped. Tab and the arrows are unchanged.

What goes away: the click that both selects and opens the menu, the Delete
that removes a slice, the two append rails, and the second selection state.
The rails are replaced by one `+` at the end of each axis, sized like the
block insert button and shown on hover.

## Environment facts the contract encodes

- WKWebView drops `pointerup` on a motionless press. Toggles bind to `click`;
  only a real drag uses pointer events. The pointer belongs to the library,
  so this knowledge lives here.
- Caret placement has its own WKWebView quirks. The caret belongs to the host,
  so `focusCell` is the host's and the library only asks.
- Anything beyond GFM (widths, later anything else) is folio-only and must not
  touch `.md` bytes. The model carries `widths` as optional weights for that
  reason; the library never requires them.
- The table style (prose or grid) is a host setting, not a document property,
  so the model carries nothing for it and neither format ever sees it. Grid
  is the default.

## Invariant

This lab imports nothing from `app/`. Since stage 1 the app consumes it by
name as the workspace package `@skrive/table-surface`, never by relative path,
so the seam is the package boundary and nothing else.

## Stage ladder

0. **Contract** (done): the types in `src/contract.ts`, this document, the
   Paper brief and first design pass. No code moves.
1. **Relocate the pure parts** (done): table ops from `range-ops.ts` and the
   geometry arithmetic from `table-chrome.ts` live in `src/ops.ts` and
   `src/geometry.ts` with their tests; the app adapts by name. Byte-identical
   output, one `refactor:` commit.
2. **Relocate render and chrome** (done): `src/render.ts` builds the table
   element from a model with the host rendering each cell; `src/chrome.ts` is
   the shipped painter behind a `TableChromeHost` that addresses tables by id
   and mutates through intents. The app's render case calls the builder and
   its `table-chrome.ts` is a small adapter over the block surface's methods.
   Rendered HTML was diffed byte-identical before and after.
3. **Build against the contract**: grid selection, clipboard grid codec,
   overflow and sticky header, motion, the visual system from the Paper pass.
4. **Sit.** Dogfood in Skrive before any README for outsiders, license files,
   or subtree split.

Exit criterion for stage 2: the app's table behaves identically with the code
on the other side of the seam. Kill criterion, borrowed from the substrate
line's own plan: if a stage starts feeling like a rewrite rather than a
relocation, stop and re-scope.

The running session log is `docs/table-surface-lab-log.md`. Typecheck with
`bunx tsc -p tsconfig.json` from this directory; the root `typecheck` also
covers it.
