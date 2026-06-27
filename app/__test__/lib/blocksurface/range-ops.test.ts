// Document range operations (SKR-118, Stage 2). Cross-block delete, boundary
// merge, and type-over-selection as pure transforms, asserted via byte-stable
// serialization through the Markdown floor.

import { describe, it, expect } from 'vitest';
import {
  deleteAcross,
  mergeBackward,
  mergeForward,
  replaceAcross,
  documentLeaves
} from '../../../src/lib/blocksurface/range-ops';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel/types';

function plain(inline: InlineNode[]): string {
  return inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');
}
function leafId(blocks: BlockNode[], text: string): string {
  const hit = (nodes: BlockNode[]): string | null => {
    for (const b of nodes) {
      if ((b.type === 'paragraph' || b.type === 'heading') && plain(b.inline) === text) return b.id;
      if (b.type === 'blockquote') {
        const r = hit(b.children);
        if (r) return r;
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) {
          const r = hit(item.children);
          if (r) return r;
        }
      }
    }
    return null;
  };
  const id = hit(blocks);
  if (!id) throw new Error(`leaf not found: ${text}`);
  return id;
}
const doc = (md: string): Document => parseDocument(md);
const ser = (blocks: BlockNode[], base: Document): string => serializeDocument({ ...base, blocks });

describe('mergeBackward', () => {
  it('merges a paragraph into the previous list item (the reported bug)', () => {
    const d = doc('- one\n\ntwo\n');
    const r = mergeBackward(d.blocks, leafId(d.blocks, 'two'));
    expect(r, 'merge happened').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('- onetwo\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'one'), offset: 3 });
  });

  it('merges two top-level paragraphs', () => {
    const d = doc('a\n\nb\n');
    const r = mergeBackward(d.blocks, leafId(d.blocks, 'b'));
    expect(ser(r!.blocks, d)).toBe('ab\n');
  });

  it('returns null on the first leaf', () => {
    const d = doc('only\n');
    expect(mergeBackward(d.blocks, leafId(d.blocks, 'only'))).toBeNull();
  });

  it('refuses to merge across a code-block barrier', () => {
    const d = doc('```\nx\n```\n\nafter\n');
    expect(mergeBackward(d.blocks, leafId(d.blocks, 'after'))).toBeNull();
  });
});

describe('mergeForward', () => {
  it('pulls the next paragraph up', () => {
    const d = doc('a\n\nb\n');
    const r = mergeForward(d.blocks, leafId(d.blocks, 'a'));
    expect(ser(r!.blocks, d)).toBe('ab\n');
  });
});

describe('deleteAcross', () => {
  it('deletes a partial range across two paragraphs', () => {
    const d = doc('abc\n\ndef\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'abc'), 1, leafId(d.blocks, 'def'), 2);
    expect(ser(r!.blocks, d)).toBe('af\n');
  });

  it('removes fully-covered blocks between the ends and prunes the list', () => {
    const d = doc('- one\n- two\n- three\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'one'), 3, leafId(d.blocks, 'three'), 0);
    // "two" is removed entirely; "three" merges its tail into "one".
    expect(ser(r!.blocks, d)).toBe('- onethree\n');
  });

  it('removes a code block caught fully inside the range', () => {
    const d = doc('abc\n\n```\ncode\n```\n\ndef\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'abc'), 1, leafId(d.blocks, 'def'), 2);
    expect(ser(r!.blocks, d)).toBe('af\n');
  });

  it('removes a divider caught fully inside the range', () => {
    const d = doc('a\n\n---\n\nb\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'a'), 1, leafId(d.blocks, 'b'), 0);
    expect(ser(r!.blocks, d)).toBe('ab\n');
  });

  it('clamps when an endpoint is inside a code block (no partial cut)', () => {
    const d = doc('abc\n\n```\ncode\n```\n');
    // The code block has no inline leaf; a range ending in it cannot be addressed
    // as an inline endpoint, so deleteAcross declines.
    const codeId = d.blocks.find((b) => b.type === 'code_block')!.id;
    expect(deleteAcross(d.blocks, leafId(d.blocks, 'abc'), 1, codeId, 0)).toBeNull();
  });

  it('within one leaf delegates to inline delete', () => {
    const d = doc('hello\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'hello'), 1, leafId(d.blocks, 'hello'), 4);
    expect(ser(r!.blocks, d)).toBe('ho\n');
  });
});

describe('replaceAcross', () => {
  it('replaces a cross-block selection with text (type-over)', () => {
    const d = doc('abc\n\ndef\n');
    const r = replaceAcross(d.blocks, leafId(d.blocks, 'abc'), 1, leafId(d.blocks, 'def'), 2, 'X');
    expect(ser(r!.blocks, d)).toBe('aXf\n');
    expect(r!.caret.offset).toBe(2);
  });
});

describe('documentLeaves', () => {
  it('walks leaves in document order, descending containers; code is a barrier', () => {
    const d = doc('p\n\n- a\n- b\n\n```\nc\n```\n');
    const kinds = documentLeaves(d.blocks).map((l) => l.kind);
    expect(kinds).toEqual(['inline', 'inline', 'inline', 'barrier']);
  });
});
