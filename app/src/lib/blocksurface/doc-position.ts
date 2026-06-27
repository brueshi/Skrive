// Document-wide position model (SKR-118, Stage 1). A position is a LEAF (an
// editable text block — paragraph / heading / code_block — or a table cell) plus
// a flat character offset within it. This is the addressing the range-operation
// layer (Stage 2+) splices along, and the currency of the selection map
// (readSelection / writeSelection in selection.ts).
//
// Pure: no DOM, no block-model import. Leaf identity is enough here — the DOM
// resolution and the document-order walk live with their consumers.

/** A leaf the caret can sit in: a block (by stable id) or a table cell (by
 *  table id + grid coordinates, since cells carry coordinates, not block ids). */
export type LeafAddr =
  | { kind: 'block'; id: string }
  | { kind: 'cell'; tableId: string; row: number; col: number };

/** A point in the document: a leaf and a flat offset within it. */
export type DocPos = { leaf: LeafAddr; offset: number };

/** A selection as anchor → focus. anchor may sit after focus (a backward drag);
 *  the range transforms normalize to document order before splicing. */
export type DocRange = { anchor: DocPos; focus: DocPos };

export function sameLeaf(a: LeafAddr, b: LeafAddr): boolean {
  if (a.kind === 'block' && b.kind === 'block') return a.id === b.id;
  if (a.kind === 'cell' && b.kind === 'cell') {
    return a.tableId === b.tableId && a.row === b.row && a.col === b.col;
  }
  return false;
}

export function samePos(a: DocPos, b: DocPos): boolean {
  return sameLeaf(a.leaf, b.leaf) && a.offset === b.offset;
}

export function collapsedRange(pos: DocPos): DocRange {
  return { anchor: pos, focus: pos };
}

export function isCollapsed(r: DocRange): boolean {
  return samePos(r.anchor, r.focus);
}
