// @vitest-environment jsdom
//
// The clipboard grid: a rectangle of cells copies as tab-separated text plus an
// HTML table (what spreadsheets read), and a grid payload pasted with the caret
// in a cell fills the table from that cell, growing it to fit. A single-cell
// payload is text and takes the ordinary paste. jsdom has no DataTransfer /
// ClipboardEvent, so the events carry a minimal fake, as cut-selection does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, serializeDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';
const plain = (inline: InlineNode[]): string => inline.map((n) => (n.kind === 'text' ? n.text : n.kind === 'break' ? '\n' : '')).join('');

function fakeDataTransfer(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return { setData: (t: string, v: string) => store.set(t, v), getData: (t: string) => store.get(t) ?? '', items: [], files: [], types: [...store.keys()] };
}
function fire(type: 'copy' | 'cut' | 'paste', seed: Record<string, string> = {}) {
  const dt = fakeDataTransfer(seed);
  const ev = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  container.dispatchEvent(ev);
  return { text: dt.getData('text/plain'), html: dt.getData('text/html'), defaultPrevented: ev.defaultPrevented };
}
function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const t = surface.getDocument().blocks.find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return t;
}
function grid(surface: BlockSurface): string[][] {
  return tableBlock(surface).rows.map((row) => row.map(plain));
}
function caretIn(row: number, col: number, offset = 0): void {
  const el = container.querySelector(`[data-cell-row="${row}"][data-cell-col="${col}"]`)!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(el.firstChild ?? el, offset);
  r.collapse(true);
  sel.addRange(r);
}
function caretCell(): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('[data-cell-row]');
  return el ? [Number(el.dataset.cellRow), Number(el.dataset.cellCol)] : null;
}

describe('copying a rectangle', () => {
  it('writes tab-separated text and an HTML table carrying the cells\' markup', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a | **b** |\n| - | - |\n| 1 | 2 |\n') });
    surface.selectTableCells(tableBlock(surface).id, { row: 0, col: 0 }, { row: 1, col: 1 });

    const { text, html, defaultPrevented } = fire('copy');

    expect(defaultPrevented).toBe(true);
    expect(text).toBe('a\tb\n1\t2');
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toMatch(/<tr><td>1<\/td><td>2<\/td><\/tr>/);
  });
});

describe('pasting a grid with the caret in a cell', () => {
  it('fills from the caret cell, grows the table to fit, and lands the caret at the last filled cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 1);

    const { defaultPrevented } = fire('paste', { 'text/plain': 'x\ty\nz\tw\n' });

    expect(defaultPrevented).toBe(true);
    expect(grid(surface)).toEqual([
      ['a', 'b', ''],
      ['1', 'x', 'y'],
      ['', 'z', 'w']
    ]);
    expect(tableBlock(surface).align).toHaveLength(3);
    expect(caretCell()).toEqual([2, 2]);
    const md = serializeDocument(surface.getDocument());
    expect(serializeDocument(parseDocument(md)), 'stable').toBe(md);

    surface.undo();
    expect(grid(surface), 'one undo restores the table').toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('prefers the HTML table flavor and reads inline Markdown per cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(0, 0);

    fire('paste', {
      'text/html': '<table><tr><td>**bold**</td><td>plain</td></tr></table>',
      'text/plain': '**bold**\tplain'
    });

    expect(grid(surface)[0]).toEqual(['bold', 'plain']);
    expect(tableBlock(surface).rows[0]![0]![0]).toMatchObject({ kind: 'text', text: 'bold', marks: { strong: true } });
  });

  it('a one-cell payload is text and takes the ordinary paste', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    caretIn(1, 0, 1); // after "1"

    fire('paste', { 'text/html': '<table><tr><td>Q</td></tr></table>', 'text/plain': 'Q' });

    expect(grid(surface)).toEqual([
      ['a', 'b'],
      ['1Q', '2']
    ]);
  });

  it('with a grid selection active, fills from its home cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`${TABLE}\n`) });
    surface.selectTableCells(tableBlock(surface).id, { row: 1, col: 0 }, { row: 1, col: 1 });

    fire('paste', { 'text/plain': 'p\tq' });

    expect(grid(surface)[1]).toEqual(['p', 'q']);
    expect(surface.getTableSelection()).toBeNull();
  });

  it('a grid pasted into prose stays the ordinary paste', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(`hello\n\n${TABLE}\n`) });
    const p = container.querySelector('p')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(p.firstChild!, 5);
    r.collapse(true);
    sel.addRange(r);

    fire('paste', { 'text/plain': 'x\ty' });

    expect(grid(surface), 'the table is untouched').toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });
});
