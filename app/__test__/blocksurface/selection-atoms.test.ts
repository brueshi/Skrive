// @vitest-environment jsdom
//
// The DOM<->offset mapping with atoms (SKR-155). flatOffsetFromDOM and
// domPointFromFlatOffset must count an inline image / real hard break as one unit
// each — matching the model in inline-ops.ts — while the placeholder <br> an empty
// block carries stays zero-width. The Chromium harness exercises this only
// indirectly (and barely for breaks, since Shift+Enter isn't built yet), so these
// pin the arithmetic directly.

import { describe, it, expect } from 'vitest';
import { flatOffsetFromDOM, domPointFromFlatOffset } from '../../src/lib/blocksurface/selection';
import { HARD_BREAK_ATTR } from '../../src/lib/blocksurface/render';

function block(...children: Node[]): HTMLElement {
  const p = document.createElement('p');
  for (const c of children) p.appendChild(c);
  return p;
}
const t = (s: string): Text => document.createTextNode(s);
const img = (): HTMLElement => document.createElement('img');
function hardBreak(): HTMLElement {
  const br = document.createElement('br');
  br.setAttribute(HARD_BREAK_ATTR, '');
  return br;
}
function strong(child: Node): HTMLElement {
  const el = document.createElement('strong');
  el.appendChild(child);
  return el;
}

describe('flatOffsetFromDOM with atoms', () => {
  it('counts an image as one unit', () => {
    const b = block(t('a'), img(), t('bc'));
    // Caret one char into "bc": a(1) + img(1) + 1 = 3.
    expect(flatOffsetFromDOM(b, b.childNodes[2]!, 1)).toBe(3);
  });

  it('counts a real hard break as one unit', () => {
    const b = block(t('a'), hardBreak(), t('b'));
    // Caret at the start of "b" (just after the break): a(1) + br(1) = 2.
    expect(flatOffsetFromDOM(b, b.childNodes[2]!, 0)).toBe(2);
  });

  it('measures an element-boundary point by summing the children before it', () => {
    const b = block(t('a'), img(), t('bc'));
    // Point (block, 2) = before "bc", after the image: a(1) + img(1) = 2.
    expect(flatOffsetFromDOM(b, b, 2)).toBe(2);
  });

  it('counts an atom wrapped in a mark', () => {
    const b = block(t('a'), strong(hardBreak()), t('b'));
    expect(flatOffsetFromDOM(b, b.childNodes[2]!, 0)).toBe(2);
  });

  it('treats the empty-block placeholder <br> as zero width', () => {
    const b = block(document.createElement('br')); // unmarked placeholder
    expect(flatOffsetFromDOM(b, b, 0)).toBe(0);
  });

  it('matches pure text length when there are no atoms', () => {
    const b = block(t('hello'));
    expect(flatOffsetFromDOM(b, b.childNodes[0]!, 3)).toBe(3);
  });
});

describe('domPointFromFlatOffset with atoms', () => {
  it('lands the caret just before an image at the block start', () => {
    const b = block(img(), t('b'));
    const p = domPointFromFlatOffset(b, 0);
    expect(p.node).toBe(b);
    expect(p.offset).toBe(0); // before the image element
  });

  it('lands the caret in the text run following an atom', () => {
    const b = block(t('a'), img(), t('bc'));
    // Image occupies offset [1,2), so offset 2 is its trailing edge = start of "bc".
    const p = domPointFromFlatOffset(b, 2);
    expect(p.node).toBe(b.childNodes[2]); // the "bc" text node
    expect(p.offset).toBe(0);
  });

  it('clamps past the end to the last position', () => {
    const b = block(t('a'), img());
    const p = domPointFromFlatOffset(b, 99);
    // After the image, expressed against its parent.
    expect(p.node).toBe(b);
    expect(p.offset).toBe(2);
  });

  it('round-trips with flatOffsetFromDOM across an atom', () => {
    const b = block(t('ab'), img(), t('cd'));
    for (let off = 0; off <= 5; off++) {
      const p = domPointFromFlatOffset(b, off);
      expect(flatOffsetFromDOM(b, p.node, p.offset)).toBe(off);
    }
  });
});
