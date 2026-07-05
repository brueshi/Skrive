// @vitest-environment jsdom
//
// The saved-selection fallback for command-time resolution (SKR-173, absorbing
// SKR-151). WKWebView collapses a blurred contenteditable's selection the moment a
// menu takes focus, so a palette command (restyle, list, link) would read no live
// selection and no-op. The surface records the last in-surface range from the
// rAF-coalesced observer; currentInlineBlock / currentConvertibleBlock / leafTarget
// fall back to it ONLY when live resolution is null. Chromium preserves the blurred
// selection, so the gate is blind — these pin the behaviour directly by clearing the
// DOM selection to simulate the blur, then driving the same command paths.
//
// Also covers the range-restore primitives (setSelectionRange / setCrossBlockSelection):
// they must produce the same selections as the old removeAllRanges()+addRange() form.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { BLOCK_ID_ATTR } from '../../src/lib/blocksurface/render';
import { setSelectionRange, setCrossBlockSelection, flatOffsetFromDOM } from '../../src/lib/blocksurface/selection';
import { parseDocument, serializeDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

// A private-method view, matching the direct-drive style of turn-into.test.ts.
type SurfaceInternals = {
  emitSelection(): void;
  recordSelection(): void;
  currentInlineBlock(): { block: { id: string }; caret: number; collapsed: boolean } | null;
  leafTarget(): { leaf: { id: string }; start: number; end: number; collapsed: boolean; spansBlocks: boolean } | null;
  lastSelection: { blockId: string; start: number; end: number } | null;
  blockSel: string[];
};
const inner = (s: BlockSurface): SurfaceInternals => s as unknown as SurfaceInternals;

function blockEl(index: number): HTMLElement {
  const els = container.querySelectorAll(`[${BLOCK_ID_ATTR}]`);
  return els[index] as HTMLElement;
}

// Place a live selection over [start, end) in the (top-level, single text node)
// block, then let the observer record it — exactly what happens a frame before the
// user reaches the palette. Returns the block's id.
function selectAndRecord(s: BlockSurface, index: number, start: number, end: number): string {
  const el = blockEl(index);
  const node = el.firstChild!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  sel.addRange(range);
  inner(s).emitSelection();
  return el.getAttribute(BLOCK_ID_ATTR)!;
}

function clearSelection(): void {
  window.getSelection()!.removeAllRanges();
}

describe('saved-selection fallback: resolution', () => {
  it('currentInlineBlock falls back to the saved caret when the selection is cleared', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n\nsecond block\n') });
    const id = selectAndRecord(s, 0, 5, 5);
    clearSelection();

    const cur = inner(s).currentInlineBlock();
    expect(cur).not.toBeNull();
    expect(cur!.block.id).toBe(id);
    expect(cur!.caret).toBe(5);
    expect(cur!.collapsed).toBe(true);
  });

  it('leafTarget falls back to the saved range when the selection is cleared', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n\nsecond block\n') });
    const id = selectAndRecord(s, 0, 2, 7);
    clearSelection();

    const t = inner(s).leafTarget();
    expect(t).not.toBeNull();
    expect(t!.leaf.id).toBe(id);
    expect(t!.start).toBe(2);
    expect(t!.end).toBe(7);
    expect(t!.collapsed).toBe(false);
    expect(t!.spansBlocks).toBe(false);
  });

  it('a live caret in the surface never uses the fallback (live wins)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n\nsecond block\n') });
    selectAndRecord(s, 0, 5, 5); // records block 0
    // Now put a real caret in block 1 without recording; live resolution must win.
    const el = blockEl(1);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(el.firstChild!, 3);
    range.collapse(true);
    sel.addRange(range);

    const t = inner(s).leafTarget();
    expect(t!.leaf.id).toBe(el.getAttribute(BLOCK_ID_ATTR));
    expect(t!.start).toBe(3);
  });
});

describe('saved-selection fallback: refusals', () => {
  it('refuses when the saved block is gone from the doc', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 0, 0);
    clearSelection();
    inner(s).lastSelection = { blockId: 'no-such-block', start: 0, end: 0 };

    expect(inner(s).leafTarget()).toBeNull();
    expect(inner(s).currentInlineBlock()).toBeNull();
  });

  it('clamps saved offsets past the current block length', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello\n') }); // length 5
    const id = selectAndRecord(s, 0, 0, 0);
    clearSelection();
    inner(s).lastSelection = { blockId: id, start: 999, end: 999 };

    const t = inner(s).leafTarget();
    expect(t!.start).toBe(5);
    expect(t!.end).toBe(5);
    const cur = inner(s).currentInlineBlock();
    expect(cur!.caret).toBe(5);
  });

  it('never fires while a block selection is active', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const id = selectAndRecord(s, 0, 2, 7);
    clearSelection();
    inner(s).blockSel = [id]; // an SKR-203 block selection owns the gesture

    expect(inner(s).leafTarget()).toBeNull();
    expect(inner(s).currentInlineBlock()).toBeNull();
  });

  it('records nothing while a block selection is active', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 1, 4); // seeds lastSelection
    const before = inner(s).lastSelection;
    inner(s).blockSel = ['x'];
    // A live selection appears, but recording must skip it.
    selectAndRecord(s, 0, 6, 9);
    expect(inner(s).lastSelection).toEqual(before);
  });
});

describe('saved-selection fallback: commands with a cleared selection', () => {
  it('block restyle converts the saved block (setBlockType)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n\nsecond\n') });
    selectAndRecord(s, 0, 3, 3);
    clearSelection();

    s.setBlockType({ kind: 'heading', level: 2 });

    const md = serializeDocument(s.getDocument());
    expect(md).toContain('## hello world');
    expect(serializeDocument(parseDocument(md))).toBe(md); // round-trip stable
  });

  it('list toggle wraps the saved block (toggleList)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 3, 3);
    clearSelection();

    s.toggleList('bullet_list');

    const md = serializeDocument(s.getDocument());
    expect(md).toContain('- hello world');
  });

  it('link begin + commit applies over the saved range (beginLink/commitLink)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 0, 5); // "hello"
    clearSelection();

    expect(s.beginLink()).toBe(true);
    s.commitLink('https://example.com');

    const md = serializeDocument(s.getDocument());
    expect(md).toContain('[hello](https://example.com)');
  });

  it('link begin refuses a saved collapsed caret (a caret is not linkable)', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 4, 4);
    clearSelection();
    expect(s.beginLink()).toBe(false);
  });
});

describe('cancelLink restores the saved range as the live selection', () => {
  it('re-selects the range the link editor was opened over', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    selectAndRecord(s, 0, 0, 5);
    expect(s.beginLink()).toBe(true);
    // The URL input takes focus and (in WKWebView) collapses the selection.
    clearSelection();

    s.cancelLink();

    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    const range = sel.getRangeAt(0);
    const el = blockEl(0);
    expect(flatOffsetFromDOM(el, range.startContainer, range.startOffset)).toBe(0);
    expect(flatOffsetFromDOM(el, range.endContainer, range.endOffset)).toBe(5);
    // The document is untouched — cancel never links.
    expect(serializeDocument(s.getDocument())).toBe('hello world\n');
  });
});

describe('range-restore primitive parity (F65)', () => {
  it('setSelectionRange selects the same flat range it is given', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    void s;
    const el = blockEl(0);
    setSelectionRange(el, 2, 8);

    const sel = window.getSelection()!;
    const range = sel.getRangeAt(0);
    expect(flatOffsetFromDOM(el, range.startContainer, range.startOffset)).toBe(2);
    expect(flatOffsetFromDOM(el, range.endContainer, range.endOffset)).toBe(8);
    expect(range.collapsed).toBe(false);
  });

  it('setSelectionRange places a collapsed caret when start === end', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    void s;
    const el = blockEl(0);
    setSelectionRange(el, 4, 4);

    const range = window.getSelection()!.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    expect(flatOffsetFromDOM(el, range.startContainer, range.startOffset)).toBe(4);
  });

  it('setCrossBlockSelection spans from one block to another', () => {
    const s = new BlockSurface({ container, doc: parseDocument('hello world\n\nsecond block\n') });
    void s;
    const a = blockEl(0);
    const b = blockEl(1);
    setCrossBlockSelection(a, 2, b, 6);

    const range = window.getSelection()!.getRangeAt(0);
    expect(flatOffsetFromDOM(a, range.startContainer, range.startOffset)).toBe(2);
    expect(flatOffsetFromDOM(b, range.endContainer, range.endOffset)).toBe(6);
    expect(range.collapsed).toBe(false);
  });
});
