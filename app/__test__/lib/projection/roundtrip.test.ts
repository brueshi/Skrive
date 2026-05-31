// Fidelity gate. Seam 1 (round-trip identity) is the kill switch: if a zero-edit
// load->serialize is not byte-identical, the faithful-Markdown-over-PM premise
// is dead. See planning/projection-editor-master-plan.md (Stage 1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';

const here = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(resolve(here, 'fixture.md'), 'utf8');

// ---- test-only editing helpers (the real bridge tracks dirty via PM steps) ----

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

function rebuildDoc(doc: PMNode, blocks: PMNode[]): PMNode {
  return schema.node('doc', doc.attrs, blocks);
}

// Mark a block dirty, optionally replacing its inline content.
function dirty(block: PMNode, newInline?: PMNode[]): PMNode {
  const content = newInline ?? childrenOf(block);
  return schema.node(block.type.name, { ...block.attrs, dirty: true }, content);
}

function blockBySrcIncludes(doc: PMNode, needle: string): PMNode {
  const found = childrenOf(doc).find((b) => (b.attrs.src ?? '').includes(needle));
  if (!found) throw new Error(`no block whose src includes ${JSON.stringify(needle)}`);
  return found;
}

describe('projection fidelity gate', () => {
  it('seam 1 — zero-edit round-trip is byte-identical (KILL SWITCH)', () => {
    expect(serializeDoc(parseDoc(md))).toBe(md);
  });

  it('seam 2 — editing one block leaves every other block byte-identical', () => {
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    const k = blocks.length - 1; // closing paragraph

    const untouchedSrcs = blocks
      .filter((_, i) => i !== k)
      .map((b) => b.attrs.src as string);

    blocks[k] = dirty(blocks[k], [...childrenOf(blocks[k]), schema.text(' EDITED')]);
    const out = serializeDoc(rebuildDoc(doc, blocks));

    expect(out).not.toBe(md);
    expect(out).toContain('EDITED');
    for (const src of untouchedSrcs) expect(out).toContain(src);
  });

  it('seam 3 — cycle idempotence: parse/serialize is stable across repeats', () => {
    let out = serializeDoc(parseDoc(md));
    for (let i = 0; i < 12; i++) out = serializeDoc(parseDoc(out));
    expect(out).toBe(md);
  });

  it('seam 3 — edit-then-revert restores original bytes via the idempotence guard', () => {
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    const k = blocks.length - 1;
    blocks[k] = dirty(blocks[k]); // dirty but content unchanged (the revert case)
    expect(serializeDoc(rebuildDoc(doc, blocks))).toBe(md);
  });

  it('seam 4 — litmus: untouched `*`-bullet list keeps its markers when another block is edited', () => {
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    const listSrc = blockBySrcIncludes(doc, '* first bullet').attrs.src as string;

    const k = blocks.length - 1; // edit the closing paragraph, not the list
    blocks[k] = dirty(blocks[k], [...childrenOf(blocks[k]), schema.text(' EDITED')]);
    const out = serializeDoc(rebuildDoc(doc, blocks));

    expect(out).toContain(listSrc);
    expect(out).toContain('* first bullet');
  });

  it('seam 1 — unmodeled constructs (frontmatter, table, blockquote, ordered list) round-trip verbatim', () => {
    const exotic = [
      '---',
      'title: Spike',
      'tags: [a, b]',
      '---',
      '',
      '# Heading',
      '',
      '> a blockquote',
      '> spanning lines',
      '',
      '1. first',
      '2. second',
      '',
      '| col a | col b |',
      '| ----- | ----- |',
      '| 1     | 2     |',
      '',
      'Trailing prose.',
      ''
    ].join('\n');
    expect(serializeDoc(parseDoc(exotic))).toBe(exotic);
  });

  it('a genuinely edited block re-serializes and still round-trips', () => {
    const doc = parseDoc(md);
    const blocks = childrenOf(doc);
    const k = blocks.length - 1;
    blocks[k] = dirty(blocks[k], [...childrenOf(blocks[k]), schema.text(' EDITED')]);
    const out = serializeDoc(rebuildDoc(doc, blocks));
    expect(serializeDoc(parseDoc(out))).toBe(out);
  });

  it('an empty document round-trips', () => {
    expect(serializeDoc(parseDoc(''))).toBe('');
  });
});
