// List ergonomics structural transforms (SKR-112, Stage 4). Tab nesting,
// Shift+Tab outdent, top-level lift-to-paragraph, and list-kind toggle, as pure
// tree transforms. The load-bearing assertion is round-trip byte-stability
// through the Markdown floor: a transform's output serializes, and an indent that
// is immediately outdented restores the original bytes.

import { describe, it, expect } from 'vitest';
import {
  changeListType,
  findImmediateList,
  indentItem,
  liftItemToParagraph,
  outdentItem
} from '../../../src/lib/blocksurface/list-ops';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import { generateBlockId } from '../../../src/lib/blockmodel/id';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel/types';

function plain(inline: InlineNode[]): string {
  return inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');
}

// Find the id of the paragraph/heading leaf whose plain text is `text`, anywhere
// in the tree. The transforms address the focused leaf by id.
function leafId(blocks: BlockNode[], text: string): string {
  for (const b of blocks) {
    if ((b.type === 'paragraph' || b.type === 'heading') && plain(b.inline) === text) return b.id;
    if (b.type === 'blockquote') {
      const hit = tryLeaf(b.children, text);
      if (hit) return hit;
    } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
      for (const item of b.items) {
        const hit = tryLeaf(item.children, text);
        if (hit) return hit;
      }
    }
  }
  throw new Error(`leaf not found: ${text}`);
}
function tryLeaf(blocks: BlockNode[], text: string): string | null {
  try {
    return leafId(blocks, text);
  } catch {
    return null;
  }
}

const doc = (md: string): Document => parseDocument(md);
const ser = (blocks: BlockNode[], base: Document): string => serializeDocument({ ...base, blocks });
const reSerialize = (md: string): string => serializeDocument(parseDocument(md));

describe('indentItem', () => {
  it('nests the second item under the first', () => {
    const d = doc('- one\n- two\n');
    const out = indentItem(d.blocks, leafId(d.blocks, 'two'), generateBlockId);
    expect(out).not.toBeNull();
    expect(ser(out!, d)).toBe('- one\n  - two\n');
  });

  it('is a no-op on the first item (nothing to nest under)', () => {
    const d = doc('- one\n- two\n');
    expect(indentItem(d.blocks, leafId(d.blocks, 'one'), generateBlockId)).toBeNull();
  });

  it('merges into an existing trailing sublist of the same kind', () => {
    const d = doc('- one\n  - a\n- two\n');
    const out = indentItem(d.blocks, leafId(d.blocks, 'two'), generateBlockId);
    expect(ser(out!, d)).toBe('- one\n  - a\n  - two\n');
  });

  it('nests at depth 2', () => {
    const d = doc('- one\n  - a\n  - b\n');
    const out = indentItem(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('- one\n  - a\n    - b\n');
  });
});

describe('outdentItem', () => {
  it('lifts a nested item back to its parent list', () => {
    const d = doc('- one\n  - two\n');
    const out = outdentItem(d.blocks, leafId(d.blocks, 'two'), generateBlockId);
    expect(ser(out!, d)).toBe('- one\n- two\n');
  });

  it('re-homes trailing siblings under the lifted item', () => {
    // Outdenting the first nested item keeps document order: it lifts, and the
    // siblings that followed it become its own sublist.
    const d = doc('- p\n  - a\n  - b\n  - c\n');
    const out = outdentItem(d.blocks, leafId(d.blocks, 'a'), generateBlockId);
    expect(ser(out!, d)).toBe('- p\n- a\n  - b\n  - c\n');
  });

  it('splits the sublist around a middle item', () => {
    const d = doc('- p\n  - a\n  - b\n  - c\n');
    const out = outdentItem(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('- p\n  - a\n- b\n  - c\n');
  });

  it('returns null for a top-level item (lift-to-paragraph handles it)', () => {
    const d = doc('- one\n- two\n');
    expect(outdentItem(d.blocks, leafId(d.blocks, 'two'), generateBlockId)).toBeNull();
  });
});

describe('indent then outdent is byte-identical', () => {
  it('restores the original source verbatim', () => {
    const md = '- one\n- two\n';
    const d = doc(md);
    const indented = indentItem(d.blocks, leafId(d.blocks, 'two'), generateBlockId)!;
    const outdented = outdentItem(indented, leafId(indented, 'two'), generateBlockId)!;
    expect(ser(outdented, d)).toBe(md);
  });
});

describe('liftItemToParagraph', () => {
  it('lifts a middle item out, splitting the list', () => {
    const d = doc('- a\n- b\n- c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('- a\n\nb\n\n- c\n');
  });

  it('lifts the first item to a leading paragraph', () => {
    const d = doc('- a\n- b\n- c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'a'), generateBlockId);
    expect(ser(out!, d)).toBe('a\n\n- b\n- c\n');
  });

  it('lifts the last item to a trailing paragraph', () => {
    const d = doc('- a\n- b\n- c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'c'), generateBlockId);
    expect(ser(out!, d)).toBe('- a\n- b\n\nc\n');
  });

  it('lifts a sole item to a plain paragraph', () => {
    const d = doc('- only\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'only'), generateBlockId);
    expect(ser(out!, d)).toBe('only\n');
  });
});

describe('changeListType', () => {
  it('switches bullet to ordered, keeping items', () => {
    const d = doc('- a\n- b\n');
    const out = changeListType(d.blocks, leafId(d.blocks, 'a'), 'ordered_list');
    expect(ser(out!, d)).toBe('1. a\n2. b\n');
  });

  it('switches ordered to bullet', () => {
    const d = doc('1. a\n2. b\n');
    const out = changeListType(d.blocks, leafId(d.blocks, 'b'), 'bullet_list');
    expect(ser(out!, d)).toBe('- a\n- b\n');
  });
});

// SKR-181. Ordered numbering is positional from the list's `start`, so any op that
// splits a list has to hand each fragment the number its first item already had.
// Style (delimiter, bullet marker) rides along on a split; a KIND toggle drops it,
// deliberately — see the note on changeListType.
describe('ordered-list numbering survives splits', () => {
  it('lifting a middle item keeps the before-fragment and resumes the after-fragment', () => {
    const d = doc('3. a\n4. b\n5. c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('3. a\n\nb\n\n5. c\n');
  });

  it('lifting the first item resumes the remainder past it', () => {
    const d = doc('3. a\n4. b\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'a'), generateBlockId);
    expect(ser(out!, d)).toBe('a\n\n4. b\n');
  });

  it('lifting the last item leaves the head numbering untouched', () => {
    const d = doc('3. a\n4. b\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('3. a\n\nb\n');
  });

  it('preserves the delimiter across a split', () => {
    const d = doc('3) a\n4) b\n5) c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('3) a\n\nb\n\n5) c\n');
  });

  it('preserves the bullet marker across a split', () => {
    const d = doc('* a\n* b\n* c\n');
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('* a\n\nb\n\n* c\n');
  });

  it('the before-fragment keeps the original list id', () => {
    const d = doc('3. a\n4. b\n5. c\n');
    const listId = d.blocks[0]!.id;
    const out = liftItemToParagraph(d.blocks, leafId(d.blocks, 'b'), generateBlockId)!;
    expect(out[0]!.id).toBe(listId);
    expect(out[2]!.id).not.toBe(listId);
  });

  // The blank line is load-bearing: CommonMark only lets an ordered list interrupt
  // a paragraph when it starts at 1, so `- p` / `  3. a` would lazily continue p.
  const nested = '- p\n\n  3. a\n  4. b\n  5. c\n';

  it('outdenting re-homes trailing siblings at their own numbers', () => {
    const d = doc(nested);
    const out = outdentItem(d.blocks, leafId(d.blocks, 'a'), generateBlockId);
    expect(ser(out!, d)).toBe('- p\n- a\n  4. b\n  5. c\n');
  });

  it('outdenting a middle item splits the sublist without renumbering either half', () => {
    const d = doc(nested);
    const out = outdentItem(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('- p\n\n  3. a\n- b\n  5. c\n');
  });

  it('a fresh sublist opens at 1 rather than continuing the parent', () => {
    const d = doc('3. a\n4. b\n');
    const out = indentItem(d.blocks, leafId(d.blocks, 'b'), generateBlockId);
    expect(ser(out!, d)).toBe('3. a\n   1. b\n');
  });

  it('a kind toggle is memoryless: style does not survive the round trip', () => {
    const d = doc('3) a\n');
    const bullets = changeListType(d.blocks, leafId(d.blocks, 'a'), 'bullet_list')!;
    expect(ser(bullets, d)).toBe('- a\n');
    const back = changeListType(bullets, leafId(bullets, 'a'), 'ordered_list')!;
    expect(ser(back, d)).toBe('1. a\n');
  });
});

describe('findImmediateList', () => {
  it('finds the list directly holding the leaf', () => {
    const d = doc('- one\n  - two\n');
    expect(findImmediateList(d.blocks, leafId(d.blocks, 'two'))?.type).toBe('bullet_list');
  });

  it('returns null for a plain paragraph', () => {
    const d = doc('hello\n');
    expect(findImmediateList(d.blocks, leafId(d.blocks, 'hello'))).toBeNull();
  });
});

describe('every transform output re-serializes idempotently', () => {
  const cases = [
    '- one\n  - two\n',
    '- p\n- a\n  - b\n  - c\n',
    '- a\n\nb\n\n- c\n',
    '1. a\n2. b\n'
  ];
  for (const md of cases) {
    it(`idempotent: ${JSON.stringify(md)}`, () => {
      expect(reSerialize(md)).toBe(md);
    });
  }
});
