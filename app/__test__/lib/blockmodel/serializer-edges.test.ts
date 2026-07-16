// Serializer edges (SKR-189 / F14, F16, F17, F18, F19, F20).
//
// The load-bearing property is the CANONICAL FIXPOINT: serializing a model and
// re-parsing the bytes must give back the same blocks. A serializer that emits
// syntax it did not mean breaks that quietly — the document changes shape on
// reload, not on save, so nothing looks wrong at the moment it goes wrong.

import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from '../../../src/lib/blockmodel';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel';

const T = (text: string): InlineNode => ({ kind: 'text', text, marks: {} });
const BREAK: InlineNode = { kind: 'break', marks: {} };

/** A one-paragraph document whose inline content is `inline`, marked dirty so the
 *  serializer must canonicalize rather than replay `src`. */
function paragraph(inline: InlineNode[]): Document {
  const doc = parseDocument('placeholder\n');
  const block = doc.blocks[0]!;
  return { ...doc, blocks: [{ ...block, inline, dirty: true } as BlockNode] };
}

const types = (md: string): string[] => parseDocument(md).blocks.map((b) => b.type);

// Underline has no Markdown syntax, so on the Markdown serialization path it
// degrades to plain text (the mark is dropped, the text preserved) rather than
// emitting an `<u>` passthrough that would freeze the block on re-parse. `.folio`
// persists it natively; this only covers the Markdown path.
describe('underline degrades to plain text on the Markdown path', () => {
  it('emits the text without any wrapping syntax', () => {
    const underlined: InlineNode = { kind: 'text', text: 'noted', marks: { underline: true } };
    expect(serializeDocument(paragraph([underlined]))).toBe('noted\n');
  });

  it('keeps a co-occurring Markdown mark while dropping only underline', () => {
    const both: InlineNode = { kind: 'text', text: 'noted', marks: { underline: true, strong: true } };
    expect(serializeDocument(paragraph([both]))).toBe('**noted**\n');
  });
});

// F20, and F14 through it. A newline is never content in a text run — a line
// break is a `break` node — but a run carrying one was emitted raw, and a raw
// newline inside a paragraph is BLOCK syntax to the parser on the way back.
describe('a text run never emits a raw newline', () => {
  it('flows a newline to a space', () => {
    expect(serializeDocument(paragraph([T('a\nb')]))).toBe('a b\n');
  });

  it('cannot split one paragraph into two on reload', () => {
    const md = serializeDocument(paragraph([T('a\n\nb')]));
    expect(types(md)).toEqual(['paragraph']);
  });

  // The canonical-fixpoint violation F14 describes, reached through this door
  // rather than through a missing stringifier extension.
  it('cannot turn a paragraph into a table on reload', () => {
    const md = serializeDocument(paragraph([T('| a | b |\n| - | - |\n| 1 | 2 |')]));
    expect(types(md)).toEqual(['paragraph']);
  });

  it('cannot inject a heading on reload', () => {
    const md = serializeDocument(paragraph([T('a\n# heading')]));
    expect(types(md)).toEqual(['paragraph']);
  });

  it('leaves a real hard break alone', () => {
    expect(serializeDocument(paragraph([T('a'), BREAK, T('b')]))).toBe('a\\\nb\n');
  });

  // A table lookalike written as real text with a real break was ALREADY safe:
  // the inline serializer escapes the leading `-`. Pinning it so it stays safe.
  it('escapes a delimiter-row lookalike that follows a hard break', () => {
    const md = serializeDocument(paragraph([T('a | b'), BREAK, T('--- | ---')]));
    expect(types(md)).toEqual(['paragraph']);
  });
});

// F19. An empty paragraph has no Markdown form. It used to emit its seam gap and
// nothing else — a stray blank line, and a block that vanished on reload.
describe('an empty paragraph is dropped whole', () => {
  const emptyFirst = (): Document => {
    const doc = parseDocument('one\n\ntwo\n');
    return { ...doc, blocks: doc.blocks.map((b, i) => (i === 0 ? ({ ...b, inline: [], dirty: true } as BlockNode) : b)) };
  };

  it('leaves no stray blank line where it was', () => {
    expect(serializeDocument(emptyFirst())).toBe('two\n');
  });

  it('the surviving blocks reload unchanged', () => {
    expect(types(serializeDocument(emptyFirst()))).toEqual(['paragraph']);
  });

  it('drops an empty paragraph between two others without merging them', () => {
    const doc = parseDocument('one\n\nmid\n\ntwo\n');
    const blocks = doc.blocks.map((b, i) => (i === 1 ? ({ ...b, inline: [], dirty: true } as BlockNode) : b));
    const md = serializeDocument({ ...doc, blocks });
    expect(md).toBe('one\n\ntwo\n');
    expect(types(md)).toEqual(['paragraph', 'paragraph']);
  });

  it('a document of only empty paragraphs serializes to nothing', () => {
    const doc = parseDocument('one\n');
    const blocks = doc.blocks.map((b) => ({ ...b, inline: [], dirty: true }) as BlockNode);
    expect(serializeDocument({ ...doc, blocks, trailingGap: '' })).toBe('');
  });
});

// F16 / F18, the canonicalization contract. These assert the POLICY, so that a
// future change to it has to change a test that says what it is trading away.
describe('the canonicalization contract', () => {
  const editFirstWord = (md: string, text: string): string => {
    const doc = parseDocument(md);
    const block = doc.blocks[0]!;
    return serializeDocument({ ...doc, blocks: [{ ...block, inline: [T(text)], dirty: true } as BlockNode] });
  };

  it('an untouched block keeps its dialect, byte for byte', () => {
    for (const md of ['Title\n=====\n', '__bold__\n', 'a &amp; b\n', '* item\n']) {
      expect(serializeDocument(parseDocument(md)), md).toBe(md);
    }
  });

  it('an edited setext heading is re-emitted as ATX', () => {
    expect(editFirstWord('Title\n=====\n', 'Titled')).toBe('# Titled\n');
  });

  it('an edited paragraph loses its entity spelling, keeping its meaning', () => {
    expect(editFirstWord('a &amp; b\n', 'a & c')).toBe('a & c\n');
  });

  it('an edit that is reverted restores the original bytes exactly', () => {
    const doc = parseDocument('Title\n=====\n');
    const block = doc.blocks[0]!;
    // Same content, marked dirty: the guard compares trees, not strings.
    expect(serializeDocument({ ...doc, blocks: [{ ...block, dirty: true } as BlockNode] })).toBe('Title\n=====\n');
  });
});
