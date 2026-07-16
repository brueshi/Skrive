// The decoration overlay's pure logic: the block-keyed store (type-scoped bulk
// replacement, affected-block notification, keystroke-path invalidation) and the
// viewport->content coordinate mapping. The geometry itself (range client rects)
// needs real layout and is verified in the shell; everything testable without a
// browser is pinned here.

import { describe, it, expect, vi } from 'vitest';
import { DecorationStore, type Decoration } from '../../src/lib/blocksurface/decorations';
import { contentBox } from '../../src/lib/blocksurface/decoration-overlay';

const dec = (
  blockId: string,
  start: number,
  end: number,
  type: Decoration['type'] = 'find-match'
): Decoration => ({ blockId, start, end, type });

describe('DecorationStore', () => {
  it('stores decorations by block and reads them back', () => {
    const store = new DecorationStore();
    store.setType('find-match', [dec('a', 0, 3), dec('a', 5, 8), dec('b', 0, 2)]);
    expect(store.forBlock('a')).toHaveLength(2);
    expect(store.forBlock('b')).toHaveLength(1);
    expect(store.forBlock('c')).toEqual([]);
    expect(store.isEmpty).toBe(false);
    expect([...store.blockIds()].sort()).toEqual(['a', 'b']);
  });

  it('setType replaces only its own type, leaving other types intact', () => {
    const store = new DecorationStore();
    store.setType('find-match', [dec('a', 0, 3)]);
    store.setType('misspelling', [dec('a', 5, 8, 'misspelling')]);
    store.setType('find-match', [dec('a', 10, 13)]); // replaces find-match only

    const a = store.forBlock('a');
    expect(a.filter((d) => d.type === 'find-match').map((d) => d.start)).toEqual([10]);
    expect(a.filter((d) => d.type === 'misspelling').map((d) => d.start)).toEqual([5]);
  });

  it('setType ignores entries whose type does not match', () => {
    const store = new DecorationStore();
    store.setType('find-match', [dec('a', 0, 1, 'misspelling')]);
    expect(store.forBlock('a')).toEqual([]);
    expect(store.isEmpty).toBe(true);
  });

  it('setType notifies the union of blocks that lost the old set and gained the new', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.setType('find-match', [dec('a', 0, 1), dec('b', 0, 1)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(spy.mock.calls[0]![0])).toEqual(new Set(['a', 'b']));

    spy.mockClear();
    // 'a' loses its decoration, 'b' keeps one, 'c' gains one — all three repaint.
    store.setType('find-match', [dec('b', 0, 1), dec('c', 0, 1)]);
    expect(new Set(spy.mock.calls[0]![0])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('setType with an empty change notifies nothing', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.setType('find-match', []); // nothing before, nothing after
    expect(spy).not.toHaveBeenCalled();
  });

  it('clearType removes one type and notifies its blocks, leaving others', () => {
    const store = new DecorationStore();
    store.setType('find-match', [dec('a', 0, 1), dec('b', 0, 1)]);
    store.setType('misspelling', [dec('a', 2, 3, 'misspelling')]);
    const spy = vi.fn();
    store.subscribe(spy);

    store.clearType('find-match');
    expect(store.forBlock('a').map((d) => d.type)).toEqual(['misspelling']);
    expect(store.forBlock('b')).toEqual([]);
    expect(new Set(spy.mock.calls[0]![0])).toEqual(new Set(['a', 'b']));
  });

  it('clear removes everything and notifies every decorated block', () => {
    const store = new DecorationStore();
    store.setType('find-match', [dec('a', 0, 1)]);
    store.setType('misspelling', [dec('b', 0, 1, 'misspelling')]);
    const spy = vi.fn();
    store.subscribe(spy);

    store.clear();
    expect(store.isEmpty).toBe(true);
    expect(new Set(spy.mock.calls[0]![0])).toEqual(new Set(['a', 'b']));

    spy.mockClear();
    store.clear(); // already empty: no notification
    expect(spy).not.toHaveBeenCalled();
  });

  it('add appends a single decoration and notifies its block', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.add(dec('a', 0, 1));
    store.add(dec('a', 3, 4));
    expect(store.forBlock('a')).toHaveLength(2);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([['a'], ['a']]);
  });

  it('invalidate(blockId) notifies only when that block carries a decoration', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    store.subscribe(spy);
    store.setType('find-match', [dec('a', 0, 1)]);
    spy.mockClear();

    store.invalidate('a');
    expect(spy).toHaveBeenCalledWith(['a']);
    spy.mockClear();

    store.invalidate('z'); // no decoration on z — the keystroke-path short-circuit
    expect(spy).not.toHaveBeenCalled();
  });

  it('invalidate(null) reassesses only when something is decorated', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    store.subscribe(spy);

    store.invalidate(null); // empty store: nothing to reassess
    expect(spy).not.toHaveBeenCalled();

    store.setType('find-match', [dec('a', 0, 1)]);
    spy.mockClear();
    store.invalidate(null);
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('stops notifying after unsubscribe', () => {
    const store = new DecorationStore();
    const spy = vi.fn();
    const unsubscribe = store.subscribe(spy);
    unsubscribe();
    store.setType('find-match', [dec('a', 0, 1)]);
    store.invalidate('a');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('contentBox', () => {
  it('maps a viewport rect into the scroller content origin', () => {
    const box = contentBox({ left: 100, top: 200, width: 50, height: 20 }, { left: 80, top: 150 }, 0, 0);
    expect(box).toEqual({ x: 20, y: 50, width: 50, height: 20 });
  });

  it('adds the scroll offset so the box rides the scroll', () => {
    // Scrolled down 300px, the same word sits near the viewport top, yet its
    // content-space y stays large — the box tracks the content, not the viewport.
    const box = contentBox({ left: 100, top: 50, width: 40, height: 18 }, { left: 80, top: 150 }, 12, 300);
    expect(box).toEqual({ x: 32, y: 200, width: 40, height: 18 });
  });
});
