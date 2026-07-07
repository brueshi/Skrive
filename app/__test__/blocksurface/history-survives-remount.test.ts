// @vitest-environment jsdom
//
// Undo history across a surface rebuild (SKR-179 / F41). A tab switch remounts
// BlockEditor (`key` per path), which destroys and recreates the BlockSurface —
// an owned DocHistory died with it, wiping undo. The history now lives on the
// tab and is injected via BlockSurfaceOptions.history; these pin the survival
// contract: a fresh surface handed the old history and the last document can
// undo edits made by its predecessor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { DocHistory } from '../../src/lib/blocksurface/history';
import { parseDocument, type Document } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function typeInto(surface: BlockSurface, text: string): void {
  const p = container.querySelector('p')!;
  window.getSelection()!.collapse(p.firstChild ?? p, p.firstChild ? p.firstChild.textContent!.length : 0);
  (surface as unknown as { applyInsertText: (t: string) => void }).applyInsertText(text);
}

function firstParagraphText(doc: Document): string {
  const b = doc.blocks[0]!;
  return b.type === 'paragraph' ? b.inline.map((n) => (n.kind === 'text' ? n.text : '')).join('') : '';
}

describe('history survives a surface rebuild', () => {
  it('a new surface with the old history and last doc undoes the predecessor edit', () => {
    const history = new DocHistory();
    const first = new BlockSurface({ container, doc: parseDocument('hello\n'), history });
    typeInto(first, '!');
    const edited = first.getDocument();
    expect(firstParagraphText(edited)).toBe('hello!');
    first.destroy();
    container.textContent = '';

    // The remount: same history, the document the store handed back.
    const second = new BlockSurface({ container, doc: edited, history });
    second.undo();

    expect(firstParagraphText(second.getDocument())).toBe('hello');
  });

  it('redo also crosses the rebuild', () => {
    const history = new DocHistory();
    const first = new BlockSurface({ container, doc: parseDocument('hello\n'), history });
    typeInto(first, '!');
    const edited = first.getDocument();
    first.undo();
    const undone = first.getDocument();
    expect(firstParagraphText(undone)).toBe('hello');
    first.destroy();
    container.textContent = '';

    const second = new BlockSurface({ container, doc: undone, history });
    second.redo();

    expect(firstParagraphText(second.getDocument())).toBe('hello!');
  });

  it('without an injected history, each surface keeps its own (prior behavior)', () => {
    const first = new BlockSurface({ container, doc: parseDocument('hello\n') });
    typeInto(first, '!');
    const edited = first.getDocument();
    first.destroy();
    container.textContent = '';

    const second = new BlockSurface({ container, doc: edited });
    second.undo(); // nothing to undo: fresh private history

    expect(firstParagraphText(second.getDocument())).toBe('hello!');
  });
});
