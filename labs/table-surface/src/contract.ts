// The host contract for the table surface: what the library owns, what the
// host owns, and the seam between them. Types only at this stage; the doc that
// argues each line is ../README.md. Nothing here may import from the app.

/** Bumped on any incompatible change while the seam settles. */
export const CONTRACT_VERSION = 0;

// ---------------------------------------------------------------------------
// Model. Cells are OPAQUE: the library never reads inside one. It compares
// cells by reference to decide what to re-render, so hosts keep cells
// immutable and replace, never mutate.
// ---------------------------------------------------------------------------

export type ColumnAlign = 'left' | 'center' | 'right' | null;

/** `prose`: horizontal rules only. `grid`: filled header, all cells ruled. */
export type TableStyle = 'prose' | 'grid';

export type TableModel<Cell> = {
  /** Per column. Length equals the header row's width. */
  readonly align: readonly ColumnAlign[];
  /** Relative weights, per column. Absent = auto layout. */
  readonly widths?: readonly number[];
  /** Row 0 is the header and is pinned. */
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
  /** Absent = the host's default style. Folio-only, like widths. */
  readonly style?: TableStyle;
};

export type CellRef = { readonly row: number; readonly col: number };

/** Inclusive rectangle, normalized (min <= max). */
export type CellRect = {
  readonly minRow: number;
  readonly minCol: number;
  readonly maxRow: number;
  readonly maxCol: number;
};

// ---------------------------------------------------------------------------
// Selection. Owned and painted by the library; reported to the host so it can
// route Delete, typing, and copy.
// ---------------------------------------------------------------------------

export type GridSelection =
  | { readonly kind: 'cells'; readonly anchor: CellRef; readonly focus: CellRef }
  | { readonly kind: 'row'; readonly index: number }
  | { readonly kind: 'col'; readonly index: number }
  | { readonly kind: 'table' };

// ---------------------------------------------------------------------------
// Intents. A gesture becomes an intent; the host applies it to its document
// and owns the history step. `reduce` is offered for hosts that want the
// library's arithmetic; it is pure and returns null for a no-op.
// ---------------------------------------------------------------------------

export type TableIntent<Cell> =
  | { readonly type: 'insert-row'; readonly index: number }
  | { readonly type: 'insert-column'; readonly index: number }
  | { readonly type: 'remove-row'; readonly index: number }
  | { readonly type: 'remove-column'; readonly index: number }
  /** `to` is a drop boundary, not a final index. Header never moves. */
  | { readonly type: 'move-row'; readonly from: number; readonly to: number }
  | { readonly type: 'move-column'; readonly from: number; readonly to: number }
  | { readonly type: 'set-align'; readonly col: number; readonly align: ColumnAlign }
  | { readonly type: 'set-widths'; readonly widths: readonly number[] }
  | { readonly type: 'set-style'; readonly style: TableStyle | null }
  | { readonly type: 'clear-cells'; readonly rect: CellRect }
  /** A pasted grid landing at `at`; `grow` adds rows/cols to fit. */
  | {
      readonly type: 'fill-cells';
      readonly at: CellRef;
      readonly grid: ReadonlyArray<ReadonlyArray<Cell>>;
      readonly grow: boolean;
    };

export type Reduce = <Cell>(
  model: TableModel<Cell>,
  intent: TableIntent<Cell>,
  emptyCell: () => Cell
) => TableModel<Cell> | null;

// ---------------------------------------------------------------------------
// Geometry. Measured from the real DOM, never modeled. Content coordinates are
// the host scroller's, so chrome rides scroll with no listener.
// ---------------------------------------------------------------------------

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type TableGeometry = {
  readonly box: Box;
  /** cols + 1 x positions, from the header row. */
  readonly colEdges: readonly number[];
  /** rows + 1 y positions. */
  readonly rowEdges: readonly number[];
};

// ---------------------------------------------------------------------------
// Perception as data. The host supplies these from its token source; the
// library emits CSS custom properties from them and ships no stylesheet of
// its own that names a host token.
// ---------------------------------------------------------------------------

export type TableTokens = {
  readonly color: {
    readonly ink: string;
    readonly muted: string;
    readonly rule: string;
    readonly surface: string;
    readonly headerFill: string;
    readonly accent: string;
    readonly selection: string;
  };
  readonly radius: { readonly sm: number; readonly md: number };
  readonly shadow: { readonly lift: string };
  readonly space: { readonly cellX: number; readonly cellY: number };
};

/** Parameters, not implementations. Reduced motion collapses to instant. */
export type MotionSpec = {
  readonly spring: { readonly stiffness: number; readonly damping: number; readonly mass: number };
  readonly reveal: { readonly durationMs: number; readonly easing: string };
};

export type Labels = {
  readonly insertRowAbove: string;
  readonly insertRowBelow: string;
  readonly insertColumnLeft: string;
  readonly insertColumnRight: string;
  readonly deleteRow: string;
  readonly deleteColumn: string;
  readonly addRow: string;
  readonly addColumn: string;
  readonly resizeColumn: string;
  readonly reorderRow: string;
  readonly reorderColumn: string;
};

export type LayoutOptions = {
  /** `pin` breaks content to the measure; `overflow` scrolls. */
  readonly wide: 'pin' | 'overflow';
  readonly stickyHeader: boolean;
  /** Used when a model carries no `style`. */
  readonly defaultStyle: TableStyle;
};

// ---------------------------------------------------------------------------
// The host. Everything the library needs from the editor it lives in.
// ---------------------------------------------------------------------------

export type CaretPosition = 'start' | 'end' | { readonly offset: number };

export interface TableHost<Cell> {
  /** Inside the host's editable. The library never makes one. */
  readonly element: HTMLElement;
  /** Outside the editable, at the scroller's content origin. */
  readonly chromeLayer: HTMLElement;
  toContentCoords(rect: DOMRect): Box;

  /** Fill `into` with the cell's inline DOM. Host-owned text. */
  renderCell(cell: Cell, into: HTMLElement, ref: CellRef): void;
  emptyCell(): Cell;

  /** Land the caret. Host owns caret placement and its quirks. */
  focusCell(ref: CellRef, at: CaretPosition): void;
  clearCaret(): void;

  /** Apply to the document and commit one history step. */
  apply(intent: TableIntent<Cell>): void;
  /** Open the host's own menu for a slice, anchored to a rect. */
  requestMenu(target: { kind: 'row' | 'col'; index: number }, anchor: DOMRect): void;

  onSelectionChange(selection: GridSelection | null): void;

  readonly tokens: TableTokens;
  readonly motion: MotionSpec;
  readonly labels: Labels;
  readonly layout: LayoutOptions;
  reducedMotion(): boolean;
}

// ---------------------------------------------------------------------------
// The surface. What the host holds after mounting one table.
// ---------------------------------------------------------------------------

/** What the host knows about the caret when it forwards a key. */
export type CaretContext = {
  readonly cell: CellRef;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly onFirstLine: boolean;
  readonly onLastLine: boolean;
};

export interface TableSurfaceHandle<Cell> {
  /** Re-render what changed, by cell reference. Never on a keystroke. */
  update(model: TableModel<Cell>): void;
  readonly selection: GridSelection | null;
  setSelection(selection: GridSelection | null): void;
  /** Host calls first for keys inside the table. True = consumed. */
  handleKey(event: KeyboardEvent, caret: CaretContext): boolean;
  cellElement(ref: CellRef): HTMLElement | null;
  refOf(node: Node): CellRef | null;
  geometry(): TableGeometry | null;
  destroy(): void;
}

export interface TableSurface {
  mount<Cell>(host: TableHost<Cell>, model: TableModel<Cell>): TableSurfaceHandle<Cell>;
  readonly reduce: Reduce;
}

// ---------------------------------------------------------------------------
// Clipboard. The host owns the clipboard events; the library owns the grid
// encoding. Cells cross the seam as text and HTML, produced and parsed by
// the host, so the codec stays ignorant of the inline model.
// ---------------------------------------------------------------------------

export type CellPayload = { readonly text: string; readonly html: string };

export type GridCodec = {
  encode(grid: ReadonlyArray<ReadonlyArray<CellPayload>>): { readonly text: string; readonly html: string };
  /** Returns null when the payload is not a grid. */
  decode(payload: { readonly text?: string; readonly html?: string }): string[][] | null;
};

// ---------------------------------------------------------------------------
// DOM markers the host may rely on. The only strings that cross the seam.
// ---------------------------------------------------------------------------

export const CELL_ROW_ATTR = 'data-cell-row';
export const CELL_COL_ATTR = 'data-cell-col';
export const CELL_SELECTED_ATTR = 'data-cell-selected';
export const CELL_DRAGGING_ATTR = 'data-cell-dragging';
