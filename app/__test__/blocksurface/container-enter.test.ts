// @vitest-environment jsdom
//
// SKR-180 / F46, F47, F49, F51 — Enter means the same thing inside a container as
// it does at the top level.
//
// The audit's pattern: a gesture handled for one context and silently absent for its
// sibling. Lists were taught to split around a lifted item (SKR-222); blockquotes and
// headings never were. Three consequences, all measured against HEAD before the fix:
//
//   * Enter with a selection inside a list item / quote never deleted the range. It
//     split at `start` and left the selected text in the RIGHT half, so "alphabet"
//     with "lpha" selected became "a" + "lphabet" — the text was duplicated.
//   * A heading split inside a container demoted its tail to a paragraph, while the
//     identical gesture at the top level kept the heading.
//   * Enter on a blank line mid-quote deleted the line and appended a paragraph after
//     the WHOLE quote, stranding everything below the caret inside the quote above it.
//
// These assert the MODEL TREE, not serialize(): the canonicalization contract drops
// empty paragraphs (SKR-189), so a quote that split the wrong way round-trips to
// identical Markdown and a serialize() assertion would pass on the bug.

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
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function selectIn(node: Node, start: number, end: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  sel.addRange(range);
}
function pressEnter(surface: BlockSurface): void {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  (surface as unknown as { onKeyDown: (e: Event) => void }).onKeyDown(e);
}
// Deletion arrives as beforeinput, not keydown; jsdom dispatches no real one.
function pressBackspace(surface: BlockSurface): void {
  (surface as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType: 'deleteContentBackward',
    preventDefault() {}
  } as unknown as Event);
}

/** A compact structural rendering of the document: `type(text)`, children nested. */
function dump(b: BlockNode): string {
  const any = b as unknown as Record<string, unknown>;
  const text = Array.isArray(any.inline)
    ? (any.inline as { kind: string; text?: string }[]).map((n) => (n.kind === 'text' ? n.text : `<${n.kind}>`)).join('')
    : undefined;
  if (b.type === 'blockquote') return `quote[${(any.children as BlockNode[]).map(dump).join(' ')}]`;
  if (b.type === 'bullet_list' || b.type === 'ordered_list') {
    const items = any.items as { children: BlockNode[] }[];
    return `${b.type}[${items.map((it) => `item(${it.children.map(dump).join(' ')})`).join(' ')}]`;
  }
  const level = b.type === 'heading' ? String(any.level) : '';
  return `${b.type}${level}("${text ?? ''}")`;
}
const tree = (s: BlockSurface): string => s.getDocument().blocks.map(dump).join(' | ');

describe('SKR-180: Enter with a selection deletes it inside a container', () => {
  it('deletes the selected range in a list item instead of duplicating it', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- alphabet\n') });
    const p = container.querySelector('li p')!;
    selectIn(p.firstChild!, 1, 5); // "lpha"

    pressEnter(s);

    expect(tree(s)).toBe('bullet_list[item(paragraph("a")) item(paragraph("bet"))]');
  });

  it('deletes the selected range in a blockquote paragraph', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> alphabet\n') });
    const p = container.querySelector('blockquote p')!;
    selectIn(p.firstChild!, 1, 5);

    pressEnter(s);

    expect(tree(s)).toBe('quote[paragraph("a") paragraph("bet")]');
  });
});

describe('SKR-180: a container split keeps the block type', () => {
  it('keeps the tail of a heading split inside a blockquote a heading', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> # TitleHere\n') });
    caretIn(container.querySelector('blockquote h1')!.firstChild!, 5);

    pressEnter(s);

    expect(tree(s)).toBe('quote[heading1("Title") heading1("Here")]');
  });

  it('agrees with the top-level path on the same gesture', () => {
    const s = new BlockSurface({ container, doc: parseDocument('# TitleHere\n') });
    caretIn(container.querySelector('h1')!.firstChild!, 5);

    pressEnter(s);

    expect(tree(s)).toBe('heading1("Title") | heading1("Here")');
  });

  it('drops to body text at the END of a heading inside a container, as at top level', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> # Title\n') });
    caretIn(container.querySelector('blockquote h1')!.firstChild!, 5);

    pressEnter(s);

    expect(tree(s)).toBe('quote[heading1("Title") paragraph("")]');
  });
});

describe('SKR-180: Enter on a blank line mid-blockquote splits the quote', () => {
  it('splits rather than ejecting a paragraph below the whole quote', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> one\n>\n> three\n') });
    const paras = container.querySelectorAll('blockquote p');
    caretIn(paras[0]!.firstChild!, 3); // end of "one"
    pressEnter(s); // opens an empty paragraph inside the quote
    expect(tree(s), 'the blank line is inside the quote').toBe(
      'quote[paragraph("one") paragraph("") paragraph("three")]'
    );

    pressEnter(s); // Enter again on that blank line

    expect(tree(s)).toBe('quote[paragraph("one")] | paragraph("") | quote[paragraph("three")]');
  });

  it('matches what a list already does with the same gesture', () => {
    const s = new BlockSurface({ container, doc: parseDocument('- one\n- three\n') });
    caretIn(container.querySelectorAll('li p')[0]!.firstChild!, 3);
    pressEnter(s);
    pressEnter(s);

    expect(tree(s)).toBe('bullet_list[item(paragraph("one"))] | paragraph("") | bullet_list[item(paragraph("three"))]');
  });

  // The degenerate cases are the everyday gestures; they must not change.
  it('still leaves the quote when the blank line is its LAST child', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> one\n') });
    caretIn(container.querySelector('blockquote p')!.firstChild!, 3);
    pressEnter(s);
    pressEnter(s);

    expect(tree(s)).toBe('quote[paragraph("one")] | paragraph("")');
  });

  // `> ` parses to a frozen_block, so a quote holding one empty paragraph is only
  // reachable by editing: empty its single child, then press Enter on it.
  it('still replaces a quote whose only child is the blank line', () => {
    const s = new BlockSurface({ container, doc: parseDocument('> a\n') });
    caretIn(container.querySelector('blockquote p')!.firstChild!, 1);
    pressBackspace(s);
    expect(tree(s), 'the quote holds one empty paragraph').toBe('quote[paragraph("")]');

    pressEnter(s);

    expect(tree(s)).toBe('paragraph("")');
  });
});
