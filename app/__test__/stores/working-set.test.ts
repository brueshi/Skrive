// List mechanics for the working-set model (SKR-243): LRU promotion with a
// pinned-aware cap, and the browser-style document trail behind ⌘⇧[ / ⌘⇧].

import { describe, expect, it } from 'vitest';
import { WORKING_SET_CAP, type WorkingSetEntryState } from '@skrive/shared';
import {
  EMPTY_TRAIL,
  peekVisit,
  promoteEntry,
  pruneTrail,
  pushVisit,
  renameInTrail,
  type NavTrail
} from '../../src/stores/working-set';

function entry(path: string): WorkingSetEntryState {
  return {
    path,
    layoutMode: 'split',
    cursor: { line: 1, column: 0 },
    scrollTop: 0,
    splitDividerRatio: 0.5
  };
}

function trail(paths: string[], index = paths.length - 1): NavTrail {
  return { paths, index };
}

describe('promoteEntry', () => {
  it('moves an existing entry to the front, keeping the rest in order', () => {
    const set = [entry('a'), entry('b'), entry('c')];
    const next = promoteEntry(set, entry('c'), []);
    expect(next.map((e) => e.path)).toEqual(['c', 'a', 'b']);
  });

  it('replaces the stale entry for the promoted path', () => {
    const stale = entry('a');
    const fresh = { ...entry('a'), scrollTop: 99 };
    const next = promoteEntry([stale, entry('b')], fresh, []);
    expect(next[0]).toBe(fresh);
    expect(next).toHaveLength(2);
  });

  it('evicts the least-recent unpinned entry past the cap', () => {
    const set = Array.from({ length: WORKING_SET_CAP }, (_, i) =>
      entry(`${i}`)
    );
    const next = promoteEntry(set, entry('new'), []);
    expect(next).toHaveLength(WORKING_SET_CAP);
    expect(next[0]?.path).toBe('new');
    expect(next.some((e) => e.path === `${WORKING_SET_CAP - 1}`)).toBe(false);
  });

  it('pinned entries never evict and do not count against the cap', () => {
    const set = [
      ...Array.from({ length: WORKING_SET_CAP }, (_, i) => entry(`${i}`)),
      entry('pinned-old')
    ];
    const next = promoteEntry(set, entry('new'), ['pinned-old']);
    expect(next.some((e) => e.path === 'pinned-old')).toBe(true);
    expect(
      next.filter((e) => e.path !== 'pinned-old')
    ).toHaveLength(WORKING_SET_CAP);
  });
});

describe('pushVisit / peekVisit', () => {
  it('appends visits and points the cursor at the newest', () => {
    let t = pushVisit(EMPTY_TRAIL, 'a');
    t = pushVisit(t, 'b');
    expect(t).toEqual(trail(['a', 'b']));
    expect(peekVisit(t, -1)).toBe('a');
    expect(peekVisit(t, 1)).toBeNull();
  });

  it('re-visiting the current path is a no-op', () => {
    const t = pushVisit(pushVisit(EMPTY_TRAIL, 'a'), 'a');
    expect(t).toEqual(trail(['a']));
  });

  it('a visit mid-trail truncates the forward branch', () => {
    const t = pushVisit(trail(['a', 'b', 'c'], 0), 'd');
    expect(t).toEqual(trail(['a', 'd']));
  });

  it('caps the trail from the old end', () => {
    let t = EMPTY_TRAIL;
    for (let i = 0; i < 60; i++) t = pushVisit(t, `${i}`);
    expect(t.paths).toHaveLength(50);
    expect(t.paths[0]).toBe('10');
    expect(t.index).toBe(49);
  });
});

describe('pruneTrail', () => {
  it('drops vanished files and collapses the duplicates that exposes', () => {
    const t = pruneTrail(trail(['a', 'b', 'a', 'c']), (p) => p !== 'b');
    expect(t.paths).toEqual(['a', 'c']);
  });

  it('keeps the cursor on the nearest surviving visit', () => {
    const t = pruneTrail(trail(['a', 'b', 'c'], 1), (p) => p !== 'b');
    expect(t.paths).toEqual(['a', 'c']);
    expect(t.index).toBe(0);
    expect(peekVisit(t, 1)).toBe('c');
  });

  it('handles everything-before-the-cursor vanishing', () => {
    const t = pruneTrail(trail(['a', 'b'], 0), (p) => p === 'b');
    expect(t.paths).toEqual(['b']);
    expect(t.index).toBe(-1);
    expect(peekVisit(t, 1)).toBe('b');
    expect(peekVisit(t, -1)).toBeNull();
  });
});

describe('renameInTrail', () => {
  it('repoints every visit of the renamed file', () => {
    const t = renameInTrail(trail(['a', 'b', 'a']), 'a', 'z');
    expect(t.paths).toEqual(['z', 'b', 'z']);
  });

  it('returns the same trail when the path is absent', () => {
    const t = trail(['a']);
    expect(renameInTrail(t, 'x', 'y')).toBe(t);
  });
});
