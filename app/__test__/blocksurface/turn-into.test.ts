// @vitest-environment jsdom
//
// Turn-into from a code block (SKR-168 / F45). setBlockType used to require an
// inline-text block, so with the caret in a code block every "Turn into ..."
// silently no-opped. It now accepts a code block, flowing its text into a single
// paragraph (newlines -> spaces). Driven directly in jsdom: place the caret in the
// code block, invoke setBlockType, assert the model converted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, serializeDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function placeInCode(container: HTMLElement): void {
  const code = container.querySelector('code');
  const node = code?.firstChild ?? code ?? container;
  const sel = window.getSelection();
  sel?.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  sel?.addRange(range);
}
function setType(surface: BlockSurface, spec: unknown): void {
  (surface as unknown as { setBlockType(s: unknown): void }).setBlockType(spec);
}

describe('setBlockType from a code block (F45)', () => {
  it('turns a multi-line code block into one flowed paragraph', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\na\nb\n```\n') });
    placeInCode(container);

    setType(surface, { kind: 'paragraph' });

    const block = surface.getDocument().blocks[0]!;
    expect(block.type).toBe('paragraph');
    // Newlines flowed to spaces.
    expect((block as Extract<BlockNode, { type: 'paragraph' }>).inline.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('a b');
    expect(serializeDocument(surface.getDocument())).toContain('a b');
    expect(serializeDocument(surface.getDocument())).not.toContain('```');
  });

  it('turns a code block into a heading', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nhello\n```\n') });
    placeInCode(container);

    setType(surface, { kind: 'heading', level: 2 });

    const block = surface.getDocument().blocks[0]!;
    expect(block.type).toBe('heading');
    expect(serializeDocument(surface.getDocument())).toContain('## hello');
  });

  it('keeps the id and preserves the surrounding document', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('before\n\n```\ncode\n```\n\nafter\n') });
    const codeId = surface.getDocument().blocks[1]!.id;
    // Place the caret in the (second) code block.
    const code = container.querySelectorAll('code')[0] as HTMLElement;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const range = document.createRange();
    range.setStart(code.firstChild ?? code, 0);
    range.collapse(true);
    sel?.addRange(range);

    setType(surface, { kind: 'paragraph' });

    const blocks = surface.getDocument().blocks;
    expect(blocks[1]!.id).toBe(codeId); // id preserved across the conversion
    expect(blocks[1]!.type).toBe('paragraph');
    const md = serializeDocument(surface.getDocument());
    expect(md).toContain('before');
    expect(md).toContain('after');
    expect(md).toContain('code');
  });
});
