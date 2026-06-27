// Selection mapping (SKR-95, Stage 3a). The bridge between the browser's DOM
// selection and the block model's positions: a position is (block, flat character
// offset within the block). Marks are presentation — a bold span wraps the same
// characters — so they never shift the flat offset; the mapping counts text, not
// structure.
//
// DOM -> offset uses a Range's text length (robust across nested mark spans).
// offset -> DOM walks the block's text nodes. Atomic inlines (img / hard break)
// are rare in prose and refined later; Stage 3a is validated on text.

import { BLOCK_ID_ATTR } from './render';
import type { BlockViewRegistry } from './render';
import { isCollapsed, type DocPos, type DocRange, type LeafAddr } from './doc-position';

/** The top-level block element the caret sits in, or null. Walks up to the first
 *  ancestor whose id is a registered top-level block (nested blocks are not
 *  edit targets in Stage 3a). */
export function focusedBlockElement(
  container: HTMLElement,
  registry: BlockViewRegistry
): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.getRangeAt(0).startContainer;
  while (node && node !== container) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const id = el.getAttribute(BLOCK_ID_ATTR);
      if (id != null && registry.get(id) === el) return el;
    }
    node = node.parentNode;
  }
  return null;
}

/** The nearest block element (top-level OR nested) the caret sits in, found by
 *  walking up to the first ancestor carrying a block id. Unlike
 *  focusedBlockElement this does not require registry membership, so it resolves
 *  a leaf inside a container (a paragraph in a blockquote / list item). */
export function focusedLeafElement(container: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node: Node | null = sel.getRangeAt(0).startContainer;
  while (node && node !== container) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute(BLOCK_ID_ATTR)) {
      return node as HTMLElement;
    }
    node = node.parentNode;
  }
  return null;
}

/** Flat character offset of a DOM point within a block. Counts the text from the
 *  block's start to the point — mark wrappers contribute nothing, so the offset
 *  is stable regardless of how the characters are wrapped. */
export function flatOffsetFromDOM(blockEl: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(blockEl);
  try {
    range.setEnd(node, offset);
  } catch {
    return blockEl.textContent?.length ?? 0;
  }
  return range.toString().length;
}

function textNodesOf(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The DOM point (text node + offset) for a flat offset within a block. Clamps
 *  past-end to the block's last text position. */
export function domPointFromFlatOffset(blockEl: HTMLElement, target: number): { node: Node; offset: number } {
  const texts = textNodesOf(blockEl);
  let acc = 0;
  for (const t of texts) {
    if (acc + t.length >= target) return { node: t, offset: Math.max(0, target - acc) };
    acc += t.length;
  }
  const last = texts[texts.length - 1];
  if (last) return { node: last, offset: last.length };
  return { node: blockEl, offset: 0 };
}

/** Place a collapsed caret at a flat offset within a block.
 *
 *  Uses `selection.collapse` rather than `removeAllRanges()` + `addRange()`. This
 *  matters after a structural rebuild (reconcile replaces the element the caret
 *  was in, so the live selection is left on a detached node): in WKWebView,
 *  `addRange` onto a fresh node in that state can fail to COMMIT — the caret looks
 *  placed, but `getSelection()` still reports the old detached node, so the next
 *  Enter/Backspace resolves no block and is inert until an arrow key forces a real
 *  selection change. `collapse` is the same primitive the typing hot path uses
 *  (which commits reliably across engines), so the structural caret behaves the
 *  same as a typed one. */
export function setCaret(blockEl: HTMLElement, flatOffset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const { node, offset } = domPointFromFlatOffset(blockEl, flatOffset);
  try {
    sel.collapse(node, offset);
  } catch {
    // Fallback for an engine that rejects the point: the range form still places
    // a caret, just without the WKWebView commit guarantee.
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Select the flat range [start, end) within a block. Used after a mark command
 *  re-renders the block, so the user keeps their selection (and the bubble stays). */
export function setSelectionRange(blockEl: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = domPointFromFlatOffset(blockEl, start);
  const b = domPointFromFlatOffset(blockEl, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Select a range that starts in one block and ends in another — the restore
 *  after a mark command applied across a multi-block selection, so the user keeps
 *  the same highlight they acted on. */
export function setCrossBlockSelection(
  startEl: HTMLElement,
  startOffset: number,
  endEl: HTMLElement,
  endOffset: number
): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = domPointFromFlatOffset(startEl, startOffset);
  const b = domPointFromFlatOffset(endEl, endOffset);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

export type CaretContext = {
  blockEl: HTMLElement;
  /** Flat offset of the selection start within the block. */
  start: number;
  /** Flat offset of the selection end; equals `start` when collapsed. */
  end: number;
  collapsed: boolean;
  /** True when the selection's other end is in a different block (a cross-block
   *  selection — Stage 3a leaves those to the browser/Stage 3b). */
  spansBlocks: boolean;
};

/** The caret/selection resolved to the focused block's flat offsets, or null when
 *  the caret is not in an editable top-level block. */
export function caretContext(container: HTMLElement, registry: BlockViewRegistry): CaretContext | null {
  const blockEl = focusedBlockElement(container, registry);
  if (!blockEl) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  return offsetsWithin(blockEl, range);
}

/** Like caretContext, but resolves the nearest leaf block (nested or top-level) —
 *  the editing target for typing, marks, and within-block delete, which work the
 *  same inside a container as at top level. */
export function leafCaretContext(container: HTMLElement): CaretContext | null {
  const blockEl = focusedLeafElement(container);
  if (!blockEl) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return offsetsWithin(blockEl, sel.getRangeAt(0));
}

function offsetsWithin(blockEl: HTMLElement, range: Range): CaretContext {
  const start = flatOffsetFromDOM(blockEl, range.startContainer, range.startOffset);
  const collapsed = range.collapsed;
  const endInBlock = blockEl.contains(range.endContainer);
  const end = collapsed || !endInBlock ? start : flatOffsetFromDOM(blockEl, range.endContainer, range.endOffset);
  return { blockEl, start, end, collapsed, spansBlocks: !endInBlock };
}

// --- the document-wide selection map (SKR-118, Stage 1) ------------------------
//
// The single source of truth for reading and PLACING the selection in terms of
// the document position model (DocPos / DocRange). `writeSelection` replaces the
// ad-hoc "querySelector + setCaret" that followed a structural rebuild and was
// fragile in WKWebView; it is the one place engine quirks are handled and
// instrumented.

/** Resolve a DOM node to the leaf it sits in: a table cell (coordinates) when
 *  inside one, else the nearest block by id. Null when outside any leaf. */
function addrFromNode(container: HTMLElement, node: Node): LeafAddr | null {
  let n: Node | null = node;
  while (n && n !== container) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.dataset.cellRow != null && el.dataset.cellCol != null) {
        const table = el.closest(`[${BLOCK_ID_ATTR}]`);
        const tableId = table?.getAttribute(BLOCK_ID_ATTR);
        if (tableId) return { kind: 'cell', tableId, row: Number(el.dataset.cellRow), col: Number(el.dataset.cellCol) };
      }
      const id = el.getAttribute(BLOCK_ID_ATTR);
      if (id != null) return { kind: 'block', id };
    }
    n = n.parentNode;
  }
  return null;
}

/** The element for a leaf address: the block element, or the cell within its
 *  table. Null when the leaf is not currently rendered. */
export function leafElement(container: HTMLElement, addr: LeafAddr): HTMLElement | null {
  if (addr.kind === 'block') {
    return container.querySelector(`[${BLOCK_ID_ATTR}="${addr.id}"]`) as HTMLElement | null;
  }
  const table = container.querySelector(`[${BLOCK_ID_ATTR}="${addr.tableId}"]`);
  return (table?.querySelector(`[data-cell-row="${addr.row}"][data-cell-col="${addr.col}"]`) as HTMLElement | null) ?? null;
}

/** Read the current browser selection as a DocRange, or null when it is outside
 *  the surface. anchor = range start, focus = range end (document order). */
export function readSelection(container: HTMLElement): DocRange | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const startAddr = addrFromNode(container, range.startContainer);
  if (!startAddr) return null;
  const startEl = leafElement(container, startAddr);
  if (!startEl) return null;
  const anchor: DocPos = { leaf: startAddr, offset: flatOffsetFromDOM(startEl, range.startContainer, range.startOffset) };

  if (range.collapsed) return { anchor, focus: anchor };
  const endAddr = addrFromNode(container, range.endContainer);
  const endEl = endAddr ? leafElement(container, endAddr) : null;
  if (!endAddr || !endEl) return { anchor, focus: anchor };
  const focus: DocPos = { leaf: endAddr, offset: flatOffsetFromDOM(endEl, range.endContainer, range.endOffset) };
  return { anchor, focus };
}

let caretDebug: boolean | null = null;
function caretLogging(): boolean {
  // Cached read of an opt-in flag set in the console for in-shell diagnosis:
  //   window.__skriveCaretDebug = true
  if (caretDebug == null) {
    caretDebug = (globalThis as { __skriveCaretDebug?: boolean }).__skriveCaretDebug === true;
  }
  return caretDebug || (globalThis as { __skriveCaretDebug?: boolean }).__skriveCaretDebug === true;
}
function caretLog(label: string, phase: string, node: Node, offset: number): void {
  if (!caretLogging()) return;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const block = el?.closest(`[${BLOCK_ID_ATTR}]`);
  // eslint-disable-next-line no-console
  console.debug('[skrive caret]', label, phase, {
    offset,
    text: (node.textContent ?? '').slice(0, 16),
    block: block?.getAttribute(BLOCK_ID_ATTR) ?? null,
    connected: (node as ChildNode).isConnected
  });
}

function applyCaretPoint(sel: Selection, node: Node, offset: number): void {
  try {
    sel.collapse(node, offset);
  } catch {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Place a collapsed caret robustly after a structural rebuild. The sync
 *  placement is re-asserted once on the next frame: WKWebView can leave a
 *  selection set right after the surrounding DOM was replaced UNCOMMITTED (the
 *  caret looks placed but the next keystroke still resolves the old, now-detached
 *  node — inert until an arrow key). The re-assert lands once layout has settled.
 *  It never fights a deliberate move: if the selection already sits on the target,
 *  or the user moved it to another live node, the re-assert is skipped. */
function placeCaretRobust(node: Node, offset: number, label: string): void {
  const sel = window.getSelection();
  if (!sel) return;
  applyCaretPoint(sel, node, offset);
  caretLog(label, 'sync', node, offset);
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    const s = window.getSelection();
    if (!s) return;
    if (s.anchorNode === node) {
      caretLog(label, 'committed', node, offset);
      return;
    }
    if (s.anchorNode && s.anchorNode.isConnected) {
      caretLog(label, 'user-moved', s.anchorNode, s.anchorOffset);
      return; // a live, different node = a deliberate move; don't fight it
    }
    applyCaretPoint(s, node, offset); // old anchor was detached / never committed
    caretLog(label, 're-assert', node, offset);
  });
}

/** Place the browser selection from a DocRange (the write half of the map). Used
 *  after a structural transform + reconcile, so it goes through the robust caret
 *  placement. `label` tags the instrumentation. */
export function writeSelection(container: HTMLElement, range: DocRange, label = 'writeSelection'): void {
  const anchorEl = leafElement(container, range.anchor.leaf);
  if (!anchorEl) return;
  const a = domPointFromFlatOffset(anchorEl, range.anchor.offset);

  if (isCollapsed(range)) {
    placeCaretRobust(a.node, a.offset, label);
    return;
  }
  const focusEl = leafElement(container, range.focus.leaf);
  if (!focusEl) {
    placeCaretRobust(a.node, a.offset, label);
    return;
  }
  const b = domPointFromFlatOffset(focusEl, range.focus.offset);
  const sel = window.getSelection();
  if (!sel) return;
  sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
}
