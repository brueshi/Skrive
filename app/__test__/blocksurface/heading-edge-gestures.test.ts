// @vitest-environment jsdom
//
// SKR-180 / F51 — the two heading edge gestures.
//
// Enter at the very START of a heading left an EMPTY HEADING above it (`#` on its
// own line) instead of an empty paragraph. The rule already existed for the other
// end — Enter at a heading's end drops to body text — it just was not mirrored.
//
// Backspace at the very start of the DOCUMENT on a heading did nothing at all:
// mergeBackward finds no previous leaf, returns null, and the barrier-adjacency
// fallback has no barrier to act on. It now strips the heading, matching the list
// branch beside it (the first Backspace at a block's start removes its formatting,
// not its text). Doc-start only: elsewhere Backspace at offset 0 still merges into
// the block above, and the guard fixture below pins that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../jsdom-range-rect';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.addRange(r);
}
function pressEnter(s: BlockSurface): void {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  (s as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
}
// Deletion arrives as beforeinput, not keydown; jsdom dispatches no real one.
function pressBackspace(s: BlockSurface): void {
  (s as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType: 'deleteContentBackward',
    preventDefault() {}
  } as unknown as Event);
}

function dump(b: BlockNode): string {
  const any = b as unknown as Record<string, unknown>;
  const text = Array.isArray(any.inline)
    ? (any.inline as { kind: string; text?: string }[]).map((n) => (n.kind === 'text' ? n.text : '')).join('')
    : '';
  const level = b.type === 'heading' ? String(any.level) : '';
  return `${b.type}${level}("${text}")`;
}
const tree = (s: BlockSurface): string => s.getDocument().blocks.map(dump).join(' | ');

describe('SKR-180: Enter at the start of a heading', () => {
  it('leaves an empty paragraph above, not an empty heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Title\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 0);

    pressEnter(s);

    expect(tree(s)).toBe('paragraph("") | heading1("Title")');
  });

  it('rewrites the element, not just the model', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Title\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 0);

    pressEnter(s);

    const tags = Array.from(container.children).map((el) => el.tagName);
    expect(tags, 'the demoted left half is a <p>, and the heading moved down').toEqual(['P', 'H1']);
  });

  // The far end of the same rule, unchanged.
  it('still drops to body text at the END of a heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Title\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 5);

    pressEnter(s);

    expect(tree(s)).toBe('heading1("Title") | paragraph("")');
  });

  // Pressing Enter on a heading you just created must not silently erase it: the
  // left half is empty, but so is the right, so the heading stays put.
  it('keeps a wholly empty heading rather than erasing it', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# T\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 1);
    pressBackspace(s); // now an empty heading
    expect(tree(s)).toBe('heading1("")');

    pressEnter(s);

    expect(tree(s)).toBe('heading1("") | paragraph("")');
  });
});

describe('SKR-180: Backspace at the start of a heading', () => {
  it('demotes a heading at the very start of the document', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# Title\n\nbody\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 0);

    pressBackspace(s);

    expect(tree(s)).toBe('paragraph("Title") | paragraph("body")');
  });

  it('still MERGES a heading that is not the first block', () => {
    const s = new BlockSurface({ container, doc: parseDocument('intro\n\n# Title\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 0);

    pressBackspace(s);

    expect(tree(s), 'the merge gesture is untouched away from doc start').toBe('paragraph("introTitle")');
  });

  it('leaves a paragraph at doc start alone', () => {
    const s = new BlockSurface({ container, doc: parseDocument('body\n\nmore\n') });
    caretIn(container.querySelector('p')!.firstChild!, 0);

    pressBackspace(s);

    expect(tree(s)).toBe('paragraph("body") | paragraph("more")');
  });
});
