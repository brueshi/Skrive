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
const AMBIENT = ['OutlineRail', 'WordCountBadge'] as const;

/** Their own definitions — they don't gate themselves. */
const DEFINITIONS = ['components/editor/OutlineRail.tsx', 'components/editor/WordCountBadge.tsx'];

/**
 * The preference that turns each readout off, which every render site must
 * consult for the same reason it must consult focus mode. Both rails and
 * both badges once ignored these entirely: the block editor never read the
 * outline preference, and the Markdown path passed `showRail` straight from
 * the layout mode, so the Settings toggle moved nothing on either surface.
 */
const PREFERENCE = {
  OutlineRail: 'showOutlineRail',
  WordCountBadge: 'showWordCount'
} as const;

/**
 * Mount sites that legitimately do not read the preference themselves,
 * because a caller decides and passes the answer down as a prop. Naming
 * the gate owner is what makes this checkable: a scan for render sites
 * cannot reach MarkdownView, which owns the rail's gate on the Markdown
 * path while rendering Preview rather than the rail itself — and that
 * blind spot is exactly where the dead toggle survived.
 */
const DELEGATED: Array<{ mount: string; component: keyof typeof PREFERENCE; gateOwner: string }> = [
  {
    mount: 'components/editor/Preview.tsx',
    component: 'OutlineRail',
    gateOwner: 'components/editor/markdown/MarkdownView.tsx'
  }
];

const DELEGATED_MOUNTS = new Set(DELEGATED.map((d) => d.mount));

/**
 * Whether a file acts on a preference rather than merely reading it. The
 * store line mentions the name twice on its own, so a plain substring
 * check would pass a file that declares the value and then ignores it —
 * and nothing else would catch that, since noUnusedLocals is off. Assumes
 * the local is named after the preference, as every current site does.
 */
function gatesOn(source: string, pref: string): boolean {
  return source
    .split('\n')
    .filter((line) => !line.includes('usePreferencesStore'))
    .join('\n')
    .includes(pref);
}

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

  it('every surface that renders one also honours its visibility preference', () => {
    const offenders: string[] = [];
    let checkedSites = 0;

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (DEFINITIONS.includes(rel) || DELEGATED_MOUNTS.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      for (const name of AMBIENT) {
        if (!source.includes(`<${name}`)) continue;
        checkedSites += 1;
        const pref = PREFERENCE[name];
        if (!gatesOn(source, pref)) {
          offenders.push(`${rel} renders ${name} without gating on ${pref}`);
        }
      }
    }

    // Delegated mounts are unreachable by the scan above, so check the
    // file that actually owns each one's gate.
    for (const { mount, component, gateOwner } of DELEGATED) {
      checkedSites += 1;
      const owner = readFileSync(join(SRC, gateOwner), 'utf8');
      const pref = PREFERENCE[component];
      if (!gatesOn(owner, pref)) {
        offenders.push(`${gateOwner} hands ${component} to ${mount} without gating on ${pref}`);
      }
    }

    expect(checkedSites, 'no ambient render sites found — did a component get renamed?')
      .toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
