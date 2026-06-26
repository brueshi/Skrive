// The keystroke spike (SKR-109) — THROWAWAY. Not production; lives in the harness
// to answer one existential question with data before Stage 3 commits to a
// surface: can a framework-free contenteditable land a glyph in constant time at
// 10k blocks while holding IME / paste / selection?
//
// Two DOM structures share one hot path so the comparison isolates structure:
//   - 'single'   : one contenteditable host, every block a child element. The
//                  question it answers: was today's 27x the BROWSER scaling a huge
//                  editable, or ProseMirror's JS on top?
//   - 'perblock' : one contenteditable host PER block (others inert). Block-local
//                  by construction — the strongest constant-time bet. Its cost is
//                  that caret/selection across a block boundary is not native (the
//                  seam the ticket names), which the spike documents, not solves.
//
// The hot path is exactly Stage 3's intended one: intercept `beforeinput`,
// preventDefault, mutate the focused block's text node imperatively, move the
// caret. React-free, synchronous, nothing document-scaled, never crossing the
// native bridge. IME composition and paste are deliberately left native (they
// cannot be cleanly cancelled) so the spike measures whether they HOLD on this
// structure, not a reimplementation of them.

import { parseDocument } from '../../lib/blockmodel';
import type { BlockNode, InlineNode } from '../../lib/blockmodel';

export type BespokeVariant = 'single' | 'perblock';

function inlineText(nodes: InlineNode[]): string {
  let s = '';
  for (const n of nodes) {
    if (n.kind === 'text') s += n.text;
    else if (n.kind === 'image') s += n.alt;
  }
  return s;
}

// Plain text for a block. The spike types prose, so paragraphs/headings render
// their inline text (carrying the matrix's caret markers); structural blocks
// render their first source line just to occupy space. Never empty — an empty
// editable line has no text node to place a caret in.
function blockText(block: BlockNode): string {
  let text = '';
  if (block.type === 'paragraph' || block.type === 'heading') text = inlineText(block.inline);
  else if (block.type === 'code_block') text = block.text.split('\n')[0] ?? '';
  else if (block.type === 'frozen_block') text = block.src.split('\n')[0] ?? '';
  else if ('src' in block && block.src) text = block.src.split('\n')[0] ?? '';
  return text.length > 0 ? text : ' ';
}

// Insert text at the current caret by mutating the text node in place, then
// collapse the selection after it. The whole hot-path cost: one text-node edit +
// one caret set. If the caret sits on an element (an empty block), drop in a text
// node first. Returns false if there is no usable selection.
function insertAtCaret(data: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    const tn = node as Text;
    tn.insertData(range.startOffset, data);
    sel.collapse(tn, range.startOffset + data.length);
  } else {
    const tn = document.createTextNode(data);
    range.insertNode(tn);
    sel.collapse(tn, data.length);
  }
  return true;
}

function onBeforeInput(event: Event): void {
  const e = event as InputEvent;
  // Only the plain keystroke is handled imperatively — the thing we are proving.
  // Deletes, breaks, and composition fall through to the browser so the spike
  // measures whether they hold on this structure, not a reimplementation.
  if (e.inputType !== 'insertText' || typeof e.data !== 'string') return;
  if (insertAtCaret(e.data)) e.preventDefault();
}

// Paste is handled imperatively too — the same block-local insert as a keystroke,
// just a larger payload. This is also what Stage 3 must do (own the paste so the
// model stays authoritative), so measuring it here is measuring the real path.
function onPaste(event: Event): void {
  const e = event as ClipboardEvent;
  const text = e.clipboardData?.getData('text/plain');
  if (typeof text !== 'string' || text.length === 0) return;
  if (insertAtCaret(text)) e.preventDefault();
}

/**
 * Mount the bespoke spike into `root`. Framework-free after this call: the hot
 * path is the capture-phase beforeinput listener and direct DOM mutation, with no
 * React in the loop. Returns the number of blocks rendered.
 */
export function mountBespoke(root: HTMLElement, md: string, variant: BespokeVariant): number {
  const doc = parseDocument(md);
  root.textContent = '';

  const container = document.createElement('div');
  container.className = `bespoke bespoke-${variant}`;
  if (variant === 'single') container.contentEditable = 'true';
  container.spellcheck = false;

  for (const block of doc.blocks) {
    const el = document.createElement('p');
    el.className = 'bespoke-block';
    el.dataset.blockId = block.id;
    if (variant === 'perblock') el.contentEditable = 'true';
    el.appendChild(document.createTextNode(blockText(block)));
    container.appendChild(el);
  }

  // One capture-phase listener covers every block: beforeinput bubbles, so a
  // single host catches input from any per-block editable too.
  container.addEventListener('beforeinput', onBeforeInput, { capture: true });
  container.addEventListener('paste', onPaste, { capture: true });
  root.appendChild(container);
  return doc.blocks.length;
}
