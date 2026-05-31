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

describe('frozen blocks (unmodeled constructs)', () => {
  it('blockquotes, thematic breaks, and HTML become frozen_block nodes', () => {
    // CommonMark constructs the parser recognises but the schema does not model.
    const cases = ['> a quote\n', '---\n', '<div>raw html</div>\n'];
    for (const md of cases) {
      const doc = parseDoc(md);
      expect(topBlock(doc).type.name).toBe('frozen_block');
      expect(serializeDoc(doc)).toBe(md);
    }
  });

  it('a GFM table round-trips verbatim (parsed as plain text under CommonMark)', () => {
    // We parse bare CommonMark, so a table tiles as ordinary blocks; byte-fidelity
    // holds regardless because clean blocks emit their verbatim source.
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('loose and nested lists are frozen rather than flattened', () => {
    const loose = '- first\n\n- second\n';
    const nested = '- parent\n  - child\n';
    expect(topBlock(parseDoc(loose)).type.name).toBe('frozen_block');
    expect(topBlock(parseDoc(nested)).type.name).toBe('frozen_block');
    expect(serializeDoc(parseDoc(loose))).toBe(loose);
    expect(serializeDoc(parseDoc(nested))).toBe(nested);
  });

  it('a frozen block always emits its source even if a stray dirty flag is forced around it', () => {
    // Editing elsewhere must never canonicalize a frozen construct.
    const md = 'A paragraph.\n\n> a quote that must survive\n';
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    blocks[0] = dirtied(blocks[0]); // dirty the paragraph, not the quote
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
