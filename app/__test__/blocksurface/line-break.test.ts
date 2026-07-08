// @vitest-environment jsdom
//
// Shift+Enter inserts a hard break (SKR-176 / F83). The `break` inline node, its
// <br> render, and its .folio serialize were already wired; the keydown gesture
// was the missing piece. These pin the gesture end to end: the model gains a
// break, the DOM gets the trailing placeholder <br> a new line needs, plain Enter
// still splits, and the break is one atomic undo step.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { HARD_BREAK_ATTR } from '../../src/lib/blocksurface/render';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function caret(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}

function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}

function firstParagraph(surface: BlockSurface): Extract<BlockNode, { type: 'paragraph' }> {
  const p = surface.getDocument().blocks.find((b): b is Extract<BlockNode, { type: 'paragraph' }> => b.type === 'paragraph');
  if (!p) throw new Error('no paragraph');
  return p;
}

describe('Shift+Enter inserts a hard break (SKR-176)', () => {
  it('inserts a break node at the caret rather than splitting the block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    const t = container.querySelector('p')!.firstChild!;
    caret(t, 3);

    const e = key(surface, { key: 'Enter', shiftKey: true });
    expect(e.defaultPrevented).toBe(true);

    // One block still (no split), with a trailing break appended.
    expect(surface.getDocument().blocks).toHaveLength(1);
    expect(firstParagraph(surface).inline.map((n) => n.kind)).toEqual(['text', 'break']);
  });

  it('renders the hard-break <br> plus a trailing placeholder <br> for the new line', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter', shiftKey: true });

    const brs = container.querySelector('p')!.querySelectorAll('br');
    expect(brs).toHaveLength(2);
    expect(brs[0]!.hasAttribute(HARD_BREAK_ATTR), 'first <br> is the real hard break').toBe(true);
    expect(brs[1]!.hasAttribute(HARD_BREAK_ATTR), 'trailing <br> is the zero-width placeholder').toBe(false);
  });

  it('splits the text run when the caret is mid-word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abcdef\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter', shiftKey: true });

    const inline = firstParagraph(surface).inline;
    expect(inline.map((n) => n.kind)).toEqual(['text', 'break', 'text']);
    expect(inline[0]).toMatchObject({ text: 'abc' });
    expect(inline[2]).toMatchObject({ text: 'def' });
  });

  it('plain Enter still splits the block into two', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abcdef\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter' });
    expect(surface.getDocument().blocks).toHaveLength(2);
  });

  it('undo reverts the break as one atomic step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter', shiftKey: true });
    expect(firstParagraph(surface).inline.map((n) => n.kind)).toEqual(['text', 'break']);

    surface.undo();
    expect(firstParagraph(surface).inline.map((n) => n.kind)).toEqual(['text']);
  });
});
