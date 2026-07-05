// @vitest-environment jsdom
//
// ⌘⇧E / ⌘⇧B double-fire (SKR-171 / F63). The surface's mark chords (⌘B/⌘I/⌘E)
// didn't exclude Shift, so ⌘⇧B and ⌘⇧E both toggled a mark on the selection
// *and* left the key unconsumed (no preventDefault would have helped anyway,
// since toggleMark ran either way) for the window-level binding underneath
// (backlinks panel / cycle layout) to also fire. The fix: the mark branch is
// gated on `!e.shiftKey`, so a shifted chord is a pure no-op here and the
// event is left completely unconsumed for the app-level dispatcher.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  sel.addRange(range);
}

function key(surface: BlockSurface, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
  return e;
}

function paragraph(surface: BlockSurface): InlineNode[] {
  const p = surface.getDocument().blocks.find((b): b is Extract<BlockNode, { type: 'paragraph' }> => b.type === 'paragraph');
  if (!p) throw new Error('no paragraph');
  return p.inline;
}

// The tests always select the leading "hello" of "hello world" — after a
// toggle that splits the run, the marked segment is the first inline node.
// (Checking every node would wrongly require the untouched "world" to carry
// the mark too.)
function hasMark(inline: InlineNode[], mark: 'strong' | 'em' | 'code'): boolean {
  const first = inline[0];
  return first !== undefined && first.kind === 'text' && first.marks[mark] === true;
}

describe('mark chords exclude Shift (SKR-171)', () => {
  it('Cmd+B bolds the selection; Cmd+Shift+B does not touch marks', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const text = container.querySelector('p')!.firstChild!;
    select(text, 0, text, 5);

    const shifted = key(surface, { code: 'KeyB', key: 'b', metaKey: true, shiftKey: true });
    expect(hasMark(paragraph(surface), 'strong'), 'shifted chord must not bold').toBe(false);
    expect(shifted.defaultPrevented, 'shifted chord must leave the key unconsumed').toBe(false);

    select(text, 0, text, 5);
    key(surface, { code: 'KeyB', key: 'b', metaKey: true });
    expect(hasMark(paragraph(surface), 'strong')).toBe(true);
  });

  it('Cmd+I italicizes the selection; Cmd+Shift+I does not touch marks', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const text = container.querySelector('p')!.firstChild!;
    select(text, 0, text, 5);

    const shifted = key(surface, { code: 'KeyI', key: 'i', metaKey: true, shiftKey: true });
    expect(hasMark(paragraph(surface), 'em'), 'shifted chord must not italicize').toBe(false);
    expect(shifted.defaultPrevented).toBe(false);

    select(text, 0, text, 5);
    key(surface, { code: 'KeyI', key: 'i', metaKey: true });
    expect(hasMark(paragraph(surface), 'em')).toBe(true);
  });

  it('Cmd+E toggles inline code on the selection; Cmd+Shift+E does not touch marks', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const text = container.querySelector('p')!.firstChild!;
    select(text, 0, text, 5);

    const shifted = key(surface, { code: 'KeyE', key: 'e', metaKey: true, shiftKey: true });
    expect(hasMark(paragraph(surface), 'code'), 'shifted chord must not toggle code').toBe(false);
    expect(shifted.defaultPrevented, 'shifted chord must leave the key unconsumed (raw-view toggle lives at the window level)').toBe(false);

    select(text, 0, text, 5);
    key(surface, { code: 'KeyE', key: 'e', metaKey: true });
    expect(hasMark(paragraph(surface), 'code')).toBe(true);
  });

  it('Cmd+Shift+8 / Cmd+Shift+7 list chords are unaffected', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const p = container.querySelector('p')!;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.collapse(true);
    sel.addRange(range);

    const e = key(surface, { code: 'Digit8', key: '*', metaKey: true, shiftKey: true });
    expect(e.defaultPrevented, 'list chord is still consumed').toBe(true);
    expect(surface.getDocument().blocks.some((b) => b.type === 'bullet_list')).toBe(true);
  });
});
