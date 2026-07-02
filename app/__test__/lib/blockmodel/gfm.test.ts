// GFM task lists + strikethrough (SKR-142). The two constructs graduate from
// frozen-text to modeled: list items carry `checked`, inline marks gain
// `strikethrough`. Fidelity must hold at every seam — zero-edit byte identity,
// edit-then-revert restoration, and canonical re-serialization that re-parses
// mdast-equal.

import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from '../../../src/lib/blockmodel';
import type { BlockNode, Document } from '../../../src/lib/blockmodel';

const roundTrip = (md: string): string => serializeDocument(parseDocument(md));

function dirtyAll(doc: Document): Document {
  const blocks = doc.blocks.map((b) => (b.type === 'frozen_block' ? b : ({ ...b, dirty: true } as BlockNode)));
  return { ...doc, blocks };
}

function firstList(md: string) {
  const block = parseDocument(md).blocks[0]!;
  if (block.type !== 'bullet_list' && block.type !== 'ordered_list') {
    throw new Error(`expected list, got ${block.type}`);
  }
  return block;
}

function firstParagraph(md: string) {
  const block = parseDocument(md).blocks[0]!;
  if (block.type !== 'paragraph') throw new Error(`expected paragraph, got ${block.type}`);
  return block;
}

describe('task lists are modeled', () => {
  it('parses checked state onto list items', () => {
    const list = firstList('- [ ] open\n- [x] done\n- plain');
    expect(list.items.map((i) => i.checked)).toEqual([false, true, undefined]);
  });

  it('round-trips a mixed task list byte-for-byte', () => {
    const md = '- [ ] open\n- [x] done\n- plain\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('round-trips nested task lists byte-for-byte', () => {
    const md = '- [ ] parent\n  - [x] child\n  - [ ] child two\n- [x] sibling\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('edit-then-revert restores the original bytes', () => {
    const md = '- [ ] open\n- [x] done\n';
    expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
  });

  it('a dirtied task list re-serializes canonical GFM checkboxes', () => {
    // Uppercase X is valid GFM input but not the canonical form; a real edit
    // (checked flip) forces canonical output.
    const doc = parseDocument('- [X] shouty\n- [ ] open\n');
    const list = doc.blocks[0]!;
    if (list.type !== 'bullet_list') throw new Error('expected bullet_list');
    const flipped: BlockNode = {
      ...list,
      dirty: true,
      items: list.items.map((item, i) => (i === 1 ? { ...item, checked: true } : item))
    };
    const out = serializeDocument({ ...doc, blocks: [flipped] });
    expect(out).toBe('- [x] shouty\n- [x] open\n');
  });

  it('ordered task lists round-trip', () => {
    const md = '1. [x] first\n2. [ ] second\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('task state survives a dirty spread list with nested blocks', () => {
    const md = '- [ ] parent\n\n  a second paragraph\n\n- [x] done\n';
    expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
  });
});

describe('strikethrough is modeled', () => {
  it('parses ~~text~~ as a strikethrough mark, not literal tildes', () => {
    const para = firstParagraph('before ~~struck~~ after');
    const struck = para.inline.find((n) => n.kind === 'text' && n.marks.strikethrough);
    expect(struck).toBeDefined();
    expect(struck!.kind === 'text' && struck!.text).toBe('struck');
  });

  it('round-trips strikethrough byte-for-byte, clean and dirtied', () => {
    const md = 'before ~~struck~~ after\n';
    expect(roundTrip(md)).toBe(md);
    expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
  });

  it('composes with strong without serialization drift (majority nesting)', () => {
    for (const md of ['a ~~**both**~~ b\n', 'a ~~***em strong strike***~~ b\n']) {
      expect(roundTrip(md)).toBe(md);
      // Dirty: canonical form must re-parse mdast-equal, so the guard restores bytes.
      expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
    }
  });

  it('minority nesting canonicalizes to the majority form when dirtied', () => {
    // Marks are flat in the model; coextensive nesting order is unrecoverable.
    // WRAPPER_PRIORITY makes strikethrough the outer wrapper — same rendering,
    // flipped tree — matching the established em/strong tie behavior.
    expect(roundTrip('a **~~both~~** b\n')).toBe('a **~~both~~** b\n'); // clean: verbatim src
    expect(serializeDocument(dirtyAll(parseDocument('a **~~both~~** b\n')))).toBe('a ~~**both**~~ b\n');
  });

  it('strikethrough inside a table cell round-trips when dirtied', () => {
    const md = '| a | b |\n| --- | --- |\n| ~~gone~~ | kept |\n';
    expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
  });

  it('a genuinely edited strikethrough paragraph emits ~~ syntax', () => {
    const doc = parseDocument('~~struck~~');
    const para = doc.blocks[0]!;
    if (para.type !== 'paragraph') throw new Error('expected paragraph');
    const edited: BlockNode = {
      ...para,
      dirty: true,
      inline: [...para.inline, { kind: 'text', text: ' more', marks: { strikethrough: true } }]
    };
    const out = serializeDocument({ ...doc, blocks: [edited] });
    expect(out).toBe('~~struck more~~');
  });

  it('literal tildes in plain text survive a dirty re-serialization', () => {
    // A paragraph containing text-that-looks-like-markup must re-parse equal,
    // which forces the serializer to escape it.
    const md = 'tilde ~~ soup ~~~ here\n';
    expect(serializeDocument(dirtyAll(parseDocument(md)))).toBe(md);
  });
});
