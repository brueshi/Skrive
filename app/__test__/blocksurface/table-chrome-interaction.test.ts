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
