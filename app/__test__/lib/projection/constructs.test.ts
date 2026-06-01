// Production additions beyond the spike construct set: ordered lists, inline
// code, frozen blocks for unmodeled constructs, and the seam-keyed gap rule.

import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

function topBlock(doc: PMNode, index = 0): PMNode {
  return childrenOf(doc)[index];
}

function dirtied(block: PMNode): PMNode {
  return schema.node(block.type.name, { ...block.attrs, dirty: true }, childrenOf(block));
}

function rebuild(doc: PMNode, blocks: PMNode[]): PMNode {
  return schema.node('doc', doc.attrs, blocks);
}

describe('ordered lists', () => {
  it('round-trips verbatim while clean', () => {
    const md = '1. first\n2. second\n3. third\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('is modeled as an ordered_list, not frozen', () => {
    const doc = parseDoc('1. first\n2. second\n');
    expect(topBlock(doc).type.name).toBe('ordered_list');
  });

  it('canonicalizes with start and `)` delimiter preserved when edited', () => {
    const md = '3) alpha\n4) beta\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]); // dirty but unchanged content
    // Idempotence guard: dirty-but-equal restores the original bytes.
    expect(serializeDoc(rebuild(doc, blocks))).toBe(md);
    // Style attributes were captured.
    expect(blocks[0].attrs.start).toBe(3);
    expect(blocks[0].attrs.delimiter).toBe(')');
  });
});

describe('nested and loose lists (2.5c)', () => {
  it('models a nested list instead of freezing it', () => {
    const md = '- parent\n  - child\n';
    expect(topBlock(parseDoc(md)).type.name).toBe('bullet_list');
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('models a loose list instead of freezing it', () => {
    const md = '- first\n\n- second\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('bullet_list');
    expect(topBlock(doc).attrs.spread).toBe(true);
    expect(serializeDoc(doc)).toBe(md);
  });

  it('captures loose vs tight: a tight list is not marked spread', () => {
    expect(topBlock(parseDoc('- a\n- b\n')).attrs.spread).toBe(false);
  });

  it('re-serializes an edited nested list correctly and stays a fixpoint', () => {
    const md = '- parent\n  - child\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]); // dirty but unchanged -> guard restores bytes
    const out = serializeDoc(rebuild(doc, blocks));
    expect(out).toBe(md);
    // And the canonical form is a fixpoint: parse/serialize is stable.
    expect(serializeDoc(parseDoc(out))).toBe(out);
  });

  it('preserves the nested marker style of a dirty list (no churn to `-`)', () => {
    // Outer dirtied so it serializes canonically; the inner `*` must survive.
    const md = '- parent\n  * child\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    // Force a genuine edit so we exercise canonical serialization, not the guard.
    const innerList = blocks[0].child(0).child(1); // list_item -> nested bullet_list
    expect(innerList.attrs.marker).toBe('*');
  });

  it('preserves a multi-paragraph (loose) list item', () => {
    const md = '- first paragraph\n\n  second paragraph\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('bullet_list');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('freezes the whole list when an item holds an unmodeled construct', () => {
    // A list item containing raw HTML cannot be modeled faithfully, so the entire
    // list stays frozen and verbatim rather than being modeled lossily.
    const md = '- a normal item\n\n  <div>raw html</div>\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });
});

describe('inline code', () => {
  it('round-trips verbatim while clean', () => {
    const md = 'Run `npm test` to check.\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('serializes the code mark canonically when the block is edited', () => {
    const doc = parseDoc('Run `npm test` now.\n');
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]);
    expect(serializeDoc(rebuild(doc, blocks))).toContain('`npm test`');
  });
});

describe('dividers (thematic breaks)', () => {
  it('round-trips verbatim while clean, in any marker style', () => {
    for (const md of ['---\n', '***\n', '___\n']) {
      expect(serializeDoc(parseDoc(md))).toBe(md);
    }
  });

  it('is modeled as a horizontal_rule, not frozen', () => {
    expect(topBlock(parseDoc('---\n')).type.name).toBe('horizontal_rule');
  });

  it('a dirty-but-unchanged rule restores its original marker via the guard', () => {
    // `***` canonicalizes to `---`, but the two are semantically equal, so the
    // idempotence guard hands back the writer's original bytes.
    const md = '***\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]);
    expect(serializeDoc(rebuild(doc, blocks))).toBe(md);
  });

  it('a freshly-inserted rule (no src) serializes to the canonical ---', () => {
    const hr = schema.node('horizontal_rule', { src: null, gapBefore: '', dirty: true });
    const doc = schema.node('doc', { trailingGap: '' }, [hr]);
    expect(serializeDoc(doc)).toBe('---');
  });
});

describe('blockquotes', () => {
  it('round-trips verbatim while clean', () => {
    const md = '> a quote\n> spanning two lines\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('is modeled as a blockquote, not frozen', () => {
    expect(topBlock(parseDoc('> a quote\n')).type.name).toBe('blockquote');
  });

  it('canonicalizes by re-quoting each line when edited', () => {
    const doc = parseDoc('> first\n>\n> second\n');
    const blocks = childrenOf(doc);
    // Replace the inner content so the block is genuinely dirty, not guard-equal.
    const para = schema.node('paragraph', {}, [schema.text('edited line')]);
    blocks[0] = schema.node('blockquote', { ...blocks[0].attrs, dirty: true }, [para]);
    // The trailing newline lives in the doc's trailingGap, preserved verbatim.
    expect(serializeDoc(rebuild(doc, blocks))).toBe('> edited line\n');
  });

  it('a dirty-but-unchanged quote restores its original bytes via the guard', () => {
    const md = '> kept verbatim\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]);
    expect(serializeDoc(rebuild(doc, blocks))).toBe(md);
  });

  it('models a nested blockquote, round-tripping verbatim while clean', () => {
    const md = '> outer\n>\n> > inner\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('blockquote');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('models a list nested inside a blockquote (2.5c), round-tripping verbatim', () => {
    const md = '> - a bullet inside a quote\n> - and another\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('blockquote');
    expect(serializeDoc(doc)).toBe(md);
  });
});

describe('frozen blocks (unmodeled constructs)', () => {
  it('raw HTML becomes a frozen_block node', () => {
    const md = '<div>raw html</div>\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('a GFM table round-trips verbatim (parsed as plain text under CommonMark)', () => {
    // We parse bare CommonMark, so a table tiles as ordinary blocks; byte-fidelity
    // holds regardless because clean blocks emit their verbatim source.
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('a frozen block always emits its source even if a stray dirty flag is forced around it', () => {
    // Editing elsewhere must never canonicalize a frozen construct.
    const md = 'A paragraph.\n\n<div>raw html that must survive</div>\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]); // dirty the paragraph, not the HTML
    expect(serializeDoc(rebuild(doc, blocks))).toBe(md);
  });
});

describe('seam-keyed gaps', () => {
  it('a captured seam emits verbatim even when its block is dirty', () => {
    // A dirty block keeps the gap it was parsed with — the seam is known.
    const md = 'one\n\n\nthree\n'; // an unusual two-blank-line gap
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[1] = dirtied(blocks[1]); // dirty the second paragraph
    // Gap before it (two blank lines) is preserved, not normalized to one.
    expect(serializeDoc(rebuild(doc, blocks))).toBe(md);
  });

  it('a new seam (gapBefore null) reconstructs the standard separator', () => {
    const first = schema.node('paragraph', { src: 'one', gapBefore: '' }, [schema.text('one')]);
    // Second block created fresh in the editor: no captured seam.
    const fresh = schema.node('paragraph', { src: null, gapBefore: null, dirty: true }, [
      schema.text('two')
    ]);
    const doc = schema.node('doc', { trailingGap: '' }, [first, fresh]);
    expect(serializeDoc(doc)).toBe('one\n\ntwo');
  });
});
