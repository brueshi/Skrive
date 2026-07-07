// @vitest-environment jsdom
//
// Undo granularity through the surface (SKR-178). history.ts's mechanics are
// unit-tested in history.test.ts; these pin the surface wiring — the EditHint
// each gesture reports, the compoundEdit framing of paste/autoformat, and the
// pre-mutation caret capture on the surgical fast path — which was the untested
// layer where every audit finding (F37-F40, F42, F43) actually lived.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { readSelection } from '../../src/lib/blocksurface/selection';
import { parseDocument, type Document } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom has no layout: the slash menu's anchor-rect read needs a stub.
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

type Driver = {
  applyInsertText: (t: string) => void;
  applyDeleteBackward: () => void;
};
const drive = (s: BlockSurface): Driver => s as unknown as Driver;

function caretIn(el: Element, offset: number): void {
  const tn = el.firstChild!;
  window.getSelection()!.collapse(tn, offset);
}

function paragraphTexts(doc: Document): string[] {
  return doc.blocks.map((b) => (b.type === 'paragraph' ? b.inline.map((n) => (n.kind === 'text' ? n.text : '')).join('') : `<${b.type}>`));
}

function typeString(surface: BlockSurface, p: Element, text: string): void {
  for (const ch of text) {
    const tn = p.firstChild;
    const len = tn?.textContent?.length ?? 0;
    if (tn && tn.nodeType === Node.TEXT_NODE) window.getSelection()!.collapse(tn, len);
    drive(surface).applyInsertText(ch);
  }
}

describe('typing coalescing through the surface', () => {
  it('a whitespace insert breaks the run: undo steps word by word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('x\n') });
    const p = container.querySelector('p')!;
    caretIn(p, 1);
    typeString(surface, p, 'hello world');

    surface.undo();
    expect(paragraphTexts(surface.getDocument())[0]).toBe('xhello');
    surface.undo();
    expect(paragraphTexts(surface.getDocument())[0]).toBe('x');
  });

  it('typing in block A then block B never merges into one step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('aa\n\nbb\n') });
    const [pa, pb] = Array.from(container.querySelectorAll('p'));
    caretIn(pa!, 2);
    drive(surface).applyInsertText('1');
    caretIn(pb!, 2);
    drive(surface).applyInsertText('2');

    surface.undo();
    expect(paragraphTexts(surface.getDocument())).toEqual(['aa1', 'bb']);
    surface.undo();
    expect(paragraphTexts(surface.getDocument())).toEqual(['aa', 'bb']);
  });
});

describe('paste framing', () => {
  it('a single-segment plain paste is its own atomic step, not part of a typing run', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('x\n') });
    const p = container.querySelector('p')!;
    caretIn(p, 1);
    drive(surface).applyInsertText('a');
    // Immediately paste (well inside the 600ms window): must NOT coalesce.
    caretIn(p, 2);
    (surface as unknown as { pasteText: (raw: string, mode: 'flow' | 'literal') => void }).pasteText('PASTED', 'flow');

    expect(paragraphTexts(surface.getDocument())[0]).toBe('xaPASTED');
    surface.undo();
    expect(paragraphTexts(surface.getDocument())[0]).toBe('xa');
    surface.undo();
    expect(paragraphTexts(surface.getDocument())[0]).toBe('x');
  });
});

describe('autoformat as one undo step', () => {
  it('the list input rule undoes to the literal marker text in ONE step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('seed\n') });
    const p = container.querySelector('p')!;
    // Clear the seed and type the marker: "- " fires the bullet rule on space.
    caretIn(p, 4);
    for (let i = 0; i < 4; i++) drive(surface).applyDeleteBackward();
    typeString(surface, p, '-');
    const tn = p.firstChild!;
    window.getSelection()!.collapse(tn, tn.textContent!.length);
    drive(surface).applyInsertText(' ');

    expect(surface.getDocument().blocks[0]!.type).toBe('bullet_list');

    surface.undo();
    // One undo: back to the literal paragraph "- ", not a stripped intermediate.
    const after = surface.getDocument().blocks[0]!;
    expect(after.type).toBe('paragraph');
    expect(paragraphTexts(surface.getDocument())[0]).toBe('- ');
  });

  it('a slash command undoes to the literal /query text in ONE step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('seed\n') });
    const p = container.querySelector('p')!;
    caretIn(p, 4);
    for (let i = 0; i < 4; i++) drive(surface).applyDeleteBackward();
    typeString(surface, p, '/quote');

    surface.applySlashCommand({ kind: 'blockquote' });
    expect(surface.getDocument().blocks[0]!.type).toBe('blockquote');

    surface.undo();
    const after = surface.getDocument().blocks[0]!;
    expect(after.type).toBe('paragraph');
    expect(paragraphTexts(surface.getDocument())[0]).toBe('/quote');
  });
});

describe('surgical edits: undo reverts the DOM and the caret (F42)', () => {
  it('undo after surgical typing re-renders the block and restores the pre-edit caret', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    const p = container.querySelector('p')!;
    caretIn(p, 3);
    drive(surface).applyInsertText('X'); // surgical: caret was at 3 before the edit
    expect(p.textContent).toBe('abcX');

    surface.undo();
    // The DOM reverts too — reconcile must not skip the surgically-mutated
    // block (the markRenderedInPlace fix; the stale DOM was also what clamped
    // the restored caret off-by-N).
    expect(container.querySelector('p')!.textContent).toBe('abc');
    expect(paragraphTexts(surface.getDocument())[0]).toBe('abc');
    expect(readSelection(container)?.anchor.offset).toBe(3);
  });

  it('undo after a surgical backspace re-renders the block and restores the pre-edit caret', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('abc\n') });
    const p = container.querySelector('p')!;
    caretIn(p, 3);
    drive(surface).applyDeleteBackward(); // surgical: caret was at 3 before the edit
    expect(p.textContent).toBe('ab');

    surface.undo();
    expect(container.querySelector('p')!.textContent).toBe('abc');
    expect(paragraphTexts(surface.getDocument())[0]).toBe('abc');
    expect(readSelection(container)?.anchor.offset).toBe(3);
  });
});
