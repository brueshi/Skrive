// @vitest-environment jsdom
//
// IME composition readback for code blocks and table cells (SKR-156 / F82).
// onCompositionEnd must pull the natively-composed DOM text back into the model
// for EVERY editable leaf; before the fix it bailed on anything that wasn't an
// inline-text block, so composed text in a code block or cell lived only in the
// DOM and was lost on the next serialize. This drives the readback directly by
// mutating the DOM (as an IME would) and placing the selection, then invoking the
// handler — jsdom models enough Selection for focusedLeafElement/cellTarget.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => container.remove());

function compositionEnd(surface: BlockSurface): void {
  (surface as unknown as { onCompositionEnd: () => void }).onCompositionEnd();
}
function place(node: Node, offset: number): void {
  const sel = window.getSelection();
  sel?.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel?.addRange(range);
}

describe('onCompositionEnd — code block', () => {
  it('reads natively-composed text into the code block model', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('```\nx\n```\n') });
    const codeEl = container.querySelector('code')!;
    // Simulate the IME having replaced the DOM text mid-composition.
    codeEl.textContent = 'x日本語';
    place(codeEl.firstChild!, codeEl.firstChild!.textContent!.length);

    compositionEnd(surface);

    const block = surface.getDocument().blocks[0] as Extract<BlockNode, { type: 'code_block' }>;
    expect(block.type).toBe('code_block');
    expect(block.text).toBe('x日本語');
    expect(block.dirty).toBe(true);
  });
});

describe('onCompositionEnd — table cell', () => {
  it('reads natively-composed text into the addressed cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument('| a | b |\n| - | - |\n| 1 | 2 |\n') });
    // The first body cell (row 1, col 0) holds "1"; compose into it.
    const cell = container.querySelector('[data-cell-row="1"][data-cell-col="0"]') as HTMLElement;
    expect(cell, 'cell rendered').toBeTruthy();
    cell.textContent = '中文';
    place(cell.firstChild!, cell.firstChild!.textContent!.length);

    compositionEnd(surface);

    const table = surface.getDocument().blocks.find((b) => b.type === 'table') as Extract<BlockNode, { type: 'table' }>;
    const composed = table.rows[1]![0]!.map((n) => (n.kind === 'text' ? n.text : '')).join('');
    expect(composed).toBe('中文');
    expect(table.dirty).toBe(true);
  });
});
