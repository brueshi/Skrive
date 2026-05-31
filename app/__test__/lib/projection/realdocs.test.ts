// Stress seam 1 (round-trip identity) on real, uncrafted repo docs, including
// constructs the schema does NOT model richly (blockquotes, tables, frontmatter,
// ordered/nested lists, HTML). Byte-identity must hold anyway: a clean or frozen
// block emits its verbatim `src`, so fidelity depends only on the source map
// tiling the document exactly, not on how well the tree understood it.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc } from '../../../src/lib/projection/serialize';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');

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

describe('projection round-trip on real repo docs', () => {
  it('found docs to test', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)('round-trips byte-identical: %s', (rel) => {
    const md = readFileSync(join(repoRoot, rel), 'utf8');
    const out = serializeDoc(parseDoc(md));
    if (out !== md) {
      let i = 0;
      while (i < out.length && i < md.length && out[i] === md[i]) i++;
      const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
      throw new Error(
        `divergence at byte ${i} in ${rel}\n  expected: ${ctx(md)}\n  got:      ${ctx(out)}`
      );
    }
    expect(out).toBe(md);
  });
});
