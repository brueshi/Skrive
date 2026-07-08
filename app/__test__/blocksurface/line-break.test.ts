// @vitest-environment jsdom
//
// Shift+Enter inserts a hard break (SKR-176 / F83). The `break` inline node, its
// <br> render, and its .folio serialize were already wired; the keydown gesture
// was the missing piece. These pin the gesture end to end: the model gains a
// break, the new line gets a zero-width caret filler the caret can anchor to,
// plain Enter still splits, and the break is one atomic undo step.

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

  it('renders the hard-break <br> plus a zero-width caret filler on the new line', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter', shiftKey: true });

    const p = container.querySelector('p')!;
    const brs = p.querySelectorAll('br');
    expect(brs).toHaveLength(1);
    expect(brs[0]!.hasAttribute(HARD_BREAK_ATTR), 'the <br> is the real hard break').toBe(true);
    // The last node is a zero-width caret filler (U+200B) text node — the caret's
    // paintable anchor on the empty new line.
    const lastChild = p.lastChild!;
    expect(lastChild.nodeType).toBe(Node.TEXT_NODE);
    expect((lastChild as Text).data).toBe('\u200b');
  });

  it('lands the caret in the filler on the new line, not at the block start', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    caret(container.querySelector('p')!.firstChild!, 3);
    key(surface, { key: 'Enter', shiftKey: true });

    // The regression: the caret must anchor in the trailing filler text node (the
    // new line), not snap back into the paragraph's first text node.
    const sel = window.getSelection()!;
    expect(sel.anchorNode).toBe(container.querySelector('p')!.lastChild);
    expect(sel.anchorOffset).toBe(0);
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
