// Selection mapping (SKR-95, Stage 3a). The bridge between the browser's DOM
// selection and the block model's positions: a position is (block, flat character
// offset within the block). Marks are presentation — a bold span wraps the same
// characters — so they never shift the flat offset; the mapping counts text, not
// structure.
//
// DOM <-> offset both count atoms as one unit (SKR-155), matching the model in
// inline-ops.ts so a DOM-derived offset and a model offset are the same number.
// DOM -> offset walks to the boundary summing text characters plus one per atom;
// offset -> DOM walks leaves (text nodes + atoms) to the target. A real hard-break
// atom is tagged HARD_BREAK_ATTR so it is distinguished from the bare <br> an empty
// block carries for height (that placeholder is zero-width, like the empty model).

import { BLOCK_ID_ATTR, CARET_FILLER, CHROME_ATTR, HARD_BREAK_ATTR, TAG_CLASS } from './render';
import type { BlockViewRegistry } from './render';
import { isCollapsed, type DocPos, type DocRange, type LeafAddr } from './doc-position';

/** The zero-width caret filler renderInline puts on the empty line a trailing hard
 *  break opens (SKR-176): a real text node so WKWebView can paint the caret, but
 *  zero-width to the offset map. Its own isolated node, so an exact match is safe. */
function isFillerText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && (node as Text).data === CARET_FILLER;
}

/** An inline atom in the DOM: an image, or a real hard break (not the placeholder
 *  <br> an empty block carries). Each occupies one unit of offset space. */
function isAtomEl(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  return tag === 'img' || (tag === 'br' && el.hasAttribute(HARD_BREAK_ATTR));
}

/** A tag chip: a `contenteditable=false` `.sk-tag` span. Unlike an image/break it is
 *  a MULTI-cell atom — its `#name` text still counts toward the offset width — but
 *  like an atom, a caret can only sit adjacent to it, never inside. `subtreeWidth`
 *  already counts its text, so reads need no special case; only the write path
 *  (placing a caret) must land beside it rather than descend into the non-editable
 *  span. */
function isChipEl(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).classList.contains(TAG_CLASS);
}

// Selects the atoms a block might contain. When a block has none — the
// overwhelming common case for prose — offset equals text length and the cheap
// Range measurement is exact, so the atom-aware walk is skipped on the hot path.
const ATOM_SELECTOR = `img, br[${HARD_BREAK_ATTR}]`;

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

// Total offset-width of a DOM subtree: text characters plus one per atom. Mark
// wrappers contribute nothing; the walk descends through them.
function subtreeWidth(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return isFillerText(node) ? 0 : (node as Text).data.length;
  if (isAtomEl(node)) return 1;
  let n = 0;
  for (const child of node.childNodes as unknown as Iterable<Node>) n += subtreeWidth(child);
  return n;
}

/** Flat offset of a DOM point within a block: text characters plus one per atom
 *  from the block's start to the point. Stable regardless of how the characters
 *  are wrapped, and — unlike `range.toString()` — counts atoms consistently across
 *  engines (a <br>'s string form differs between WebKit and Chromium). */
export function flatOffsetFromDOM(blockEl: HTMLElement, node: Node, offset: number): number {
  if (blockEl.querySelector(ATOM_SELECTOR) === null) {
    // No atoms: offset is pure text length, so the single native Range call the
    // hot path used before SKR-155 still holds exactly.
    const range = document.createRange();
    range.selectNodeContents(blockEl);
    try {
      range.setEnd(node, offset);
    } catch {
      return blockEl.textContent?.length ?? 0;
    }
    return range.toString().length;
  }
  let total = 0;
  let done = false;
  const walk = (n: Node): void => {
    if (done) return;
    if (n === node) {
      // The boundary is here: a text point counts its char offset; an element
      // point counts the full width of the first `offset` children. The caret
      // filler is zero-width, so a boundary inside it contributes nothing.
      if (n.nodeType === Node.TEXT_NODE) {
        total += isFillerText(n) ? 0 : Math.min(offset, (n as Text).data.length);
      } else {
        const kids = n.childNodes;
        for (let i = 0; i < offset && i < kids.length; i++) total += subtreeWidth(kids[i]!);
      }
      done = true;
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      total += isFillerText(n) ? 0 : (n as Text).data.length;
      return;
    }
    if (isAtomEl(n)) {
      total += 1;
      return;
    }
    for (const child of n.childNodes as unknown as Iterable<Node>) {
      walk(child);
      if (done) return;
    }
  };
  walk(blockEl);
  // Node outside the block (shouldn't happen): fall back to the full width.
  return done ? total : subtreeWidth(blockEl);
}

/** A DOM caret point immediately before or after an atom element, expressed
 *  against the atom's parent so the caret sits adjacent to it. */
function atomPoint(atom: Node, side: 'before' | 'after'): { node: Node; offset: number } {
  const parent = atom.parentNode ?? atom;
  const index = Array.prototype.indexOf.call(parent.childNodes, atom);
  return { node: parent, offset: side === 'before' ? index : index + 1 };
}

/** The DOM point for a flat offset within a block. Lands inside a text node when
 *  the offset falls in one, adjacent to an atom when it falls on an atom boundary,
 *  and clamps past-end to the block's last position. */
export function domPointFromFlatOffset(blockEl: HTMLElement, target: number): { node: Node; offset: number } {
  let acc = 0;
  let last: { node: Node; offset: number } = { node: blockEl, offset: 0 };
  // Skip everything INSIDE a tag chip: the chip is visited (and handled) as one
  // atom below, so descending into its `#name` text would double-count it and try
  // to plant the caret inside a non-editable span. Skip surface chrome wholesale
  // (SKR-262: a code block's colour mirror and language button) — rejecting the
  // chrome element also rejects its subtree, so its text never absorbs offset or
  // catches a past-end caret.
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).hasAttribute(CHROME_ATTR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return n.parentElement?.closest(`.${TAG_CLASS}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (isChipEl(n)) {
      // A boundary at or before the chip lands just before it; otherwise consume
      // its full width and record the point just after it.
      if (target <= acc) return atomPoint(n, 'before');
      acc += subtreeWidth(n);
      last = atomPoint(n, 'after');
    } else if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      // The zero-width caret filler on a trailing-break line: no width, but it IS
      // the landing spot for the caret after that break — a text anchor WKWebView
      // paints, unlike the bare element position between the <br>s. Record it as
      // `last` so a past-end target resolves here.
      if (isFillerText(t)) {
        last = { node: t, offset: 0 };
        continue;
      }
      if (acc + t.length >= target) return { node: t, offset: Math.max(0, target - acc) };
      acc += t.length;
      last = { node: t, offset: t.length };
    } else if (isAtomEl(n)) {
      // A boundary at or before this atom (with no preceding text to absorb it)
      // places the caret just before it; otherwise consume its cell.
      if (target <= acc) return atomPoint(n, 'before');
      acc += 1;
      last = atomPoint(n, 'after');
    }
    // Mark-wrapper elements are not counted; the walker descends into them.
  }
  return last;
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

/** Place a ranged selection from two DOM points.
 *
 *  Uses `setBaseAndExtent` (falling back to `collapse` + `extend`) rather than
 *  `removeAllRanges()` + `addRange()`, for the same reason `setCaret` does: these
 *  run right after a re-render replaced the nodes the old selection sat in, and in
 *  WKWebView `addRange` onto a fresh node in that state can fail to COMMIT — the
 *  highlight looks placed but `getSelection()` still reports the old, now-detached
 *  range, so the next command resolves nothing. `setBaseAndExtent` / `extend` share
 *  the commit path the typing hot path uses (the WKWebView caret blindspot). */
function applyRangePoints(sel: Selection, aNode: Node, aOffset: number, bNode: Node, bOffset: number): void {
  try {
    sel.setBaseAndExtent(aNode, aOffset, bNode, bOffset);
  } catch {
    try {
      sel.collapse(aNode, aOffset);
      sel.extend(bNode, bOffset);
    } catch {
      const range = document.createRange();
      range.setStart(aNode, aOffset);
      try {
        range.setEnd(bNode, bOffset);
      } catch {
        range.collapse(true);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

/** Select the flat range [start, end) within a block. Used after a mark command
 *  re-renders the block, so the user keeps their selection (and the bubble stays). */
export function setSelectionRange(blockEl: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = domPointFromFlatOffset(blockEl, start);
  const b = domPointFromFlatOffset(blockEl, end);
  applyRangePoints(sel, a.node, a.offset, b.node, b.offset);
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
  applyRangePoints(sel, a.node, a.offset, b.node, b.offset);
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

/** A DOM element that holds a single editable position — a table cell, or a
 *  block element with no nested block (paragraph / heading / code / table). A
 *  list or blockquote wrapper carries a block id but nests others, so it is not a
 *  leaf. Mirrors the leaf set `documentLeaves` walks in the model. */
function isLeafElement(el: Element): boolean {
  if ((el as HTMLElement).dataset?.cellRow != null) return true;
  if (!el.hasAttribute(BLOCK_ID_ATTR)) return false;
  return el.querySelector(`[${BLOCK_ID_ATTR}]`) === null;
}

/** The first (side 'start') or last (side 'end') leaf element within `root` in
 *  document order, or null when `root` contains none. `root` itself wins when it
 *  is already a leaf (a table's own element resolves to the table, not a cell). */
function boundaryLeafElement(root: Element, side: 'start' | 'end'): HTMLElement | null {
  if (isLeafElement(root)) return root as HTMLElement;
  const kids = Array.from(root.children);
  const ordered = side === 'start' ? kids : kids.slice().reverse();
  for (const child of ordered) {
    const found = boundaryLeafElement(child, side);
    if (found) return found;
  }
  return null;
}

/** Resolve a selection boundary that landed ABOVE any leaf — on the container or a
 *  list / blockquote wrapper, where Cmd+A and some drags leave it — down to the
 *  concrete leaf it borders (SKR-166): the first leaf for a start boundary, the
 *  last for an end boundary. Without this, `readSelection` fails to address such an
 *  endpoint and degrades a full selection to a collapsed caret. */
function boundaryAddr(container: HTMLElement, node: Node, offset: number, side: 'start' | 'end'): LeafAddr | null {
  // The subtree the boundary borders: the child at the offset for a point on the
  // container, else the element itself (a wrapper the point sits directly in).
  let root: Element | null;
  if (node === container) {
    const kids = container.childNodes;
    if (kids.length === 0) return null;
    const idx = side === 'start' ? offset : offset - 1;
    const child = kids[Math.max(0, Math.min(idx, kids.length - 1))];
    root = child && child.nodeType === Node.ELEMENT_NODE ? (child as Element) : null;
  } else {
    root = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  }
  if (!root) return null;
  const leafEl = boundaryLeafElement(root, side);
  return leafEl ? addrFromNode(container, leafEl) : null;
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

/** Resolve one selection boundary (a DOM node + offset) to a document position.
 *  Falls back to the bordering leaf when the point sits above any leaf (a
 *  container / wrapper boundary), so a full selection never fails to address an
 *  endpoint. `side` picks the first vs last leaf in that fallback. */
function readEndpoint(container: HTMLElement, node: Node, offset: number, side: 'start' | 'end'): DocPos | null {
  const addr = addrFromNode(container, node);
  if (addr) {
    const el = leafElement(container, addr);
    if (el) return { leaf: addr, offset: flatOffsetFromDOM(el, node, offset) };
  }
  const boundary = boundaryAddr(container, node, offset, side);
  if (!boundary) return null;
  const el = leafElement(container, boundary);
  if (!el) return null;
  // A start boundary sits at the leaf's head; an end boundary at its full extent.
  return { leaf: boundary, offset: side === 'start' ? 0 : subtreeWidth(el) };
}

/** True when the selection's focus precedes its anchor in document order — a
 *  backward drag / Shift+Home. Only the Selection's own anchor/focus carry this;
 *  a Range is always normalized to document order. Compared as BOUNDARY POINTS
 *  (a collapsed range + comparePoint), not node order: compareDocumentPosition
 *  flags an ancestor as PRECEDING, which would misread a ⌘A selection ending on
 *  the container as backward. */
export function isSelectionBackward(sel: Selection): boolean {
  const { anchorNode, focusNode } = sel;
  if (!anchorNode || !focusNode || sel.isCollapsed) return false;
  try {
    const r = document.createRange();
    r.setStart(anchorNode, sel.anchorOffset);
    r.collapse(true);
    return r.comparePoint(focusNode, sel.focusOffset) === -1;
  } catch {
    return false; // disjoint roots / unsupported point: treat as forward
  }
}

/** Read the current browser selection as a DocRange, or null when it is outside
 *  the surface. anchor/focus follow the SELECTION's ends, not document order: a
 *  backward drag reads back with anchor after focus, so a write (setBaseAndExtent
 *  via writeSelection) round-trips the direction and a following Shift+Arrow
 *  extends the end the user was dragging (SKR-192). Consumers that need document
 *  order re-derive it (orderRange / normalizeSelection). */
export function readSelection(container: HTMLElement): DocRange | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const start = readEndpoint(container, range.startContainer, range.startOffset, 'start');
  if (!start) return null;

  if (range.collapsed) return { anchor: start, focus: start };
  const end = readEndpoint(container, range.endContainer, range.endOffset, 'end') ?? start;
  return isSelectionBackward(sel) ? { anchor: end, focus: start } : { anchor: start, focus: end };
}

/** Resolve an arbitrary DOM point (e.g. a caretRangeFromPoint hit) to a document
 *  position, with the same above-leaf boundary fallback readSelection applies. */
export function docPosFromDOMPoint(container: HTMLElement, node: Node, offset: number): DocPos | null {
  return readEndpoint(container, node, offset, 'start');
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

/** Place a ranged selection robustly after a structural rebuild, mirroring
 *  `placeCaretRobust`: the sync placement is re-asserted once on the next frame,
 *  because WKWebView can leave a range set right after the surrounding DOM was
 *  replaced UNCOMMITTED (the highlight looks placed but the selection still reports
 *  the old, now-detached nodes). The re-assert is skipped when the selection
 *  already sits on the target range, or when the user moved it to a live selection
 *  of their own — it never fights a deliberate move. */
function placeRangeRobust(aNode: Node, aOffset: number, bNode: Node, bOffset: number, label: string): void {
  const sel = window.getSelection();
  if (!sel) return;
  applyRangePoints(sel, aNode, aOffset, bNode, bOffset);
  caretLog(label, 'sync', aNode, aOffset);
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    const s = window.getSelection();
    if (!s) return;
    if (s.anchorNode === aNode && s.focusNode === bNode) {
      caretLog(label, 'committed', aNode, aOffset);
      return;
    }
    if (s.anchorNode && s.anchorNode.isConnected && !s.isCollapsed) {
      caretLog(label, 'user-moved', s.anchorNode, s.anchorOffset);
      return; // a live range of the user's own = a deliberate move; don't fight it
    }
    applyRangePoints(s, aNode, aOffset, bNode, bOffset); // old range was detached / never committed
    caretLog(label, 're-assert', aNode, aOffset);
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
  placeRangeRobust(a.node, a.offset, b.node, b.offset, label);
}
