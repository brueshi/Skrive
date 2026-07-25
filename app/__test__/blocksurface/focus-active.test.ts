// @vitest-environment jsdom
//
// Focus mode's active-block marker. What matters here is the resolution rule —
// a caret anywhere inside a nested block lights the TOP-LEVEL block, because
// opacity compounds and a dimmed list can't host an undimmed item — plus the
// two signals it repaints on and the fact that it leaves no class behind.

import { beforeEach, describe, expect, it } from 'vitest';
import { attachFocusActive } from '../../src/lib/blocksurface/focus-active';
import type { BlockSurface } from '../../src/lib/blocksurface/surface';

/** A surface stub exposing just the structural-change signal the painter uses,
 *  plus a hook to fire it. */
function stubSurface(): {
  surface: BlockSurface;
  fireStructureChange: () => void;
  listenerCount: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    surface: {
      onStructureChange(fn: () => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    } as unknown as BlockSurface,
    fireStructureChange: () => {
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size
  };
}

/** Let the painter's rAF coalescing land. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function caretIn(node: Node): void {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  host.className = 'block-editor-surface';
  host.innerHTML = `
    <p data-block-id="p1">first</p>
    <ul data-block-id="l1"><li data-block-id="li1"><p data-block-id="lp1">item</p></li></ul>
    <p data-block-id="p2">last</p>
  `;
  document.body.appendChild(host);
});

const active = (): string | null =>
  host.querySelector('.is-focus-active')?.getAttribute('data-block-id') ?? null;

describe('attachFocusActive', () => {
  it('marks the top-level block holding the caret', async () => {
    const { surface } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    caretIn(host.querySelector('[data-block-id="p1"]')!.firstChild!);
    await nextFrame();
    expect(active()).toBe('p1');

    handle.destroy();
  });

  it('resolves a caret nested in a list to the list, not the item', async () => {
    const { surface } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    caretIn(host.querySelector('[data-block-id="lp1"]')!.firstChild!);
    await nextFrame();
    expect(active()).toBe('l1');

    handle.destroy();
  });

  it('moves the mark as the caret moves, leaving exactly one lit block', async () => {
    const { surface } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    caretIn(host.querySelector('[data-block-id="p1"]')!.firstChild!);
    await nextFrame();
    caretIn(host.querySelector('[data-block-id="p2"]')!.firstChild!);
    await nextFrame();

    expect(host.querySelectorAll('.is-focus-active')).toHaveLength(1);
    expect(active()).toBe('p2');

    handle.destroy();
  });

  it('re-paints after a reconcile replaces the block element', async () => {
    const { surface, fireStructureChange } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    const p2 = host.querySelector('[data-block-id="p2"]')!;
    caretIn(p2.firstChild!);
    await nextFrame();
    expect(active()).toBe('p2');

    // A reconcile builds a fresh element for the same block; the class dies with
    // the element it was painted on, and the caret is inside the replacement.
    const replacement = document.createElement('p');
    replacement.setAttribute('data-block-id', 'p2');
    replacement.textContent = 'last';
    p2.replaceWith(replacement);
    caretIn(replacement.firstChild!);
    fireStructureChange();
    await nextFrame();

    expect(active()).toBe('p2');
    expect(host.querySelectorAll('.is-focus-active')).toHaveLength(1);

    handle.destroy();
  });

  it('marks nothing while the selection is outside the surface', async () => {
    const outside = document.createElement('p');
    outside.textContent = 'chrome';
    document.body.appendChild(outside);
    const { surface } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    caretIn(host.querySelector('[data-block-id="p1"]')!.firstChild!);
    await nextFrame();
    caretIn(outside.firstChild!);
    await nextFrame();

    expect(active()).toBeNull();

    handle.destroy();
  });

  it('leaves no class and no listeners behind on destroy', async () => {
    const { surface, listenerCount } = stubSurface();
    const handle = attachFocusActive({ surface: host, blockSurface: surface });

    caretIn(host.querySelector('[data-block-id="p1"]')!.firstChild!);
    await nextFrame();
    expect(active()).toBe('p1');

    handle.destroy();
    expect(active()).toBeNull();
    expect(listenerCount()).toBe(0);

    // A selection change after teardown must not repaint.
    caretIn(host.querySelector('[data-block-id="p2"]')!.firstChild!);
    await nextFrame();
    expect(active()).toBeNull();
  });
});
