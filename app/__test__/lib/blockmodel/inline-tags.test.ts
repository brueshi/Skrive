// Inline tags: `#tag` / nested `#parent/child`. Pins the whole model round-trip —
// recognition and its word-boundary exclusions, the `.md` literal serialization,
// the `.folio` native leaf, plaintext, and the offset math a tag's multi-cell atom
// width drives. Pure model, no DOM.

import { describe, it, expect } from 'vitest';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import { documentToPlainText } from '../../../src/lib/blockmodel/plaintext';
import type { BlockNode, Document, InlineNode } from '../../../src/lib/blockmodel/types';
import {
  deleteRangeInInline,
  inlineLength,
  inlinePlainText,
  insertTagInInline,
  insertTextInInline
} from '../../../src/lib/blocksurface/inline-ops';
import { modelToFolio, folioToModel } from '../../../src/lib/folio/convert';
import { serializeFolio } from '../../../src/lib/folio/serialize';
import { parseFolio } from '../../../src/lib/folio/parse';
import type { FolioMeta } from '../../../src/lib/folio/types';

// The inline content of the first paragraph parsed from `md`.
function inlineOf(md: string): InlineNode[] {
  const block = parseDocument(md).blocks[0]!;
  if (block.type !== 'paragraph' && block.type !== 'heading') {
    throw new Error(`expected a paragraph/heading, got ${block.type}`);
  }
  return block.inline;
}

const tag = (name: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'tag', name, marks });
const text = (t: string, marks: InlineNode['marks'] = {}): InlineNode => ({ kind: 'text', text: t, marks });

describe('inline tag recognition', () => {
  it('recognizes a tag at the start of a paragraph', () => {
    expect(inlineOf('#todo')).toEqual([tag('todo')]);
  });

  it('recognizes a tag after whitespace, keeping surrounding text', () => {
    expect(inlineOf('see #todo now')).toEqual([text('see '), tag('todo'), text(' now')]);
  });

  it('recognizes a nested tag as one token', () => {
    expect(inlineOf('#parent/child')).toEqual([tag('parent/child')]);
  });

  it('recognizes multiple tags in one run', () => {
    expect(inlineOf('#a and #b')).toEqual([tag('a'), text(' and '), tag('b')]);
  });

  it('carries the surrounding mark context onto the tag', () => {
    expect(inlineOf('*#todo*')).toEqual([tag('todo', { em: true })]);
  });
});

describe('inline tag word-boundary exclusions', () => {
  it('does not treat a trailing hash language like C# as a tag', () => {
    expect(inlineOf('I write C# daily')).toEqual([text('I write C# daily')]);
  });

  it('does not treat a URL fragment as a tag', () => {
    expect(inlineOf('see example.com/#frag here')).toEqual([text('see example.com/#frag here')]);
  });

  it('does not treat a mid-word hash as a tag', () => {
    expect(inlineOf('a#b')).toEqual([text('a#b')]);
  });

  it('does not treat hash + space (a heading marker shape) as a tag', () => {
    expect(inlineOf('done # not a tag')).toEqual([text('done # not a tag')]);
  });

  it('leaves a bare hash literal', () => {
    expect(inlineOf('just # here')).toEqual([text('just # here')]);
  });
});

describe('.md serialization', () => {
  const roundTrip = (md: string): string => serializeDocument(parseDocument(md));

  // Dirty the last block so it genuinely re-serializes (vs. emitting verbatim src).
  function dirtyLast(doc: Document): Document {
    const blocks = doc.blocks.slice();
    const k = blocks.length - 1;
    blocks[k] = { ...blocks[k]!, dirty: true } as BlockNode;
    return { ...doc, blocks };
  }

  it('round-trips a clean tag document byte-for-byte', () => {
    expect(roundTrip('see #todo and #parent/child now\n')).toBe('see #todo and #parent/child now\n');
  });

  it('re-serializes a dirtied tag block to literal #tag', () => {
    const out = serializeDocument(dirtyLast(parseDocument('see #todo now\n')));
    expect(out).toBe('see #todo now\n');
  });

  it('re-serializes a leading tag on a dirtied block back to a tag', () => {
    // A leading `#` may be escaped by the canonical stringifier, but the escaped
    // form re-parses to the same tag — the idempotence guard restores the bytes.
    const src = '#todo here\n';
    expect(roundTrip(src)).toBe(src);
    expect(inlineOf(serializeDocument(dirtyLast(parseDocument(src))))).toEqual([tag('todo'), text(' here')]);
  });
});

describe('plaintext', () => {
  it('flattens a tag to its #name text', () => {
    expect(documentToPlainText(parseDocument('see #todo now\n'))).toBe('see #todo now\n');
  });
});

describe('.folio native round-trip', () => {
  const meta: FolioMeta = { title: null, createdAt: '2026-01-01T00:00:00Z' };

  it('preserves a tag leaf through model -> folio -> model', () => {
    const doc = parseDocument('see #todo and #parent/child\n');
    const folio = modelToFolio(doc, { docId: 'doc_test', docMeta: meta });
    const back = folioToModel(folio);
    expect(back.blocks[0]!.type).toBe('paragraph');
    const inline = (back.blocks[0] as { inline: InlineNode[] }).inline;
    expect(inline).toEqual([text('see '), tag('todo'), text(' and '), tag('parent/child')]);
  });

  it('serializes and re-reads a tag leaf natively', () => {
    const doc = parseDocument('#todo\n');
    const folio = modelToFolio(doc, { docId: 'doc_test', docMeta: meta });
    const json = serializeFolio(folio);
    expect(json).toContain('"kind": "tag"');
    expect(json).toContain('"name": "todo"');
    const reparsed = parseFolio(json);
    expect(folioToModel(reparsed)).toEqual(folioToModel(folio));
  });
});

describe('offset math (multi-cell atom)', () => {
  it('counts a tag as (#+name).length cells', () => {
    // 'a ' (2) + '#todo' (5) + ' b' (2) = 9
    expect(inlineLength([text('a '), tag('todo'), text(' b')])).toBe(9);
  });

  it('reports the tag text in the flat plain text', () => {
    expect(inlinePlainText([text('a '), tag('todo'), text(' b')])).toBe('a #todo b');
  });

  it('removes the whole tag when a delete range touches any of it', () => {
    // Range [3,5) falls inside the '#todo' tag (cells 2..7); the whole tag is dropped.
    expect(deleteRangeInInline([text('a '), tag('todo'), text(' b')], 3, 5)).toEqual([text('a  b')]);
  });

  it('inserts text after a tag at its trailing boundary', () => {
    // Boundary after '#todo' is offset 7 (2 + 5); text lands between the tag and ' b'.
    expect(insertTextInInline([text('a '), tag('todo'), text(' b')], 7, 'X')).toEqual([
      text('a '),
      tag('todo'),
      text('X b')
    ]);
  });

  it('inserts text before a tag at its leading boundary', () => {
    expect(insertTextInInline([text('a '), tag('todo')], 2, 'X')).toEqual([text('a X'), tag('todo')]);
  });
});

describe('insertTagInInline', () => {
  it('splices a tag leaf at a flat offset between text runs', () => {
    expect(insertTagInInline([text('a '), text('b')], 2, 'todo', {})).toEqual([
      text('a '),
      tag('todo'),
      text('b')
    ]);
  });

  it('splices at the end of the content', () => {
    expect(insertTagInInline([text('note ')], 5, 'todo', {})).toEqual([text('note '), tag('todo')]);
  });

  it('splits a text run and inherits the given marks', () => {
    expect(insertTagInInline([text('abcd', { strong: true })], 2, 'x', { strong: true })).toEqual([
      text('ab', { strong: true }),
      tag('x', { strong: true }),
      text('cd', { strong: true })
    ]);
  });
});
