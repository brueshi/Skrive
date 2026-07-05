// @vitest-environment jsdom
//
// Cut degrading to copy inside barriers (SKR-164 / F34), plus the Enter sibling
// added to the same ticket. Before SKR-166/203 reshaped this neighborhood, cut
// wrote the clipboard successfully and then silently failed to delete for any
// barrier-context range; this pins the fixed behaviour case by case:
//  - a same-code-block / same-table-cell range now deletes through the
//    leaf-local paths Backspace already uses (editCodeText / commitCell),
//    instead of deleteAcross (which only ever addresses a CROSS-leaf range) or
//    clearTableCells (which would otherwise wipe the whole cell);
//  - cross-cell / table-crossing selections already worked post-166 and stay
//    that way;
//  - a block selected as a unit (SKR-203) now gets a real cut instead of a
//    total no-op;
//  - a genuinely undeletable range (two adjacent barriers, no prose between)
//    declines outright — never a silent half-cut.
// jsdom models enough Selection/Range for cellTarget / leafTarget / readSelection
// to run against a real DOM; DataTransfer / ClipboardEvent aren't implemented by
// jsdom, so cut/copy are dispatched as plain Events carrying a minimal fake.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.addRange(range);
}

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}

// jsdom has no DataTransfer / ClipboardEvent; fake the minimal surface the
// clipboard handlers actually touch (setData / getData / preventDefault).
function fakeDataTransfer(): { setData: (t: string, v: string) => void; getData: (t: string) => string } {
  const store = new Map<string, string>();
  return { setData: (t, v) => store.set(t, v), getData: (t) => store.get(t) ?? '' };
}
function fireClipboardEvent(type: 'cut' | 'copy', el: HTMLElement): { text: string; defaultPrevented: boolean } {
  const dt = fakeDataTransfer();
  const ev = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  el.dispatchEvent(ev);
  return { text: dt.getData('text/plain'), defaultPrevented: ev.defaultPrevented };
}
function fireCut(el: HTMLElement) {
  return fireClipboardEvent('cut', el);
}
function fireCopy(el: HTMLElement) {
  return fireClipboardEvent('copy', el);
}

function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}

function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const t = surface.getDocument().blocks.find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return t;
}
function codeBlock(surface: BlockSurface): Extract<BlockNode, { type: 'code_block' }> {
  const t = surface.getDocument().blocks.find((b) => b.type === 'code_block');
  if (!t || t.type !== 'code_block') throw new Error('no code block');
  return t;
}
function paragraphs(surface: BlockSurface): string[] {
  return surface.getDocument().blocks.filter((b): b is Extract<BlockNode, { type: 'paragraph' }> => b.type === 'paragraph').map((b) => plain(b.inline));
}
function cellTargetOf(surface: BlockSurface): { row: number; col: number; start: number; collapsed: boolean } | null {
  return (
    surface as unknown as {
      cellTarget: () => { row: number; col: number; start: number; collapsed: boolean } | null;
    }
  ).cellTarget();
}

describe('cut within a single code block (F34)', () => {
  it('removes the text from the model and puts the slice on the clipboard; one undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nhello world\n```\n') });
    const code = container.querySelector('code')!.firstChild!;
    select(code, 0, code, 5);

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented, 'native cut suppressed').toBe(true);
    expect(text, 'clipboard gets the code slice').toBe('hello');
    expect(codeBlock(surface).text, 'deleted from the model').toBe(' world');

    surface.undo();
    expect(codeBlock(surface).text, 'one undo restores it').toBe('hello world');
  });
});

describe('cut within a single table cell (F34)', () => {
  it('removes just the selected slice, not the whole cell; one undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| abcdef | b |\n| - | - |\n| 1 | 2 |\n') });
    const cell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    select(cell.firstChild!, 0, cell.firstChild!, 2); // select "ab" out of "abcdef"

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented).toBe(true);
    expect(text).toBe('ab');
    expect(plain(tableBlock(surface).rows[0]![0]!), 'only the slice removed').toBe('cdef');

    surface.undo();
    expect(plain(tableBlock(surface).rows[0]![0]!), 'one undo restores it').toBe('abcdef');
  });
});

describe('cut over a cross-cell selection (already fixed by SKR-166)', () => {
  it('clears the covered cells (table shape intact) with the copy payload on the clipboard', () => {
    const surfaceForCopy = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const c0copy = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    const c1copy = container.querySelector('[data-cell-row="1"][data-cell-col="1"]')!;
    select(c0copy.firstChild!, 0, c1copy.firstChild!, c1copy.textContent!.length);
    const { text: copyText } = fireCopy(container);
    void surfaceForCopy;

    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    const c0 = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    const c1 = container.querySelector('[data-cell-row="1"][data-cell-col="1"]')!;
    select(c0.firstChild!, 0, c1.firstChild!, c1.textContent!.length);

    const { text: cutText, defaultPrevented } = fireCut(container);

    expect(defaultPrevented).toBe(true);
    expect(cutText, 'cut clipboard matches what copy produced').toBe(copyText);
    const table = tableBlock(surface);
    expect(table.rows[1]!.map(plain), 'covered cells cleared').toEqual(['', '']);
    expect(table.rows[0]!.map(plain), 'header row untouched').toEqual(['a', 'b']);
    expect(table.rows.length, 'shape unchanged').toBe(2);
  });
});

describe('cut over a prose-into-barrier selection (already fixed by SKR-166)', () => {
  it('deletes the clamped prose part, keeps the barrier, and writes something to the clipboard', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    const headerCell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    select(para.firstChild!, 2, headerCell.firstChild!, 0);

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented).toBe(true);
    expect(text.length > 0, 'clipboard got something (the accepted clamp/copy asymmetry, unchanged here)').toBe(true);
    expect(paragraphs(surface)).toEqual(['he']);
    expect(tableBlock(surface), 'table survives').toBeTruthy();
    expect(plain(tableBlock(surface).rows[0]![0]!), 'header cell untouched').toBe('a');
  });
});

describe('cut with a block selection active (SKR-203 / SKR-164)', () => {
  it('code block: clipboard gets the block payload, block is removed, one undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hi\n\n```\nhello\n```\n') });
    const pre = container.querySelector('pre')!;
    const code = (pre.querySelector('code') ?? pre).firstChild!;
    caretIn(code, 2);
    key(surface, { key: 'Escape' });
    expect(surface.getSelectedBlockIds()).toHaveLength(1);

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented).toBe(true);
    // Selected AS A WHOLE OBJECT, the code block copies with its fence — the same
    // form a fully-covered barrier gets in a cross-block Markdown selection, not
    // the bare inner text a same-leaf range cut produces.
    expect(text, 'clipboard gets the fenced block').toBe('```\nhello\n```');
    expect(surface.getDocument().blocks.find((b) => b.type === 'code_block'), 'block removed').toBeUndefined();
    expect(surface.getSelectedBlockIds(), 'selection cleared').toEqual([]);

    surface.undo();
    expect(surface.getDocument().blocks.find((b) => b.type === 'code_block'), 'one undo restores it').toBeTruthy();
  });

  it('table: clipboard gets the table as Markdown, block is removed, one undo restores it', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hi\n\n${TABLE}\n`) });
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    caretIn(cell.firstChild!, 0);
    key(surface, { key: 'Escape' });
    expect(surface.getSelectedBlockIds()).toHaveLength(1);

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented).toBe(true);
    expect(text).toContain('| a | b |');
    expect(text).toContain('| 1 | 2 |');
    expect(surface.getDocument().blocks.find((b) => b.type === 'table'), 'block removed').toBeUndefined();

    surface.undo();
    expect(surface.getDocument().blocks.find((b) => b.type === 'table'), 'one undo restores it').toBeTruthy();
  });
});

describe('cut declines rather than degrade to copy when genuinely undeletable', () => {
  it('a selection spanning two adjacent barriers with no prose between them', () => {
    const md = '```\ncode1\n```\n```\ncode2\n```\n';
    const surface = new BlockSurface({ container, doc: parseDocument(md) });
    const pres = container.querySelectorAll('pre');
    const code1 = (pres[0]!.querySelector('code') ?? pres[0]!).firstChild!;
    const code2 = (pres[1]!.querySelector('code') ?? pres[1]!).firstChild!;
    select(code1, 2, code2, 2);
    const before = surface.getDocument();

    const { text, defaultPrevented } = fireCut(container);

    expect(defaultPrevented, 'native cut still suppressed (never leaves the mutation to the browser)').toBe(true);
    expect(text, 'clipboard left untouched').toBe('');
    expect(surface.getDocument(), 'model untouched').toBe(before);

    // No history entry: an undo after the decline reaches past it to a real
    // prior edit rather than landing on a no-op snapshot of the decline itself.
    const prior = surface.getDocument();
    surface.undo();
    expect(surface.getDocument(), 'nothing to undo past the initial doc').toBe(prior);
  });
});

describe('Enter over a cross-cell selection (SKR-164, sibling of SKR-166)', () => {
  it('clears the covered cells and lands the caret per the existing in-cell Enter semantics', () => {
    const threeRowTable = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |';
    const surface = new BlockSurface({ container, doc: parseDocument(`${threeRowTable}\n`) });
    const c0 = container.querySelector('[data-cell-row="1"][data-cell-col="0"]')!;
    const c1 = container.querySelector('[data-cell-row="1"][data-cell-col="1"]')!;
    select(c0.firstChild!, 0, c1.firstChild!, c1.textContent!.length);

    key(surface, { key: 'Enter' });

    const table = tableBlock(surface);
    expect(table.rows[1]!.map(plain), 'covered cells cleared').toEqual(['', '']);
    expect(table.rows.length, 'shape unchanged').toBe(3);
    // Normal in-cell Enter steps to the row below (F46): the caret should now sit
    // in the next row, not still in row 1.
    const t = cellTargetOf(surface);
    expect(t?.row, 'caret stepped to the row below, the ordinary Enter-in-cell move').toBe(2);
    expect(t?.col).toBe(0);
  });
});

describe('Enter over a table-crossing selection (SKR-164, sibling of SKR-166)', () => {
  it('clamp-deletes the prose part, then applies the normal Enter split at the resulting caret', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const para = container.querySelector('p')!;
    const headerCell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    select(para.firstChild!, 2, headerCell.firstChild!, 0);

    key(surface, { key: 'Enter' });

    expect(paragraphs(surface), 'prose clamp-deleted, then split by the normal Enter').toEqual(['he', '']);
    expect(tableBlock(surface), 'table survives').toBeTruthy();
    expect(plain(tableBlock(surface).rows[0]![0]!), 'header cell untouched').toBe('a');
  });
});
