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

/** Place a collapsed caret at a flat offset within a block. */
export function setCaret(blockEl: HTMLElement, flatOffset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const { node, offset } = domPointFromFlatOffset(blockEl, flatOffset);
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
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

  const start = flatOffsetFromDOM(blockEl, range.startContainer, range.startOffset);
  const collapsed = range.collapsed;
  const endInBlock = blockEl.contains(range.endContainer);
  const end = collapsed || !endInBlock ? start : flatOffsetFromDOM(blockEl, range.endContainer, range.endOffset);
  return { blockEl, start, end, collapsed, spansBlocks: !endInBlock };
}
