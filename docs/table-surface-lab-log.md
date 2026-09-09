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
