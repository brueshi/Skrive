// Document range operations (SKR-118, Stage 2). Cross-block delete, boundary
// merge, and type-over-selection as pure transforms, asserted via byte-stable
// serialization through the Markdown floor.

import { describe, it, expect } from 'vitest';
import {
  barrierNeighbor,
  clearTableCells,
  deleteAcross,
  deleteBlock,
  exitFootnoteDefinition,
  mergeBackward,
  mergeForward,
  removeFootnote,
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
      if (b.type === 'blockquote' || b.type === 'footnote_definition') {
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
function tableId(blocks: BlockNode[]): string {
  const b = blocks.find((x) => x.type === 'table');
  if (!b) throw new Error('no table block');
  return b.id;
}
const doc = (md: string): Document => parseDocument(md);
const ser = (blocks: BlockNode[], base: Document): string => serializeDocument({ ...base, blocks });

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |';

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

  it('shrinks a range ending inside a code block to the prose edge (SKR-166)', () => {
    const d = doc('abc\n\n```\ncode\n```\n');
    // The end lands in the code block (a barrier). Rather than eat the gesture,
    // the end snaps back to the end of "abc": its tail is deleted, the code block
    // survives untouched.
    const codeId = d.blocks.find((b) => b.type === 'code_block')!.id;
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'abc'), 1, codeId, 0);
    expect(r, 'shrunk, not clamped').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('a\n\n```\ncode\n```\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'abc'), offset: 1 });
  });

  it('shrinks a range starting inside a code block to the prose edge (SKR-166)', () => {
    const d = doc('```\ncode\n```\n\ndef\n');
    // The start lands in the code block; it snaps forward to the start of "def".
    const codeId = d.blocks.find((b) => b.type === 'code_block')!.id;
    const r = deleteAcross(d.blocks, codeId, 0, leafId(d.blocks, 'def'), 2);
    expect(r, 'shrunk, not clamped').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('```\ncode\n```\n\nf\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'def'), offset: 0 });
  });

  it('keeps a trailing table when the range runs into it (select-all shape, SKR-166)', () => {
    const d = doc(`hello\n\n${TABLE}\n`);
    // A full-document range (prose head, table tail) deletes the prose and keeps
    // the table — the shape ⌘A + Backspace produces on a doc ending in a barrier.
    const helloId = leafId(d.blocks, 'hello');
    const r = deleteAcross(d.blocks, helloId, 0, tableId(d.blocks), 0);
    expect(r, 'shrunk, not clamped').not.toBeNull();
    expect(r!.blocks.some((b) => b.type === 'table'), 'table survives').toBe(true);
    const para = r!.blocks.find((b) => b.id === helloId);
    expect(para && (para.type === 'paragraph' || para.type === 'heading') ? plain(para.inline) : null).toBe('');
    expect(r!.caret).toEqual({ id: helloId, offset: 0 });
  });

  it('within one leaf delegates to inline delete', () => {
    const d = doc('hello\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'hello'), 1, leafId(d.blocks, 'hello'), 4);
    expect(ser(r!.blocks, d)).toBe('ho\n');
  });

  it('does not resurrect inline atoms from the deleted interior (SKR-155 / F05)', () => {
    // Each paragraph is text-image-text; the range runs from before the first
    // image to after the second, so both images fall inside the cut. With atoms
    // as width-1 the head/tail slices drop them instead of passing them through.
    const d = doc('a![x](u)b\n\nc![y](v)d\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'ab'), 1, leafId(d.blocks, 'cd'), 2);
    expect(r).not.toBeNull();
    const out = ser(r!.blocks, d);
    expect(out).toBe('ad\n');
    expect(out).not.toContain('!['); // no image markdown survived
  });
});

describe('replaceAcross', () => {
  it('replaces a cross-block selection with text (type-over)', () => {
    const d = doc('abc\n\ndef\n');
    const r = replaceAcross(d.blocks, leafId(d.blocks, 'abc'), 1, leafId(d.blocks, 'def'), 2, 'X');
    expect(ser(r!.blocks, d)).toBe('aXf\n');
    expect(r!.caret.offset).toBe(2);
  });

  it('types into the surviving prose when the range ends in a code block (SKR-166)', () => {
    const d = doc('abc\n\n```\ncode\n```\n');
    // The end snaps back to "abc"; the typed text lands there, not in the barrier.
    const codeId = d.blocks.find((b) => b.type === 'code_block')!.id;
    const r = replaceAcross(d.blocks, leafId(d.blocks, 'abc'), 1, codeId, 0, 'X');
    expect(r, 'replaced, not clamped').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('aX\n\n```\ncode\n```\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'abc'), offset: 2 });
  });
});

describe('clearTableCells', () => {
  it('empties the covered cells and keeps the table shape (SKR-166 / F55)', () => {
    const d = doc('| a | b |\n| - | - |\n| 1 | 2 |\n');
    // Clear the two body cells (row 1, cols 0-1); the header row is untouched.
    const blocks = clearTableCells(d.blocks, tableId(d.blocks), 1, 0, 1, 1);
    expect(blocks, 'cleared').not.toBeNull();
    const table = blocks!.find((b) => b.type === 'table') as Extract<BlockNode, { type: 'table' }>;
    expect(table, 'table survives').toBeTruthy();
    expect(table.rows[1]!.map(plain)).toEqual(['', '']); // body emptied
    expect(table.rows[0]!.map(plain)).toEqual(['a', 'b']); // header intact
    expect(table.rows.length).toBe(2); // shape unchanged
  });

  it('returns null when the id is not a table', () => {
    const d = doc('a\n');
    expect(clearTableCells(d.blocks, leafId(d.blocks, 'a'), 0, 0, 0, 0)).toBeNull();
  });
});

describe('documentLeaves', () => {
  it('walks leaves in document order, descending containers; code is a barrier', () => {
    const d = doc('p\n\n- a\n- b\n\n```\nc\n```\n');
    const kinds = documentLeaves(d.blocks).map((l) => l.kind);
    expect(kinds).toEqual(['inline', 'inline', 'inline', 'barrier']);
  });
});

describe('deleteBlock (whole-table delete)', () => {
  it('removes a table between paragraphs; caret at the end of the previous block', () => {
    const d = doc(`alpha\n\n${TABLE}\n\nbeta\n`);
    const r = deleteBlock(d.blocks, tableId(d.blocks));
    expect(r, 'delete happened').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('alpha\n\nbeta\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'alpha'), offset: 5 });
  });

  it('removes a leading table; caret at the start of the next block', () => {
    const d = doc(`${TABLE}\n\nbeta\n`);
    const r = deleteBlock(d.blocks, tableId(d.blocks));
    expect(ser(r!.blocks, d)).toBe('beta\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'beta'), offset: 0 });
  });

  it('removes a lone table; seeds an empty paragraph for the caret', () => {
    const d = doc(`${TABLE}\n`);
    const r = deleteBlock(d.blocks, tableId(d.blocks));
    expect(r, 'delete happened').not.toBeNull();
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0]!.type).toBe('paragraph');
    expect(r!.caret).toEqual({ id: r!.blocks[0]!.id, offset: 0 });
  });

  it('returns null for an unknown id', () => {
    const d = doc('a\n');
    expect(deleteBlock(d.blocks, 'nope')).toBeNull();
  });

  it('removes a lone divider; seeds an empty paragraph for the caret (SKR-167)', () => {
    const d = doc('---\n');
    const hrId = d.blocks.find((b) => b.type === 'horizontal_rule')!.id;
    const r = deleteBlock(d.blocks, hrId);
    expect(r, 'delete happened').not.toBeNull();
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0]!.type).toBe('paragraph');
    expect(r!.caret).toEqual({ id: r!.blocks[0]!.id, offset: 0 });
  });
});

describe('barrierNeighbor (SKR-167)', () => {
  it('returns the previous block when it is a divider', () => {
    const d = doc('a\n\n---\n\nb\n');
    const hr = barrierNeighbor(d.blocks, leafId(d.blocks, 'b'), 'backward');
    expect(hr?.type).toBe('horizontal_rule');
  });

  it('returns the next block when it is a code block', () => {
    const d = doc('a\n\n```\ncode\n```\n');
    const next = barrierNeighbor(d.blocks, leafId(d.blocks, 'a'), 'forward');
    expect(next?.type).toBe('code_block');
  });

  it('returns null when the neighbor is inline (mergeBackward/mergeForward would have succeeded)', () => {
    const d = doc('a\n\nb\n');
    expect(barrierNeighbor(d.blocks, leafId(d.blocks, 'b'), 'backward')).toBeNull();
  });

  it('returns null at the first leaf (no leaf backward at all)', () => {
    const d = doc('---\n\nb\n');
    expect(barrierNeighbor(d.blocks, leafId(d.blocks, 'b'), 'backward')?.type).toBe('horizontal_rule');
    expect(barrierNeighbor(d.blocks, leafId(d.blocks, 'b'), 'forward')).toBeNull();
  });

  it('returns null for an unknown leaf id', () => {
    const d = doc('a\n');
    expect(barrierNeighbor(d.blocks, 'nope', 'backward')).toBeNull();
  });
});

describe('footnote-definition merge barrier (SKR-56)', () => {
  it('refuses a backward merge from a definition into the body', () => {
    const d = doc('body[^1]\n\n[^1]: note\n');
    expect(mergeBackward(d.blocks, leafId(d.blocks, 'note'))).toBeNull();
  });

  it('refuses a forward merge from the body into a definition', () => {
    const d = doc('body[^1]\n\n[^1]: note\n');
    expect(mergeForward(d.blocks, leafId(d.blocks, 'body'))).toBeNull();
  });

  it('refuses a merge between two definitions', () => {
    const d = doc('a[^1] b[^2]\n\n[^1]: one\n\n[^2]: two\n');
    expect(mergeBackward(d.blocks, leafId(d.blocks, 'two'))).toBeNull();
    expect(mergeForward(d.blocks, leafId(d.blocks, 'one'))).toBeNull();
  });

  it('still merges paragraphs WITHIN one definition', () => {
    const d = doc('body[^1]\n\n[^1]: one\n\n    two\n');
    const r = mergeBackward(d.blocks, leafId(d.blocks, 'two'));
    expect(r, 'within-definition merge happened').not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('body[^1]\n\n[^1]: onetwo\n');
  });
});

describe('removeFootnote (SKR-56)', () => {
  it('removes the definition and its reference; caret at the former reference', () => {
    const d = doc('see[^1] here\n\n[^1]: note\n');
    const r = removeFootnote(d.blocks, '1');
    expect(r).not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('see here\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'see here'), offset: 3 });
  });

  it('removes every reference when the label is used more than once', () => {
    const d = doc('a[^1] b[^1]\n\n[^1]: note\n');
    const r = removeFootnote(d.blocks, '1');
    expect(ser(r!.blocks, d)).toBe('a b\n');
    expect(r!.caret.offset).toBe(1); // the FIRST reference's former position
  });

  it('reaches a reference inside a blockquote', () => {
    const d = doc('> quoted[^1]\n\n[^1]: note\n');
    const r = removeFootnote(d.blocks, '1');
    expect(ser(r!.blocks, d)).toBe('> quoted\n');
  });

  it('leaves other footnotes untouched', () => {
    const d = doc('a[^1] b[^2]\n\n[^1]: one\n\n[^2]: two\n');
    const r = removeFootnote(d.blocks, '1');
    expect(ser(r!.blocks, d)).toBe('a b[^2]\n\n[^2]: two\n');
  });

  it('deletes an orphan definition; caret at the end of the last body leaf', () => {
    const d = doc('body\n\n[^1]: note\n');
    const r = removeFootnote(d.blocks, '1');
    expect(ser(r!.blocks, d)).toBe('body\n');
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'body'), offset: 4 });
  });

  it('returns null for an unknown label', () => {
    const d = doc('body[^1]\n\n[^1]: note\n');
    expect(removeFootnote(d.blocks, 'nope')).toBeNull();
  });
});

describe('deleteAcross footnote-region guard (SKR-56)', () => {
  // A definition renders in the document-end footer wherever it sits in the
  // model, so a body range must never eat one that happens to lie model-order
  // between its endpoints (the imported-.md shape), and an endpoint inside a
  // definition clamps to the start's region like a barrier endpoint.
  it('a body-to-body range leaves a model-order-between definition untouched', () => {
    const d = doc('a[^1]\n\n[^1]: note\n\nb\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'a'), 1, leafId(d.blocks, 'b'), 0);
    expect(r).not.toBeNull();
    expect(ser(r!.blocks, d)).toBe('ab\n\n[^1]: note\n');
  });

  it('an endpoint inside a definition retreats to the start region', () => {
    const d = doc('a[^1]\n\n[^1]: note\n\nb\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'a'), 1, leafId(d.blocks, 'note'), 2);
    expect(r).not.toBeNull();
    // Only the start leaf's tail (the reference cell) goes; the note is untouched.
    expect(ser(r!.blocks, d)).toBe('a\n\n[^1]: note\n\nb\n');
  });

  it('a range within one definition still deletes normally', () => {
    const d = doc('x[^1]\n\n[^1]: one\n\n    two\n');
    const r = deleteAcross(d.blocks, leafId(d.blocks, 'one'), 1, leafId(d.blocks, 'two'), 1);
    expect(ser(r!.blocks, d)).toBe('x[^1]\n\n[^1]: owo\n');
  });
});

describe('exitFootnoteDefinition (SKR-56)', () => {
  const emptyPara = (id: string): BlockNode => ({
    type: 'paragraph',
    id,
    durable: false,
    src: null,
    gapBefore: null,
    dirty: true,
    inline: []
  });
  const withDefChild = (d: Document, child: BlockNode, replace = false): BlockNode[] =>
    d.blocks.map((b) =>
      b.type === 'footnote_definition'
        ? { ...b, children: replace ? [child] : [...b.children, child], dirty: true }
        : b
    );

  it('removes the empty leaf and returns the caret to just after the reference', () => {
    const d = doc('see[^1] x\n\n[^1]: note\n');
    const blocks = withDefChild(d, emptyPara('e1'));
    const r = exitFootnoteDefinition(blocks, 'e1');
    expect(r).not.toBeNull();
    expect(r!.caret).toEqual({ id: leafId(d.blocks, 'see x'), offset: 4 });
    expect(ser(r!.blocks, d)).toBe('see[^1] x\n\n[^1]: note\n');
  });

  it('keeps a sole empty body, still returning to the reference', () => {
    const d = doc('see[^1]\n\n[^1]: note\n');
    const blocks = withDefChild(d, emptyPara('e2'), true);
    const r = exitFootnoteDefinition(blocks, 'e2');
    expect(r).not.toBeNull();
    expect(r!.caret.offset).toBe(4); // after the reference atom
    const def = r!.blocks.find((b) => b.type === 'footnote_definition');
    expect(def && def.type === 'footnote_definition' ? def.children.length : 0).toBe(1);
  });

  it('returns null for a non-empty leaf', () => {
    const d = doc('see[^1]\n\n[^1]: note\n');
    expect(exitFootnoteDefinition(d.blocks, leafId(d.blocks, 'note'))).toBeNull();
  });

  it('returns null for an orphan definition (no reference to return to)', () => {
    const d = doc('body\n\n[^1]: note\n');
    const blocks = withDefChild(d, emptyPara('e3'));
    expect(exitFootnoteDefinition(blocks, 'e3')).toBeNull();
  });

  it('returns null for a leaf outside any definition', () => {
    const d = doc('see[^1]\n\n[^1]: note\n');
    expect(exitFootnoteDefinition(d.blocks, leafId(d.blocks, 'see'))).toBeNull();
  });
});
