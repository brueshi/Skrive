// @vitest-environment jsdom
//
// Pointer-path regression for the table hover chrome (SKR-266 B2): the geometry
// tests (table-chrome.test.ts) cover the pure slot math, and the selection tests
// drive the surface API directly — neither exercises the hover state machine. This
// one does, pinning the bug where moving the pointer onto a handle to click it
// cleared the hover and erased the handle out from under the cursor.
//
// jsdom reports zero-size rects, so the slots land at 0,0 — fine here: we assert on
// element PRESENCE and click wiring, not pixel positions (those are unit-tested).
// requestAnimationFrame is made synchronous so a schedule() paints immediately.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { attachTableChrome, type TableChromeHandle } from '../../src/lib/blocksurface/table-chrome';
import { parseDocument } from '../../src/lib/blockmodel';

const TABLE = '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';

let scroller: HTMLElement;
let surfaceHost: HTMLElement;
let layer: HTMLElement;
let surface: BlockSurface;
let chrome: TableChromeHandle;
let rafSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Run rAF callbacks synchronously so a schedule() paints in the same tick.
  rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  scroller = document.createElement('div');
  surfaceHost = document.createElement('div');
  layer = document.createElement('div');
  scroller.appendChild(surfaceHost);
  scroller.appendChild(layer);
  document.body.appendChild(scroller);
  surface = new BlockSurface({ container: surfaceHost, doc: parseDocument(`${TABLE}\n`) });
  chrome = attachTableChrome({ surface: surfaceHost, scroller, layer, blockSurface: surface });
});

afterEach(() => {
  chrome.destroy();
  scroller.remove();
  rafSpy.mockRestore();
});

function hover(target: Element): void {
  target.dispatchEvent(new Event('pointerover', { bubbles: true }));
}
function colHandle(): HTMLButtonElement | null {
  return layer.querySelector('.sk-table-chrome--col-handle');
}
function cell(row: number, col: number): Element {
  const el = surfaceHost.querySelector(`[data-cell-row="${row}"][data-cell-col="${col}"]`);
  if (!el) throw new Error(`no cell ${row},${col}`);
  return el;
}

describe('the hovered handle survives moving the pointer onto it', () => {
  it('keeps the column handle painted when the pointer moves from the cell onto the handle', () => {
    hover(cell(0, 1)); // hover column 1's header cell
    const handle = colHandle();
    expect(handle).not.toBeNull();

    // Move onto the handle itself (a layer element). The bug cleared the hover here.
    hover(handle!);

    expect(colHandle()).not.toBeNull();
  });

  it('clicking the column handle selects that column', () => {
    hover(cell(0, 2));
    const handle = colHandle();
    expect(handle).not.toBeNull();

    hover(handle!);
    handle!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(surface.getTableSelection()).toEqual({
      tableId: surface.getDocument().blocks.find((b) => b.type === 'table')!.id,
      kind: 'col',
      index: 2
    });
  });
});

describe('the selected handle persists with the pointer away', () => {
  it('keeps the selected column handle painted after the pointer leaves the table', () => {
    surface.selectTableColumn(surface.getDocument().blocks.find((b) => b.type === 'table')!.id, 1);
    // No hover at all — only the persistent selected handle should be present.
    const handle = colHandle();
    expect(handle).not.toBeNull();
    expect(handle!.classList.contains('is-selected')).toBe(true);
  });
});

describe('dragging a column handle reorders the column', () => {
  // jsdom rects are zero, so the drop boundary resolves to 0 regardless of the
  // pointer's x — fine here: we assert the click-vs-drag state machine (a drag
  // commits a move and swallows the click), not the pixel drop target (unit-tested).
  const headerText = (): string[] => {
    const t = surface.getDocument().blocks.find((b) => b.type === 'table')!;
    if (t.type !== 'table') throw new Error('no table');
    return t.rows[0]!.map((cell) => cell.map((n) => (n.kind === 'text' ? n.text : '')).join(''));
  };

  it('commits a column move on drag and swallows the trailing click', () => {
    hover(cell(0, 2)); // surface column 2's handle (c)
    const handle = colHandle()!;
    expect(handle).not.toBeNull();
    const tableId = surface.getDocument().blocks.find((b) => b.type === 'table')!.id;

    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true }));
    scroller.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 0, bubbles: true }));
    // Mid-drag the source column is tinted (feedback for what is moving).
    expect(surfaceHost.querySelectorAll('[data-cell-col="2"][data-cell-dragging]').length).toBeGreaterThan(0);
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

    // Column 2 (c) dragged to the front boundary: order becomes c, a, b.
    expect(headerText()).toEqual(['c', 'a', 'b']);
    // The drag tint is cleared on drop.
    expect(surfaceHost.querySelectorAll('[data-cell-dragging]').length).toBe(0);

    // The click the browser fires after a drag is swallowed — no menu re-open — so
    // the moved column stays grip-selected at its new index 0.
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(surface.getTableSelection()).toEqual({ tableId, kind: 'col', index: 0 });
  });

  it('a plain click (no drag past the threshold) still selects and does not reorder', () => {
    hover(cell(0, 1));
    const handle = colHandle()!;
    handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, button: 0, bubbles: true }));
    // A sub-threshold jiggle, then release: stays a click.
    scroller.dispatchEvent(new MouseEvent('pointermove', { clientX: 2, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(headerText()).toEqual(['a', 'b', 'c']); // unchanged
    expect(surface.getTableSelection()).toEqual({
      tableId: surface.getDocument().blocks.find((b) => b.type === 'table')!.id,
      kind: 'col',
      index: 1
    });
  });
});
