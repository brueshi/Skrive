// @vitest-environment jsdom
//
// Bubble drag gate + live anchor rect (SKR-184 / F72, F73). While a pointer drag is
// in progress the summary reports `dragging: true` so the bubble stays hidden until
// release (it shouldn't chase the growing selection); currentSelectionRect exposes
// the live geometry so a menu can re-anchor on scroll instead of a frozen rect.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 10, bottom: 20, left: 5, right: 40, width: 35, height: 10, x: 5, y: 10, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

function selectHello(surface: BlockSurface): void {
  const tn = container.querySelector('p')!.firstChild!;
  window.getSelection()!.setBaseAndExtent(tn, 0, tn, 5);
}

describe('drag gate (SKR-184)', () => {
  it('reports dragging between mousedown and release', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectHello(surface);
    expect(surface.getSelectionInfo()?.dragging).toBe(false);

    container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(surface.getSelectionInfo()?.dragging).toBe(true);

    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(surface.getSelectionInfo()?.dragging).toBe(false);
  });

  it('a click also ends the drag (the motionless-press fallback)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectHello(surface);
    container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(surface.getSelectionInfo()?.dragging).toBe(true);

    container.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(surface.getSelectionInfo()?.dragging).toBe(false);
  });
});

describe('live anchor rect (SKR-184)', () => {
  it('returns the live selection rect, and null with no in-surface selection', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectHello(surface);
    const rect = surface.currentSelectionRect();
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(10);
    expect(rect!.left).toBe(5);

    window.getSelection()!.removeAllRanges();
    expect(surface.currentSelectionRect()).toBeNull();
  });
});
