// @vitest-environment jsdom
//
// The surface's in-document find/replace API (the SKR-244 surface half): replace
// one match, replace all in a single undo step, and the back-to-front offset
// handling that keeps multiple matches in one block valid as the text shifts.
// Model correctness is deterministic in jsdom; the geometry/caret half is verified
// in the shell. Driven the same way as the other surface tests: build a surface
// over a parsed doc, call the API, assert the model.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';
import { findInDocument, type FindFlags } from '../../src/lib/find/engine';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

const flags: FindFlags = { caseSensitive: false, wholeWord: false, regex: false };
const plainOf = (inline: InlineNode[]): string =>
  inline.map((n) => (n.kind === 'text' ? n.text : n.kind === 'tag' ? `#${n.name}` : '')).join('');

/** Every inline-text leaf's plain text, in document order (descends containers). */
function leafTexts(blocks: BlockNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: BlockNode[]): void => {
    for (const b of nodes) {
      if (b.type === 'paragraph' || b.type === 'heading') out.push(plainOf(b.inline));
      else if (b.type === 'blockquote') walk(b.children);
      else if (b.type === 'bullet_list' || b.type === 'ordered_list') for (const it of b.items) walk(it.children);
    }
  };
  walk(blocks);
  return out;
}

const texts = (s: BlockSurface): string[] => leafTexts(s.getDocument().blocks);

describe('surface find/replace', () => {
  it('replaceMatch replaces a single occurrence by block offset', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the cat and the dog') });
    const matches = findInDocument(surface.getDocument().blocks, 'the', flags);
    expect(matches).toHaveLength(2);
    surface.replaceMatch(matches[0]!.blockId, matches[0]!.start, matches[0]!.end, 'THE');
    expect(texts(surface)).toEqual(['THE cat and the dog']);
  });

  it('replaceAll rewrites every match across blocks and is a single undo step', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('the cat\n\nthe dog') });
    const matches = findInDocument(surface.getDocument().blocks, 'the', flags);
    surface.replaceAll(matches, 'a');
    expect(texts(surface)).toEqual(['a cat', 'a dog']);
    surface.undo();
    expect(texts(surface)).toEqual(['the cat', 'the dog']); // one step reverts all
  });

  it('replaceAll applies multiple matches in one block back-to-front', () => {
    // Front-to-back with stale offsets would corrupt; the API sorts descending.
    const surface = new BlockSurface({ container, doc: parseDocument('the the the') });
    const matches = findInDocument(surface.getDocument().blocks, 'the', flags);
    expect(matches).toHaveLength(3);
    surface.replaceAll(matches, 'xy');
    expect(texts(surface)).toEqual(['xy xy xy']);
  });

  it('replaces inside a nested leaf (list item)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('- the item') });
    const matches = findInDocument(surface.getDocument().blocks, 'the', flags);
    expect(matches).toHaveLength(1);
    surface.replaceMatch(matches[0]!.blockId, matches[0]!.start, matches[0]!.end, 'that');
    expect(texts(surface)).toEqual(['that item']);
  });

  it('readSelectionRange is null when the selection is outside the surface', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello') });
    expect(surface.readSelectionRange()).toBeNull();
  });

  it('revealBlock is a no-op that never throws for a missing block', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('hello') });
    expect(() => surface.revealBlock('nonexistent')).not.toThrow();
  });
});
