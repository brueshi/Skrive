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
