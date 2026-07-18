// Footnotes: `[^label]` references and `[^label]: …` definitions (SKR-56). Pins the
// whole model round-trip — reference recognition, the `.md` byte-stable
// serialization, the multi-paragraph-definition regression (it used to corrupt to a
// code block), the `.folio` native shape, plaintext, and the single-cell-atom offset
// math. Pure model, no DOM.

import { describe, it, expect } from 'vitest';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import { documentToPlainText } from '../../../src/lib/blockmodel/plaintext';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel/types';
import {
  deleteRangeInInline,
  inlineLength,
  insertFootnoteRefInInline,
  insertTextInInline
} from '../../../src/lib/blocksurface/inline-ops';
import { orderForDisplay } from '../../../src/lib/blocksurface/render';
import { modelToFolio, folioToModel } from '../../../src/lib/folio/convert';
import { serializeFolio } from '../../../src/lib/folio/serialize';
import { parseFolio } from '../../../src/lib/folio/parse';
import type { FolioMeta } from '../../../src/lib/folio/types';

const ref = (label: string, marks: InlineNode['marks'] = {}): InlineNode => ({
  kind: 'footnote_ref',
  label,
  marks
});
const text = (t: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: t, marks });

function inlineOf(md: string): InlineNode[] {
  const block = parseDocument(md).blocks[0]!;
  if (block.type !== 'paragraph' && block.type !== 'heading') {
    throw new Error(`expected a paragraph/heading, got ${block.type}`);
  }
  return block.inline;
}

describe('footnote reference parsing', () => {
  // A GFM footnote reference is only recognized when a matching definition exists;
  // an orphan `[^1]` stays literal text (and round-trips byte-stable as such). So
  // every reference test carries its definition.
  it('models `[^1]` as a footnote_ref leaf, keeping surrounding text', () => {
    expect(inlineOf('see it[^1] here\n\n[^1]: def\n')).toEqual([text('see it'), ref('1'), text(' here')]);
  });

  it('preserves the raw label (not the folded identifier)', () => {
    expect(inlineOf('a[^Note]\n\n[^Note]: def\n')).toEqual([text('a'), ref('Note')]);
  });

  it('leaves an orphan reference (no definition) as literal text', () => {
    expect(inlineOf('a[^1] b\n')).toEqual([text('a[^1] b')]);
  });

  it('does NOT freeze the paragraph that carries a reference (the trap)', () => {
    // Before modeling, an enabled parser + unmodeled reference would freeze here.
    const doc = parseDocument('body[^1]\n\n[^1]: def\n');
    expect(doc.blocks[0]!.type).toBe('paragraph');
  });
});

describe('footnote definition parsing', () => {
  it('models `[^1]: …` as a footnote_definition block with a paragraph body', () => {
    const doc = parseDocument('[^1]: the definition\n');
    const def = doc.blocks[0]!;
    expect(def.type).toBe('footnote_definition');
    if (def.type !== 'footnote_definition') throw new Error('not a definition');
    expect(def.label).toBe('1');
    expect(def.children.map((c) => c.type)).toEqual(['paragraph']);
  });

  it('models a MULTI-paragraph definition as multiple blocks (no code-block corruption)', () => {
    // The historical defect: the continuation paragraph corrupted to an indented
    // code block. Enabling the extension + modeling fixes it.
    const doc = parseDocument('[^long]: First paragraph.\n\n    Second paragraph.\n');
    const def = doc.blocks[0]!;
    expect(def.type).toBe('footnote_definition');
    if (def.type !== 'footnote_definition') throw new Error('not a definition');
    expect(def.children.map((c) => c.type)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('.md serialization', () => {
  const roundTrip = (md: string): string => serializeDocument(parseDocument(md));

  function dirtyLast(doc: Document): Document {
    const blocks = doc.blocks.slice();
    const k = blocks.length - 1;
    blocks[k] = { ...blocks[k]!, dirty: true } as BlockNode;
    return { ...doc, blocks };
  }

  it('round-trips a reference + definition document byte-for-byte', () => {
    const src = 'Here is a claim.[^1]\n\n[^1]: The supporting note.\n';
    expect(roundTrip(src)).toBe(src);
  });

  it('round-trips a multi-paragraph definition byte-for-byte', () => {
    const src = '[^long]: First paragraph.\n\n    Second paragraph.\n';
    expect(roundTrip(src)).toBe(src);
  });

  it('re-serializes a dirtied reference back to `[^label]`', () => {
    const out = serializeDocument(dirtyLast(parseDocument('a claim[^1]\n')));
    expect(out).toBe('a claim[^1]\n');
  });

  it('re-serializes a dirtied definition back to `[^label]: …`', () => {
    const doc = parseDocument('[^1]: the note\n');
    const dirtied: Document = {
      ...doc,
      blocks: doc.blocks.map((b) => ({ ...b, dirty: true }) as BlockNode)
    };
    expect(serializeDocument(dirtied)).toBe('[^1]: the note\n');
  });
});

describe('plaintext', () => {
  it('drops the reference (it is a pointer) and keeps the definition body', () => {
    const doc = parseDocument('claim[^1]\n\n[^1]: the note\n');
    expect(documentToPlainText(doc)).toBe('claim\n\nthe note\n');
  });
});

describe('.folio native round-trip', () => {
  const meta: FolioMeta = { title: null, createdAt: '2026-01-01T00:00:00Z' };

  it('preserves a reference and definition through model -> folio -> model', () => {
    const doc = parseDocument('claim[^1]\n\n[^1]: the note\n');
    const folio = modelToFolio(doc, { docId: 'doc_test', docMeta: meta });
    const back = folioToModel(folio);
    expect((back.blocks[0] as { inline: InlineNode[] }).inline).toEqual([text('claim'), ref('1')]);
    expect(back.blocks[1]!.type).toBe('footnote_definition');
  });

  it('serializes and re-reads footnote leaves/blocks natively', () => {
    const doc = parseDocument('claim[^1]\n\n[^1]: the note\n');
    const folio = modelToFolio(doc, { docId: 'doc_test', docMeta: meta });
    const json = serializeFolio(folio);
    expect(json).toContain('"kind": "footnote_ref"');
    expect(json).toContain('"type": "footnote_definition"');
    const reparsed = parseFolio(json);
    expect(folioToModel(reparsed)).toEqual(folioToModel(folio));
  });
});

describe('offset math (single-cell atom)', () => {
  it('counts a reference as one cell regardless of label length', () => {
    // 'a' (1) + ref('10') (1) + 'b' (1) = 3 — the two-digit label is still one cell.
    expect(inlineLength([text('a'), ref('10'), text('b')])).toBe(3);
  });

  it('removes the whole reference when a delete range touches it', () => {
    // ref occupies cell [1,2); deleting [1,2) drops the whole atom.
    expect(deleteRangeInInline([text('a'), ref('1'), text('b')], 1, 2)).toEqual([text('ab')]);
  });

  it('inserts text at the reference boundary without splitting it', () => {
    expect(insertTextInInline([text('a'), ref('1')], 2, 'X')).toEqual([text('a'), ref('1'), text('X')]);
  });

  it('splices a reference atom at a flat offset (insertFootnoteRefInInline)', () => {
    expect(insertFootnoteRefInInline([text('ab')], 1, '1', {})).toEqual([text('a'), ref('1'), text('b')]);
  });
});

describe('orderForDisplay (footer gather)', () => {
  const p = (id: string): BlockNode =>
    ({ id, type: 'paragraph', durable: false, src: null, gapBefore: null, dirty: false, inline: [] });
  const def = (id: string, label: string): BlockNode =>
    ({ id, type: 'footnote_definition', durable: false, src: null, gapBefore: null, dirty: false, label, children: [] });

  it('returns the same array reference when there are no definitions', () => {
    const blocks = [p('a'), p('b')];
    expect(orderForDisplay(blocks)).toBe(blocks);
  });

  it('moves definitions to the end in model order, keeping body order', () => {
    const blocks = [p('a'), def('d1', '1'), p('b'), def('d2', '2')];
    expect(orderForDisplay(blocks).map((b) => b.id)).toEqual(['a', 'b', 'd1', 'd2']);
  });
});
