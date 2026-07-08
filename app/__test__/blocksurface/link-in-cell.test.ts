// @vitest-environment jsdom
//
// Links in table cells (SKR-221). The Link button rendered enabled in a cell but
// beginLink resolved via leafTarget only, so it silently no-oped. Links are peers
// of the mark commands, which already work in cells via the cell-coordinate paths;
// beginLink/applySavedLink now carry a cell variant too.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { parseDocument, type BlockNode, type InlineNode } from '../../src/lib/blockmodel';

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 1, height: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => container.remove());

const TABLE = '| a | b |\n| - | - |\n| c | d |\n';

function tableBlock(surface: BlockSurface): Extract<BlockNode, { type: 'table' }> {
  const b = surface.getDocument().blocks.find((x): x is Extract<BlockNode, { type: 'table' }> => x.type === 'table');
  if (!b) throw new Error('no table');
  return b;
}
function selectText(node: Node, start: number, end: number): void {
  window.getSelection()!.setBaseAndExtent(node, start, node, end);
}

describe('links in table cells (SKR-221)', () => {
  it('applies a link over a cell range (was a silent no-op)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(TABLE) });
    const bodyCell = container.querySelector('td')!; // first body cell = "c"
    selectText(bodyCell.firstChild!, 0, 1);

    expect(surface.beginLink()).toBe(true); // used to resolve the table, not the cell
    surface.commitLink('https://x.test');

    const cellInline: InlineNode[] = tableBlock(surface).rows[1]![0]!;
    expect(cellInline[0]).toMatchObject({ kind: 'text', text: 'c', marks: { link: { href: 'https://x.test' } } });
  });

  it('removes a link from a cell', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(TABLE) });
    const bodyCell = container.querySelector('td')!;
    selectText(bodyCell.firstChild!, 0, 1);
    surface.beginLink();
    surface.commitLink('https://x.test');

    // Re-select the (now linked) cell text and remove.
    const relinked = container.querySelector('td')!;
    selectText(relinked.firstChild!, 0, 1);
    surface.beginLink();
    surface.removeLink();

    const cellInline: InlineNode[] = tableBlock(surface).rows[1]![0]!;
    expect(cellInline[0]!.marks.link).toBeFalsy();
  });

  it('reports the link a collapsed caret sits inside a cell (for the Link control)', () => {
    const surface = new BlockSurface({ container, doc: parseDocument(TABLE) });
    const bodyCell = container.querySelector('td')!;
    selectText(bodyCell.firstChild!, 0, 1);
    surface.beginLink();
    surface.commitLink('https://x.test');

    // Collapse the caret inside the linked cell text and read the summary.
    const linked = container.querySelector('td')!;
    window.getSelection()!.collapse(linked.firstChild!, 1);
    const info = surface.getSelectionInfo();
    expect(info?.marks.link).toBe(true);
    expect(info?.linkHref).toBe('https://x.test');
    expect(surface.beginLink()).toBe(true); // editable from a bare caret in the cell
  });
});
