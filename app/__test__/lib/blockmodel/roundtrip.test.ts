// The Stage 1 Done gate (SKR-96): the same fidelity corpus the projection bridge
// passes, now driven FROM the canonical block model. Seam 1 (zero-edit round-trip
// byte-identity) is the kill switch — if a clean load->serialize is not
// byte-identical, the block-canonical-with-Markdown-floor premise is dead.
//
// The corpus is the projection bridge's own: the crafted fixture, the exotic
// unmodeled-construct string, and every real repo doc under planning/ and
// docs/fixtures. Byte-identity must hold regardless of how richly the model
// understood a construct, because a clean or frozen block emits its verbatim
// `src` — fidelity depends only on the source map tiling the document exactly.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../../../src/lib/blockmodel/parse';
import { serializeDocument } from '../../../src/lib/blockmodel/serialize';
import type { BlockNode, Document } from '../../../src/lib/blockmodel/types';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');
const fixture = readFileSync(resolve(here, 'fixture.md'), 'utf8');

const roundTrip = (md: string): string => serializeDocument(parseDocument(md));

// Replace the last block with a dirtied copy, optionally appending inline text so
// the block genuinely re-serializes (vs. the edit-then-revert no-op case).
function dirtyLast(doc: Document, appendText?: string): Document {
  const blocks = doc.blocks.slice();
  const k = blocks.length - 1;
  const block = blocks[k]!;
  let next: BlockNode = { ...block, dirty: true } as BlockNode;
  if (appendText && (next.type === 'paragraph' || next.type === 'heading')) {
    next = { ...next, inline: [...next.inline, { kind: 'text', text: appendText, marks: {} }] };
  }
  blocks[k] = next;
  return { ...doc, blocks };
}

describe('block-model fidelity gate', () => {
  it('seam 1 — zero-edit round-trip is byte-identical (KILL SWITCH)', () => {
    expect(roundTrip(fixture)).toBe(fixture);
  });

  it('seam 3 — cycle idempotence: parse/serialize is stable across repeats', () => {
    let out = roundTrip(fixture);
    for (let i = 0; i < 12; i++) out = roundTrip(out);
    expect(out).toBe(fixture);
  });

  it('seam 3 — edit-then-revert restores original bytes via the idempotence guard', () => {
    // Dirty the last block but change nothing: canonical re-parses equal to src,
    // so the guard restores the original bytes.
    expect(serializeDocument(dirtyLast(parseDocument(fixture)))).toBe(fixture);
  });

  it('seam 2 — editing one block leaves every other block byte-identical', () => {
    const doc = parseDocument(fixture);
    const untouched = doc.blocks
      .slice(0, -1)
      .map((b) => (b.type === 'frozen_block' ? b.src : b.src))
      .filter((s): s is string => s != null);
    const out = serializeDocument(dirtyLast(doc, ' EDITED'));
    expect(out).not.toBe(fixture);
    expect(out).toContain('EDITED');
    for (const src of untouched) expect(out).toContain(src);
  });

  it('seam 1 — unmodeled constructs round-trip verbatim', () => {
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
    expect(roundTrip(exotic)).toBe(exotic);
  });
});

function mdFilesIn(rel: string): string[] {
  const dir = join(repoRoot, rel);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(rel, f));
  } catch {
    return [];
  }
}

const targets = [...mdFilesIn('planning'), ...mdFilesIn('docs/fixtures')];

describe('block-model round-trip on real repo docs', () => {
  it('found docs to test', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)('round-trips byte-identical: %s', (rel) => {
    const md = readFileSync(join(repoRoot, rel), 'utf8');
    const out = roundTrip(md);
    if (out !== md) {
      let i = 0;
      while (i < out.length && i < md.length && out[i] === md[i]) i++;
      const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
      throw new Error(`divergence at byte ${i} in ${rel}\n  expected: ${ctx(md)}\n  got:      ${ctx(out)}`);
    }
    expect(out).toBe(md);
  });
});
