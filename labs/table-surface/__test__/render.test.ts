// @vitest-environment jsdom
// The table element builder. String cells; the renderer just writes text.

import { describe, expect, it } from 'vitest';
import { applyLiveColWidths, renderTableElement, type TableModel } from '../src';

const text = (cell: string, into: HTMLElement) => {
  into.textContent = cell;
};

function model(extra: Partial<TableModel<string>> = {}): TableModel<string> {
  return {
    align: [null, 'right'],
    rows: [
      ['a', 'b'],
      ['1', '2']
    ],
    ...extra
  };
}

describe('renderTableElement', () => {
  it('renders the header as th, the body as td, with coordinates and per-cell direction', () => {
    const el = renderTableElement(model(), text);
    const cells = Array.from(el.querySelectorAll('th, td'));
    expect(cells.map((c) => c.tagName)).toEqual(['TH', 'TH', 'TD', 'TD']);
    expect(cells.map((c) => `${c.getAttribute('data-cell-row')},${c.getAttribute('data-cell-col')}`)).toEqual([
      '0,0',
      '0,1',
      '1,0',
      '1,1'
    ]);
    expect(cells.every((c) => c.getAttribute('dir') === 'auto')).toBe(true);
    expect(el.getAttribute('dir')).toBeNull();
  });

  it('applies a column alignment physically and leaves null columns alone', () => {
    const el = renderTableElement(model(), text);
    const [a, b] = Array.from(el.querySelectorAll('th')) as HTMLElement[];
    expect(a!.style.textAlign).toBe('');
    expect(b!.style.textAlign).toBe('right');
  });

  it('hands each cell to the host renderer with its ref', () => {
    const seen: string[] = [];
    renderTableElement(model(), (cell, into, ref) => {
      seen.push(`${ref.row}:${ref.col}=${cell}`);
      into.textContent = cell;
    });
    expect(seen).toEqual(['0:0=a', '0:1=b', '1:0=1', '1:1=2']);
  });

  it('switches to fixed layout with a normalized colgroup when widths are set', () => {
    const el = renderTableElement(model({ widths: [3, 1] }), text);
    expect(el.classList.contains('has-col-widths')).toBe(true);
    const cols = Array.from(el.querySelectorAll('colgroup > col')) as HTMLElement[];
    expect(cols.map((c) => c.style.width)).toEqual(['75%', '25%']);
  });

  it('ignores absent, mismatched, or all-zero widths', () => {
    expect(renderTableElement(model(), text).querySelector('colgroup')).toBeNull();
    expect(renderTableElement(model({ widths: [1] }), text).querySelector('colgroup')).toBeNull();
    expect(renderTableElement(model({ widths: [0, 0] }), text).querySelector('colgroup')).toBeNull();
  });
});

describe('applyLiveColWidths', () => {
  it('creates the colgroup on a width-free table and writes percentages', () => {
    const el = renderTableElement(model(), text);
    applyLiveColWidths(el, [1, 3]);
    expect(el.classList.contains('has-col-widths')).toBe(true);
    const cols = Array.from(el.querySelectorAll('colgroup > col')) as HTMLElement[];
    expect(cols.map((c) => c.style.width)).toEqual(['25%', '75%']);
  });

  it('is a no-op for an all-zero preview', () => {
    const el = renderTableElement(model(), text);
    applyLiveColWidths(el, [0, 0]);
    expect(el.querySelector('colgroup')).toBeNull();
  });
});
