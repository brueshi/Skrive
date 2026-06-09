// Rebuild gating for the inline-preview decoration plugin. Every handler
// consumes the selection only through line membership, so the plugin
// caches a canonical cursor-line key and skips the viewport tree walk
// when nothing a handler reads has changed. These tests pin down the key
// derivation (canonical across range order and overlap) and the skip
// decision (any changed input forces a rebuild).

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  cursorLineKey,
  shouldSkipRebuild
} from '../../src/components/editor/decorations/shared';
import type { RebuildSignals } from '../../src/components/editor/decorations/shared';

// "alpha\nbravo\ncharlie\ndelta\necho" — line starts at 0, 6, 12, 20, 26.
const doc = Text.of(['alpha', 'bravo', 'charlie', 'delta', 'echo']);

describe('cursorLineKey', () => {
  it('keys a single empty cursor by its line number', () => {
    expect(cursorLineKey(doc, [{ from: 7, to: 7 }])).toBe('2');
  });

  it('expands a selection spanning lines into every covered line', () => {
    // From inside line 1 to inside line 3.
    expect(cursorLineKey(doc, [{ from: 2, to: 14 }])).toBe('1,2,3');
  });

  it('unions the lines of a multi-range selection', () => {
    expect(
      cursorLineKey(doc, [
        { from: 0, to: 0 },
        { from: 13, to: 21 }
      ])
    ).toBe('1,3,4');
  });

  it('produces the same key for the same line set in different order', () => {
    const forward = cursorLineKey(doc, [
      { from: 0, to: 0 },
      { from: 13, to: 13 }
    ]);
    const reversed = cursorLineKey(doc, [
      { from: 13, to: 13 },
      { from: 0, to: 0 }
    ]);
    expect(reversed).toBe(forward);
  });

  it('deduplicates ranges that land on the same line', () => {
    expect(
      cursorLineKey(doc, [
        { from: 6, to: 6 },
        { from: 9, to: 11 }
      ])
    ).toBe('2');
  });

  it('is stable while the cursor moves within one line', () => {
    expect(cursorLineKey(doc, [{ from: 6, to: 6 }])).toBe(
      cursorLineKey(doc, [{ from: 10, to: 10 }])
    );
  });

  it('changes when the cursor crosses to another line', () => {
    expect(cursorLineKey(doc, [{ from: 6, to: 6 }])).not.toBe(
      cursorLineKey(doc, [{ from: 12, to: 12 }])
    );
  });

  it('reflects line renumbering after a doc change at the same offset', () => {
    // Same character offset, but an inserted line above shifts the line
    // numbers — the key must follow the new document's line map.
    const grown = Text.of(['inserted', 'alpha', 'bravo']);
    expect(cursorLineKey(doc, [{ from: 7, to: 7 }])).toBe('2');
    expect(cursorLineKey(grown, [{ from: 7, to: 7 }])).toBe('1');
  });
});

describe('shouldSkipRebuild', () => {
  const unchanged: RebuildSignals = {
    docChanged: false,
    viewportChanged: false,
    treeChanged: false,
    modeChanged: false,
    configChanged: false,
    previousCursorLineKey: '3',
    cursorLineKey: '3'
  };

  it('skips when every handler input is unchanged', () => {
    expect(shouldSkipRebuild(unchanged)).toBe(true);
  });

  it('rebuilds when the cursor-line set changed', () => {
    expect(
      shouldSkipRebuild({ ...unchanged, cursorLineKey: '4' })
    ).toBe(false);
  });

  it('rebuilds on doc change even with an identical cursor-line key', () => {
    expect(shouldSkipRebuild({ ...unchanged, docChanged: true })).toBe(false);
  });

  it('rebuilds on viewport change even with an identical key', () => {
    expect(
      shouldSkipRebuild({ ...unchanged, viewportChanged: true })
    ).toBe(false);
  });

  it('rebuilds when the syntax tree advanced without a doc change', () => {
    expect(shouldSkipRebuild({ ...unchanged, treeChanged: true })).toBe(false);
  });

  it('rebuilds on marker-mode change', () => {
    expect(shouldSkipRebuild({ ...unchanged, modeChanged: true })).toBe(false);
  });

  it('rebuilds on handler config change', () => {
    expect(
      shouldSkipRebuild({ ...unchanged, configChanged: true })
    ).toBe(false);
  });
});
