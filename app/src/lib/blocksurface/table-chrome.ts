// The table hover chrome, adapted to this surface. The painter and its
// geometry live in the table-surface lab; this module builds the chrome host
// from the block surface's existing methods, so the editor's attach call, the
// block chrome, the index, and the tests keep their import site. Addressing
// is by block id; every mutation arrives as an intent and lands through the
// surface's own methods, which place the caret and manage history exactly as
// before.

import {
  attachTableChrome as attachSurfaceChrome,
  type TableChromeHandle,
  type TableIntent
} from '@skrive/table-surface';
import { BLOCK_ID_ATTR } from './render';
import type { BlockSurface } from './surface';

export {
  GUTTER_METRICS,
  dropIndicatorRect,
  hoverZone,
  measureTable,
  nearestBoundary,
  normalizeWidths,
  resizeColumnWidths,
  tableGutterSlots,
  tableHandleSlot,
  tableResizeSlots,
  zoneContains
} from '@skrive/table-surface';
export type {
  DropIndicator,
  GutterMetrics,
  GutterSlot,
  HoverCell,
  HoverZone,
  TableChromeHandle,
  TableGeometry
} from '@skrive/table-surface';

export type TableChromeOptions = {
  /** The contenteditable host (.block-editor-surface) holding the tables. */
  surface: HTMLElement;
  /** The scrolling container (.block-editor-body). */
  scroller: HTMLElement;
  /** The layer element (.block-table-chrome-layer), a sibling of the surface. */
  layer: HTMLElement;
  /** The surface the affordances act on. */
  blockSurface: BlockSurface;
};

/** Wire table hover chrome to a surface. destroy() removes every listener and slot. */
export function attachTableChrome({ surface, scroller, layer, blockSurface }: TableChromeOptions): TableChromeHandle {
  const apply = (tableId: string, intent: TableIntent<never>): void => {
    switch (intent.type) {
      case 'insert-column':
        blockSurface.insertTableColumnAt(tableId, intent.index, 0);
        break;
      case 'insert-row':
        blockSurface.insertTableRowAt(tableId, intent.index, 0);
        break;
      case 'move-column':
        blockSurface.moveTableColumnAt(tableId, intent.from, intent.to);
        break;
      case 'move-row':
        blockSurface.moveTableRowAt(tableId, intent.from, intent.to);
        break;
      case 'set-widths':
        blockSurface.setTableColumnWidths(tableId, [...intent.widths]);
        break;
      default:
        // The chrome raises none of the others; the menu and keys own them.
        break;
    }
  };
  return attachSurfaceChrome({
    surface,
    scroller,
    layer,
    tableIdOf: (table) => table.getAttribute(BLOCK_ID_ATTR),
    findTable: (tableId) => surface.querySelector<HTMLTableElement>(`table[${BLOCK_ID_ATTR}="${tableId}"]`),
    getSelection: () => blockSurface.getTableSelection(),
    onSelectionChange: (fn) => blockSurface.onTableSelectionChange(fn),
    onStructureChange: (fn) => blockSurface.onStructureChange(fn),
    apply,
    requestMenu: (tableId, target, anchor) => blockSurface.openTableMenu(tableId, target.kind, target.index, anchor),
    clearCaret: () => blockSurface.clearCaret()
  });
}
