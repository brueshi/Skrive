// Focus mode strips the ambient readouts — the outline rail and the word-count
// badge — and both are mounted by more than one surface: the block editor has a
// pair, and the Markdown path has its own (MarkdownView's badge, Preview's rail).
// The first cut of SKR-52 gated only the block editor's, so in a `.md` document
// focus mode stripped everything EXCEPT those two.
//
// Gating lives at the render site rather than inside the components, because that
// is what stops the work behind them (the counter's recompute, the rail's heading
// scan and ResizeObserver) — their observers watch the PARENT's refs, so a
// component that returned null would keep measuring. The tradeoff is that a new
// surface can forget, which is precisely what happened. This pins the invariant:
// mount an ambient readout, know about focus mode.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

/** The ambient readouts, by the component name a render site imports. */
const AMBIENT = ['OutlineRail', 'WordCountBadge'];

/** Their own definitions — they don't gate themselves. */
const DEFINITIONS = ['components/editor/OutlineRail.tsx', 'components/editor/WordCountBadge.tsx'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('focus mode strips every ambient readout', () => {
  it('every surface that renders one also gates on focusMode', () => {
    const offenders: string[] = [];
    let renderSites = 0;

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (DEFINITIONS.includes(rel)) continue;
      const source = readFileSync(file, 'utf8');
      const mounted = AMBIENT.filter((name) => source.includes(`<${name}`));
      if (mounted.length === 0) continue;
      renderSites += 1;
      if (!source.includes('focusMode')) {
        offenders.push(`${rel} renders ${mounted.join(' + ')} without a focusMode gate`);
      }
    }

    // Guards the guard: if the components are ever renamed, this test must fail
    // loudly rather than silently pass over zero render sites.
    expect(renderSites, 'no ambient render sites found — did a component get renamed?')
      .toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
