// @vitest-environment jsdom
//
// Spellcheck is ON and its corrections land in the model (SKR-191). The audit's
// F80 trap: `insertReplacementText` was swallowed by the beforeinput catch-all,
// so enabling spellcheck naively produced squiggles whose corrections silently
// did nothing. These specs pin the three halves: the surface enables spellcheck
// (code opts out at render time), and applyReplacementText maps a target range
// onto the inline primitives — for a top-level leaf, a nested leaf, and a table
// cell — while refusing a range it cannot resolve.
//
// jsdom implements neither StaticRange nor InputEvent.getTargetRanges, so the
// replacement specs drive the handler directly with a range-shaped literal (the
// same private-call pattern as the surgical-delete specs); the real event path
// is one added beforeinput branch, and the shell sitting verifies it end to end.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { renderBlock } from '../../src/lib/blocksurface/render';
import { parseDocument, serializeDocument } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

type ReplacementSurface = {
  applyReplacementText(e: {
    data: string | null;
    getTargetRanges(): Array<{
      startContainer: Node;
      startOffset: number;
      endContainer: Node;
      endOffset: number;
    }>;
  }): void;
};

const replace = (surface: BlockSurface, data: string, node: Node, start: number, end: number): void => {
  (surface as unknown as ReplacementSurface).applyReplacementText({
    data,
    getTargetRanges: () => [{ startContainer: node, startOffset: start, endContainer: node, endOffset: end }]
  });
};

describe('spellcheck posture', () => {
  it('the surface enables spellcheck', () => {
    new BlockSurface({ container, doc: parseDocument('hello\n') });
    expect(container.spellcheck).toBe(true);
  });

  it('code blocks and inline code opt out', () => {
    const doc = parseDocument('```\ncode\n```\n');
    expect(renderBlock(doc.blocks[0]!).getAttribute('spellcheck')).toBe('false');
    const inline = parseDocument('a `span` here\n');
    const p = renderBlock(inline.blocks[0]!);
    expect(p.querySelector('code')?.getAttribute('spellcheck')).toBe('false');
  });
});

describe('applyReplacementText', () => {
  it('replaces the target word in a top-level paragraph', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('teh quick fox\n') });
    const tn = container.querySelector('p')!.firstChild!;
    replace(surface, 'the', tn, 0, 3);
    expect(serializeDocument(surface.getDocument())).toBe('the quick fox\n');
    // The DOM was re-rendered in place to match.
    expect(container.querySelector('p')!.textContent).toBe('the quick fox');
  });

  it('replaces inside a nested leaf and dirties its container', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('> teh word\n') });
    const tn = container.querySelector('blockquote p')!.firstChild!;
    replace(surface, 'the', tn, 0, 3);
    expect(serializeDocument(surface.getDocument())).toBe('> the word\n');
  });

  it('replaces inside a table cell by coordinates', () => {
    const surface = new BlockSurface({
      container,
      doc: parseDocument('| head |\n| --- |\n| teh cell |\n')
    });
    const td = container.querySelector('td')!;
    replace(surface, 'the', td.firstChild!, 0, 3);
    const table = surface.getDocument().blocks[0]!;
    if (table.type !== 'table') throw new Error('expected a table');
    const cell = table.rows[1]![0]!;
    expect(cell[0]?.kind === 'text' && cell[0].text).toBe('the cell');
    expect(td.textContent).toBe('the cell');
  });

  it('refuses a range that crosses out of the leaf, leaving the model untouched', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('one\n\ntwo\n') });
    const before = serializeDocument(surface.getDocument());
    const ps = container.querySelectorAll('p');
    (surface as unknown as ReplacementSurface).applyReplacementText({
      data: 'x',
      getTargetRanges: () => [
        { startContainer: ps[0]!.firstChild!, startOffset: 0, endContainer: ps[1]!.firstChild!, endOffset: 3 }
      ]
    });
    expect(serializeDocument(surface.getDocument())).toBe(before);
  });
});
