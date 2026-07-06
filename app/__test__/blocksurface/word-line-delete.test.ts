// @vitest-environment jsdom
//
// Word / line delete chords (SKR-165 / F81). The beforeinput catch-all used to
// preventDefault every unmodeled delete*, so Option+Backspace (deleteWordBackward),
// Option-fn-Backspace (deleteWordForward) and Cmd+Backspace (deleteSoftLineBackward)
// were dead keys. They are now modeled: a collapsed caret mid-run deletes the
// computed slice through the same leaf-local path a plain Backspace uses; a
// selection or a run edge falls back to the plain char delete.
//
// jsdom doesn't dispatch a real beforeinput for a simulated chord, so onBeforeInput
// is driven directly with the input type (as barrier-adjacency drives keydown).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import { inlinePlainText } from '../../src/lib/blocksurface/inline-ops';
import { setCaret } from '../../src/lib/blocksurface/selection';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function beforeInput(surface: BlockSurface, inputType: string): void {
  (surface as unknown as { onBeforeInput: (e: Event) => void }).onBeforeInput({
    inputType,
    preventDefault() {}
  } as unknown as Event);
}
function caretIn(node: Node, offset: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.addRange(range);
}
function selectRange(sn: Node, so: number, en: Node, eo: number): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  sel.addRange(range);
}
function blocksOf(surface: BlockSurface): BlockNode[] {
  return surface.getDocument().blocks;
}
function firstParaText(surface: BlockSurface): string {
  const p = blocksOf(surface).find((b) => b.type === 'paragraph' || b.type === 'heading');
  if (!p || (p.type !== 'paragraph' && p.type !== 'heading')) throw new Error('no paragraph');
  return inlinePlainText(p.inline);
}
function codeText(surface: BlockSurface): string {
  const c = blocksOf(surface).find((b) => b.type === 'code_block');
  if (!c || c.type !== 'code_block') throw new Error('no code block');
  return c.text;
}
function cell00(surface: BlockSurface): string {
  const t = blocksOf(surface).find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error('no table');
  return inlinePlainText(t.rows[0]![0]!);
}

describe('deleteWordBackward (Option+Backspace) in prose', () => {
  it('mid-word deletes to the start of the current word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 9); // "hello wor|ld"
    beforeInput(surface, 'deleteWordBackward');
    expect(firstParaText(surface)).toBe('hello ld');
  });

  it('at a word start eats the preceding word and its space', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 6); // caret at start of "world"
    beforeInput(surface, 'deleteWordBackward');
    expect(firstParaText(surface)).toBe('world');
  });

  it('after trailing spaces eats the spaces and the word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('foo bar   x\n') });
    setCaret(container.querySelector('p')!, 10); // "foo bar   |x" -> caret after the 3 spaces
    beforeInput(surface, 'deleteWordBackward');
    expect(firstParaText(surface)).toBe('foo x');
  });

  it('at the leaf start falls back to the boundary merge', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\nb\n') });
    const b = container.querySelectorAll('p')[1]!;
    caretIn(b.firstChild!, 0);
    beforeInput(surface, 'deleteWordBackward');
    expect(blocksOf(surface).filter((x) => x.type === 'paragraph')).toHaveLength(1);
    expect(firstParaText(surface)).toBe('ab');
  });
});

describe('deleteWordBackward in a code block (leaf-local)', () => {
  it('deletes the word within the current code line only', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\none two\n```\n') });
    setCaret(container.querySelector('pre')!, 7); // "one two|"
    beforeInput(surface, 'deleteWordBackward');
    expect(codeText(surface)).toBe('one ');
  });
});

describe('deleteWordBackward in a table cell (leaf-local)', () => {
  it('deletes the word within the cell only', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| foo bar | b |\n| - | - |\n| 1 | 2 |\n') });
    const cell = container.querySelector('[data-cell-row="0"][data-cell-col="0"]')!;
    caretIn(cell.firstChild!, 7); // "foo bar|"
    beforeInput(surface, 'deleteWordBackward');
    expect(cell00(surface)).toBe('foo ');
  });
});

describe('deleteWordForward (Option-fn-Backspace)', () => {
  it('mid-word deletes to the end of the current word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 3); // "hel|lo world"
    beforeInput(surface, 'deleteWordForward');
    expect(firstParaText(surface)).toBe('hel world');
  });

  it('at a word end eats the following space and word', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 5); // "hello| world"
    beforeInput(surface, 'deleteWordForward');
    expect(firstParaText(surface)).toBe('hello');
  });

  it('within a code line stops at the line end', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\none two\n```\n') });
    setCaret(container.querySelector('pre')!, 0); // "|one two"
    beforeInput(surface, 'deleteWordForward');
    expect(codeText(surface)).toBe(' two');
  });
});

describe('deleteSoftLineBackward (Cmd+Backspace)', () => {
  it('in prose deletes to the block start', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 8); // "hello wo|rld"
    beforeInput(surface, 'deleteSoftLineBackward');
    expect(firstParaText(surface)).toBe('rld');
  });

  it('in a code block deletes to the start of the current line only', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\none\ntwo\n```\n') });
    setCaret(container.querySelector('pre')!, 6); // "one\ntw|o"
    beforeInput(surface, 'deleteSoftLineBackward');
    expect(codeText(surface)).toBe('one\no');
  });

  it('at the block start falls back like a plain Backspace (merges)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('a\n\nb\n') });
    const b = container.querySelectorAll('p')[1]!;
    caretIn(b.firstChild!, 0);
    beforeInput(surface, 'deleteSoftLineBackward');
    expect(blocksOf(surface).filter((x) => x.type === 'paragraph')).toHaveLength(1);
    expect(firstParaText(surface)).toBe('ab');
  });

  it('with a selection deletes only the selection', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    const p = container.querySelector('p')!;
    selectRange(p.firstChild!, 0, p.firstChild!, 5); // select "hello"
    beforeInput(surface, 'deleteSoftLineBackward');
    expect(firstParaText(surface)).toBe(' world');
  });
});

describe('word delete preserves neighbouring marks', () => {
  it('removes a bold word and leaves the bold neighbour intact', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('**one** two three\n') });
    // "one" is bold; caret at the end of "two" (flat offset 7).
    setCaret(container.querySelector('p')!, 7);
    beforeInput(surface, 'deleteWordBackward');
    const p = blocksOf(surface).find((b) => b.type === 'paragraph');
    if (!p || p.type !== 'paragraph') throw new Error('no paragraph');
    expect(inlinePlainText(p.inline)).toBe('one  three');
    const strong = p.inline.filter((n) => n.kind === 'text' && n.marks.strong);
    expect(strong.map((n) => (n.kind === 'text' ? n.text : ''))).toEqual(['one']);
  });
});

describe('undo restores a word delete as one step', () => {
  it('a single Option+Backspace is one undo step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 11); // end
    beforeInput(surface, 'deleteWordBackward');
    expect(firstParaText(surface)).toBe('hello ');
    surface.undo();
    expect(firstParaText(surface)).toBe('hello world');
  });

  it('a single Cmd+Backspace is one undo step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello world\n') });
    setCaret(container.querySelector('p')!, 11);
    beforeInput(surface, 'deleteSoftLineBackward');
    expect(firstParaText(surface)).toBe('');
    surface.undo();
    expect(firstParaText(surface)).toBe('hello world');
  });
});
