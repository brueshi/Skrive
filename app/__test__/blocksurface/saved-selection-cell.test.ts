// @vitest-environment jsdom
//
// The saved-selection fallback's cell flavor (SKR-220). SKR-173 cured the leaf
// blindspot (currentInlineBlock / currentConvertibleBlock / leafTarget) but left
// cellTarget reading the live selection only: a caret in a table cell carries no
// block id of its own (only the enclosing table does), so when WKWebView collapses
// a blurred selection the moment a menu takes focus, cellTarget saw nothing useful
// to fall back to — a palette mark command (bold/italic/code) over a cell would
// degrade to the leaf path or refuse outright. This mirrors saved-selection.test.ts's
// structure exactly, one flavor over.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { BLOCK_ID_ATTR } from '../../src/lib/blocksurface/render';
import { parseDocument, serializeDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';

// A private-method view, matching saved-selection.test.ts's direct-drive style.
type SurfaceInternals = {
  emitSelection(): void;
  cellTarget(): {
    tableId: string;
    row: number;
    col: number;
    cellEl: HTMLElement;
    start: number;
    end: number;
    collapsed: boolean;
    spansCells: boolean;
  } | null;
  lastSelection:
    | { blockId: string; start: number; end: number }
    | { tableId: string; row: number; col: number; start: number; end: number }
    | null;
  blockSel: string[];
};
const inner = (s: BlockSurface): SurfaceInternals => s as unknown as SurfaceInternals;

function cellEl(row: number, col: number): HTMLElement {
  return container.querySelector(`[data-cell-row="${row}"][data-cell-col="${col}"]`) as HTMLElement;
}

function tableId(): string {
  return container.querySelector('table')!.getAttribute(BLOCK_ID_ATTR)!;
}

function tableBlock(s: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const t = s.getDocument().blocks.find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table in doc');
  return t;
}

// Place a live selection over [start, end) in a cell's (single text node) content,
// then let the observer record it — exactly what happens a frame before the user
// reaches the palette.
function selectCellAndRecord(s: BlockSurface, row: number, col: number, start: number, end: number): void {
  const el = cellEl(row, col);
  const node = el.firstChild!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  sel.addRange(range);
  inner(s).emitSelection();
}

function clearSelection(): void {
  window.getSelection()!.removeAllRanges();
}

describe('cell saved-selection fallback: resolution', () => {
  it('cellTarget resolves the saved cell range after the live selection clears', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 1); // "1" in the body row's first cell
    clearSelection();

    const cell = inner(s).cellTarget();
    expect(cell).not.toBeNull();
    expect(cell!.tableId).toBe(tableId());
    expect(cell!.row).toBe(1);
    expect(cell!.col).toBe(0);
    expect(cell!.start).toBe(0);
    expect(cell!.end).toBe(1);
    expect(cell!.collapsed).toBe(false);
  });

  it('a live cell selection never uses the fallback (live wins)', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 0); // records cell (1, 0)
    // Now put a real caret in cell (1, 1) without recording; live resolution must win.
    const el = cellEl(1, 1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(el.firstChild!, 1);
    range.collapse(true);
    sel.addRange(range);

    const cell = inner(s).cellTarget();
    expect(cell!.row).toBe(1);
    expect(cell!.col).toBe(1);
    expect(cell!.start).toBe(1);
  });
});

describe('cell saved-selection fallback: refusals', () => {
  it('refuses when the saved table is gone from the doc', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 0);
    clearSelection();
    inner(s).lastSelection = { tableId: 'no-such-table', row: 0, col: 0, start: 0, end: 0 };

    expect(inner(s).cellTarget()).toBeNull();
  });

  it('refuses when the saved row is out of range for the current table shape', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 0);
    clearSelection();
    // Simulates the row having been removed between save and use: the table still
    // exists, but row 5 doesn't (this 2-row table only has rows 0 and 1).
    inner(s).lastSelection = { tableId: tableId(), row: 5, col: 0, start: 0, end: 0 };

    expect(inner(s).cellTarget()).toBeNull();
  });

  it('refuses when the saved column is out of range for the current table shape', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 0);
    clearSelection();
    inner(s).lastSelection = { tableId: tableId(), row: 1, col: 9, start: 0, end: 0 };

    expect(inner(s).cellTarget()).toBeNull();
  });

  it('never fires while a block selection is active', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    const id = tableId();
    selectCellAndRecord(s, 1, 0, 0, 1);
    clearSelection();
    inner(s).blockSel = [id]; // an SKR-203 block selection owns the gesture

    expect(inner(s).cellTarget()).toBeNull();
  });

  it('clamps saved offsets past the current cell length', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) }); // cell (1,0) is "1", length 1
    selectCellAndRecord(s, 1, 0, 0, 0);
    clearSelection();
    inner(s).lastSelection = { tableId: tableId(), row: 1, col: 0, start: 999, end: 999 };

    const cell = inner(s).cellTarget();
    expect(cell).not.toBeNull();
    expect(cell!.start).toBe(1);
    expect(cell!.end).toBe(1);
    expect(cell!.collapsed).toBe(true);
  });
});

describe('cell saved-selection fallback: commands with a cleared selection', () => {
  it('bold (toggleMark) applies to the saved cell range through the cell path', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 1); // the whole "1"
    clearSelection();

    s.toggleMark('strong');

    const table = tableBlock(s);
    const marked = table.rows[1]![0]!;
    expect(marked.some((n) => n.kind === 'text' && n.text === '1' && n.marks.strong === true)).toBe(true);
    // The sibling cell is untouched.
    const other = table.rows[1]![1]!;
    expect(other.some((n) => n.kind === 'text' && n.marks.strong === true)).toBe(false);

    const md = serializeDocument(s.getDocument());
    expect(serializeDocument(parseDocument(md)), 'round-trip stable').toBe(md);
  });

  it('a collapsed saved caret in a cell refuses the mark (nothing to mark)', () => {
    const s = new BlockSurface({ container, doc: parseDocument(TABLE) });
    selectCellAndRecord(s, 1, 0, 0, 0); // collapsed caret
    clearSelection();

    s.toggleMark('strong');

    const table = tableBlock(s);
    expect(table.rows[1]![0]!.some((n) => n.kind === 'text' && n.marks.strong === true)).toBe(false);
  });
});
