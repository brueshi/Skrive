// @vitest-environment jsdom
//
// Copy-out slice fidelity (SKR-157 / F32, F33, F35). serializeSelectionMarkdown
// is pure over the document and the selected DocRange (no DOM selection), so the
// surface is built in jsdom only to hold the document, and the method is driven
// directly with hand-built ranges. The bugs: barriers outside the selection
// leaked onto the clipboard, and the endpoints were stamped with the document's
// first/last block type.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import type { DocPos, DocRange } from '../../src/lib/blocksurface/doc-position';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function surfaceFor(md: string): BlockSurface {
  return new BlockSurface({ container, doc: parseDocument(md) });
}
function plain(b: BlockNode): string {
  if (b.type !== 'paragraph' && b.type !== 'heading') return '';
  return b.inline.map((n) => (n.kind === 'text' ? n.text : '')).join('');
}
function idByText(surface: BlockSurface, text: string): string {
  const b = surface.getDocument().blocks.find((x) => plain(x) === text);
  if (!b) throw new Error(`block not found: ${text}`);
  return b.id;
}
const pos = (id: string, offset: number): DocPos => ({ leaf: { kind: 'block', id }, offset });
function sliceMd(surface: BlockSurface, range: DocRange): string | null {
  return (surface as unknown as { serializeSelectionMarkdown(r: DocRange): string | null }).serializeSelectionMarkdown(range);
}

describe('serializeSelectionMarkdown — barrier leak (F32)', () => {
  it('does not include a code block that sits after the selection', () => {
    const s = surfaceFor('AAAA\n\nBBBB\n\n```\ncode\n```\n');
    const range = { anchor: pos(idByText(s, 'AAAA'), 1), focus: pos(idByText(s, 'BBBB'), 3) };
    const md = sliceMd(s, range);
    expect(md).toBe('AAA\n\nBBB');
    expect(md).not.toContain('```');
    expect(md).not.toContain('code');
  });

  it('does not include a code block that sits before the selection', () => {
    const s = surfaceFor('```\ncode\n```\n\nAAAA\n\nBBBB\n');
    const range = { anchor: pos(idByText(s, 'AAAA'), 0), focus: pos(idByText(s, 'BBBB'), 2) };
    const md = sliceMd(s, range);
    expect(md).toBe('AAAA\n\nBB');
    expect(md).not.toContain('```');
  });
});

describe('serializeSelectionMarkdown — endpoint type stamping (F33)', () => {
  it('keeps the selected paragraphs plain when the document starts with a heading', () => {
    const s = surfaceFor('# Title\n\nAAAA\n\nBBBB\n');
    const range = { anchor: pos(idByText(s, 'AAAA'), 0), focus: pos(idByText(s, 'BBBB'), 4) };
    const md = sliceMd(s, range);
    expect(md).toBe('AAAA\n\nBBBB');
    expect(md).not.toContain('#');
  });
});

describe('serializeSelectionMarkdown — whole vs partial block (F35)', () => {
  it('keeps the block type when the whole heading is selected', () => {
    const s = surfaceFor('# Title\n');
    const id = idByText(s, 'Title');
    const md = sliceMd(s, { anchor: pos(id, 0), focus: pos(id, 5) });
    expect(md).toBe('# Title');
  });

  it('strips to plain text for a partial heading selection', () => {
    const s = surfaceFor('# Title\n');
    const id = idByText(s, 'Title');
    // Select just "Title" (offsets 0..5 is the whole inline; pick a sub-slice).
    const md = sliceMd(s, { anchor: pos(id, 0), focus: pos(id, 3) });
    expect(md).toBe('Tit');
    expect(md).not.toContain('#');
  });
});
