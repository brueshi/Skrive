// @vitest-environment jsdom
//
// Backward-selection direction (SKR-192 / F58). A backward drag's direction
// lives only on the Selection's anchor/focus — a Range is always normalized to
// document order — so readSelection must read it there, and every restore
// (writeSelection, the mark-command re-select) must reproduce it via
// setBaseAndExtent, or a following Shift+Arrow extends the wrong end. jsdom
// models Selection.extend / anchor / focus faithfully enough to pin this.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { isSelectionBackward, readSelection, writeSelection } from '../../src/lib/blocksurface/selection';
import { parseDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

/** Select [from, to] within one text node, backward when from > to. */
function dragSelect(node: Node, from: number, to: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.collapse(node, from);
  sel.extend(node, to);
}

describe('isSelectionBackward', () => {
  it('reports a backward drag and not a forward one', () => {
    new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 2, 8);
    expect(isSelectionBackward(window.getSelection()!)).toBe(false);
    dragSelect(tn, 8, 2);
    expect(isSelectionBackward(window.getSelection()!)).toBe(true);
  });

  it('is false for a collapsed selection', () => {
    new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    window.getSelection()!.collapse(tn, 3);
    expect(isSelectionBackward(window.getSelection()!)).toBe(false);
  });

  it('is false when the focus is an ancestor at the document end (the ⌘A shape)', () => {
    new BlockSurface({ container, doc: parseDocument('hello\n') });
    const tn = container.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    sel.collapse(tn, 0);
    sel.extend(container, container.childNodes.length);
    expect(isSelectionBackward(sel)).toBe(false);
  });
});

describe('readSelection direction', () => {
  it('reads a backward drag with anchor after focus', () => {
    new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 8, 2);

    const range = readSelection(container)!;
    expect(range.anchor.offset).toBe(8);
    expect(range.focus.offset).toBe(2);
  });

  it('reads a forward drag with anchor before focus (unchanged)', () => {
    new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 2, 8);

    const range = readSelection(container)!;
    expect(range.anchor.offset).toBe(2);
    expect(range.focus.offset).toBe(8);
  });

  it('round-trips a backward range through writeSelection', () => {
    new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 8, 2);
    const range = readSelection(container)!;

    window.getSelection()!.removeAllRanges();
    writeSelection(container, range, 'test');

    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(false);
    expect(isSelectionBackward(sel)).toBe(true);
    expect(sel.anchorOffset).toBe(8);
    expect(sel.focusOffset).toBe(2);
  });
});

describe('mark-command restore direction', () => {
  it('a mark toggle over a backward drag restores it backward', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 8, 2);

    surface.toggleMark('strong');

    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(false);
    expect(isSelectionBackward(sel)).toBe(true);
    // The same flat range [2, 8) is still selected (now inside the <strong>).
    const range = readSelection(container)!;
    expect(range.anchor.offset).toBe(8);
    expect(range.focus.offset).toBe(2);
  });

  it('a mark toggle over a forward drag stays forward', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const tn = container.querySelector('p')!.firstChild!;
    dragSelect(tn, 2, 8);

    surface.toggleMark('strong');

    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(false);
    expect(isSelectionBackward(sel)).toBe(false);
  });
});
