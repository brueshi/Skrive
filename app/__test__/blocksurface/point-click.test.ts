// @vitest-environment jsdom
//
// Click placement for points with no native caret (SKR-192, extending PR #62's
// below-last affordance / F57): the host's side padding, inter-block gaps, and
// the scroller gutters route to the block vertically nearest the point. jsdom
// has no layout, so block rects are stubbed per element; caretRangeFromPoint is
// absent in jsdom, which exercises the nearest-edge fallback (the precise
// hit-test half is shell-verified).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { readSelection } from '../../src/lib/blocksurface/selection';
import { parseDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function stubRect(el: Element, top: number, bottom: number, left = 100, right = 500): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** Two paragraphs at y [0,20] and [40,60], with a 20px gap between them. */
function twoParagraphSurface(): BlockSurface {
  const surface = new BlockSurface({ container, doc: parseDocument('alpha\n\nbeta\n') });
  const [p1, p2] = Array.from(container.querySelectorAll('p'));
  stubRect(p1!, 0, 20);
  stubRect(p2!, 40, 60);
  return surface;
}

function caretBlockText(): { text: string; offset: number } | null {
  const range = readSelection(container);
  if (!range || range.anchor.leaf.kind !== 'block') return null;
  const el = container.querySelector(`[data-block-id="${range.anchor.leaf.id}"]`);
  return { text: el?.textContent ?? '', offset: range.anchor.offset };
}

describe('placeCaretNearPoint', () => {
  it('a gap click goes to the nearer block above, at its end', () => {
    const surface = twoParagraphSurface();
    surface.placeCaretNearPoint(300, 25); // 5px below alpha, 15px above beta

    expect(caretBlockText()).toEqual({ text: 'alpha', offset: 5 });
  });

  it('a gap click goes to the nearer block below, at its start', () => {
    const surface = twoParagraphSurface();
    surface.placeCaretNearPoint(300, 37); // 3px above beta

    expect(caretBlockText()).toEqual({ text: 'beta', offset: 0 });
  });

  it('a side-gutter click lands in the block at that height', () => {
    const surface = twoParagraphSurface();
    surface.placeCaretNearPoint(20, 10); // left of alpha, vertically inside it
    // No caretRangeFromPoint in jsdom: the fallback picks the block edge by the
    // point's side of the vertical middle. y=10 is the exact middle -> end.
    expect(caretBlockText()).toEqual({ text: 'alpha', offset: 5 });

    surface.placeCaretNearPoint(20, 3); // upper half -> start
    expect(caretBlockText()).toEqual({ text: 'alpha', offset: 0 });
  });

  it('below the last block, a trailing inline block takes the caret at its end (F57)', () => {
    const surface = twoParagraphSurface();
    surface.placeCaretNearPoint(300, 200);

    expect(caretBlockText()).toEqual({ text: 'beta', offset: 4 });
  });

  it('below the last block, a trailing barrier seeds a fresh paragraph (F57)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('alpha\n\n```\ncode\n```\n') });
    const blocks = container.querySelectorAll('[data-block-id]');
    stubRect(blocks[0]!, 0, 20);
    stubRect(blocks[1]!, 40, 80);

    surface.placeCaretNearPoint(300, 200);

    const doc = surface.getDocument();
    const last = doc.blocks[doc.blocks.length - 1]!;
    expect(last.type).toBe('paragraph');
    const range = readSelection(container);
    expect(range?.anchor.leaf.kind === 'block' ? range.anchor.leaf.id : null).toBe(last.id);
  });

  it('a surface click outside any block routes through the click handler', () => {
    twoParagraphSurface();
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 37 }));

    expect(caretBlockText()).toEqual({ text: 'beta', offset: 0 });
  });
});
