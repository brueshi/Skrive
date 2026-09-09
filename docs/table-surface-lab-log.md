# table-surface lab — session log

## 2026-09-08 — Stage 0: the contract

Decision: build the table as a host-agnostic table surface with an explicit
host contract, developed under `labs/table-surface`, consumed by the app as a
pinned workspace package once code relocates. Rejected a headless core alone
(solves none of the felt gaps), a standalone widget with its own editing (a
nested editor inside the single editable), and adopting an existing library
(all are editor-framework plugins).

Shipped: `src/contract.ts` (types only, compiles clean), `README.md` (who owns
what, the five rules, stage ladder), the Paper brief at
`planning/table-surface-paper-brief.md`, and the first design pass on the
Skrive Paper file's "Table surface" page.

Contract choices worth remembering:

- Cells are an opaque generic. Insert operations take an `emptyCell` factory
  from the host rather than the library knowing what an empty cell is.
- The library reports selection and forwards keys through `handleKey`; the
  host keeps the single keydown listener and the caret.
- `move-row` and `move-column` take a drop boundary, matching the shipped
  reorder ops; the header is pinned by rule, not by a flag.
- `fill-cells` is the paste intent: a grid landing at a cell with `grow`
  saying whether the table adds rows and columns to fit.
- Tokens and motion are typed values; the library emits custom properties
  and takes spring parameters, never an animation implementation.

Linear: SKR-299. Branch: `joe/reimagining`.

### Same day — a second style

Owner review: the prose table is on brand; also wanted is Skrive's version of
the traditional table, filled header and ruled cells. Designed on the same
Paper page as "Grid style" (at rest light and dark, plus a states board) and
recorded in the contract: `TableStyle = 'prose' | 'grid'`, optional
`TableModel.style` (folio-only, absent = host default), a `set-style` intent,
`headerFill` in the tokens, `defaultStyle` in the layout options. Both styles
share every chrome and selection state; only rules and header fill differ.

### Same day — style is a setting; one selection primitive

Owner: style lives in Settings, grid is the default; the per-table style is
removed from the contract (`LayoutOptions.style`). Selection redesigned to one
primitive, the cell rectangle, with shape derived; handle click only selects;
menu on demand via `requestMenu(selection, anchor, source)`; Backspace clears,
Cmd+Backspace removes a full slice; rails replaced by one `+` per axis. Grounded
in the shipped code: a handle click opened the menu as its only action, Delete
removed the slice, any other key dissolved the selection, and rectangles were
native text selection. README "Selection model" is the spec.

## 2026-09-08 — Stage 1: the pure parts relocate

`src/ops.ts` holds the structural ops over an opaque cell (insert, remove,
move, align, widths, clear) and the `reduce` dispatcher; `src/geometry.ts`
holds the chrome arithmetic (slots, resize trade, normalize, nearest boundary,
drop indicator, hover zone). The app's `range-ops.ts` became adapters through
one `updateTable` helper that hands a block across as a `TableModel` and writes
the result back with `dirty` set; `table-chrome.ts` re-exports the geometry so
block-chrome, the index, and the tests keep their import site. The lab joined
the root workspaces and is aliased by name in tsc, vite, and vitest.

Kept out on purpose: `fill-cells` returns null from `reduce` until the
clipboard work (stage 3), so this commit adds no behavior. One trap: the app's
`spliceMove` helper also serves block reorder, so it stayed in range-ops when
the table ops left.

Gates: typecheck, vitest app 1606 + lab 59, parity 26/26, latency 64/64, macOS
smoke PASS, production build clean. Linear: SKR-300.

## 2026-09-08 — Stage 2: render and chrome relocate

`src/render.ts`: `renderTableElement(model, renderCell)` builds the grid
(colgroup from widths, th/td with coordinates, per-cell direction, physical
alignment) and `applyLiveColWidths` previews a resize; the app's render case
is now one call with its inline renderer as the cell renderer. `src/chrome.ts`:
the shipped painter moved by mechanical substitution (the diff against the
shipped body is only the host calls), behind `TableChromeHost`: `tableIdOf`,
`findTable`, `getSelection`, `onSelectionChange`, `onStructureChange`,
`apply(tableId, intent)`, `requestMenu`, `clearCaret`. The app's
`table-chrome.ts` builds that host from `BlockSurface`'s existing methods, so
the editor's attach call, the block chrome, the index, and the interaction
tests kept their import site and the caret landing and history behavior are
untouched.

Deliberately not the contract's per-table `mount`/`update` yet: the shipped
painter is per-surface and stateless per paint, and turning it per-table is the
selection-model work of stage 3. This stage keeps the seam where the code is.

Verification: rendered table HTML for eight model variants captured before the
change and diffed byte-identical after (block ids normalized, 6.6 KB). Gates:
typecheck, vitest app 1606 + lab 66 (render tests added under jsdom), parity
26/26, latency 64/64, macOS smoke, production build. One trap: a local `host`
rect inside the reorder drag shadowed the new `host` parameter; renamed. By-hand
shell pass for hover, resize, and reorder is the owner's.

## 2026-09-08 — Stage 3, look and chrome (SKR-302)

Two table styles chosen in Settings and stamped on the root as
`data-table-style`, the measure-rule pattern, so a switch is one repaint and
the renderer never learns which is on. Grid (default): 1px frame at radius-sm,
every cell ruled, header filled with `--skrive-table-head` (light-dark
#f3f3f5 / #26282c), 0.5em 0.7em padding, radius carried by the corner cells
because a table ignores overflow clipping. Prose: horizontal rules only, muted
rule under the header, first and last columns flush to the prose edges. The
header is a weight step (600), never a size step, in both.

Adding the preference touched three copies of the default state: the shared
`AppUiState`, the Zig-embedded default in `shell-zig/core/src/persistence.zig`,
and the escaped bytes in `shell-zig/fixtures/persistence.jsonl`; the app-state
parity test and the parity corpus each caught one of the two I would have
missed.

The append rails became one 20px `+` per axis, centered on the right and
bottom edges (`appendSize` / `appendGap` in the geometry); the hover zone
shrank to match. The selection and drag tints gained `:root th/td` selectors
so they outrank the prose header override at equal specificity.

Evidence: `docs/table-surface/at-rest-{grid,prose}-{light,dark}.png` and
`hover-{grid,prose}-light.png`, taken in Chromium through the harness page
with the editor stylesheet loaded. Gates: typecheck, vitest app 1606 + lab 66,
parity 26/26, latency 64/64, macOS smoke, production build.
