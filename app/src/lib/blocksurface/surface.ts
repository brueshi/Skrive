// The bespoke editing surface controller (SKR-95, Stage 3a). One contenteditable
// host (the Stage 2 winner) over the block model. The keystroke hot path is
// React-free and block-local: read the caret, edit the focused block's inline
// model, re-render that one block, restore the caret. The model is authoritative;
// the DOM is derived; the cold path (serialize) is debounced off the hot path.
//
// Stage 3a scope: prose typing, within-block delete, paste-as-text, and IME, in
// paragraph and heading blocks. Block-crossing operations (Enter/split,
// boundary-merge, forward delete) are intercepted to keep the model in sync but
// are no-ops until Stage 3b — never letting the browser mutate structure behind
// the model's back.

import { generateBlockId, type BlockNode, type Document, type InlineNode } from '../blockmodel';
import { BLOCK_ID_ATTR, BlockViewRegistry, renderBlock, renderDocument, renderInlineInto } from './render';
import { caretContext, focusedBlockElement, setCaret } from './selection';
import { deleteRangeInInline, inlineLength, insertTextInInline, readInlineFromDOM, splitInline } from './inline-ops';

const SERIALIZE_DEBOUNCE_MS = 400;

export type BlockSurfaceOptions = {
  container: HTMLElement;
  doc: Document;
  /** Called debounced after edits with the current document, for the cold path
   *  (serialize / persist). Never called on the synchronous keystroke path. */
  onDocChange?: (doc: Document) => void;
};

type InlineTextBlock = Extract<BlockNode, { type: 'paragraph' | 'heading' }>;
function isInlineText(block: BlockNode): block is InlineTextBlock {
  return block.type === 'paragraph' || block.type === 'heading';
}

export class BlockSurface {
  private doc: Document;
  private readonly container: HTMLElement;
  private readonly registry = new BlockViewRegistry();
  private readonly onDocChange?: (doc: Document) => void;
  private debounceTimer: number | null = null;
  private composing = false;

  constructor(opts: BlockSurfaceOptions) {
    this.container = opts.container;
    this.doc = opts.doc;
    this.onDocChange = opts.onDocChange;

    this.container.contentEditable = 'true';
    this.container.spellcheck = false;
    renderDocument(this.container, this.doc.blocks, this.registry);

    this.container.addEventListener('beforeinput', this.onBeforeInput, { capture: true });
    this.container.addEventListener('paste', this.onPaste, { capture: true });
    this.container.addEventListener('compositionstart', this.onCompositionStart, true);
    this.container.addEventListener('compositionend', this.onCompositionEnd, true);
  }

  /** The current authoritative document. The consumer serializes this. */
  getDocument(): Document {
    return this.doc;
  }

  /** Flush any pending debounced cold-path call immediately (save / blur). */
  flush(): void {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.onDocChange?.(this.doc);
    }
  }

  destroy(): void {
    this.container.removeEventListener('beforeinput', this.onBeforeInput, true);
    this.container.removeEventListener('paste', this.onPaste, true);
    this.container.removeEventListener('compositionstart', this.onCompositionStart, true);
    this.container.removeEventListener('compositionend', this.onCompositionEnd, true);
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
  }

  // --- the hot path --------------------------------------------------------

  private onBeforeInput = (event: Event): void => {
    if (this.composing) return; // IME composes natively; reconcile on end
    const e = event as InputEvent;
    const type = e.inputType;
    if (type === 'insertText' && typeof e.data === 'string') {
      e.preventDefault();
      this.applyInsertText(e.data);
    } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
      e.preventDefault();
      this.applyEnter();
    } else if (type === 'deleteContentBackward') {
      e.preventDefault();
      this.applyDeleteBackward();
    } else if (type === 'deleteContentForward') {
      e.preventDefault();
      this.applyDeleteForward();
    } else if (type.startsWith('insert') || type.startsWith('delete')) {
      // Still-unmodeled edits (word/line delete) — block them so the browser
      // cannot mutate structure behind the model. Mapped to commands later.
      e.preventDefault();
    }
  };

  private onPaste = (event: Event): void => {
    const e = event as ClipboardEvent;
    const text = e.clipboardData?.getData('text/plain');
    if (typeof text !== 'string' || text.length === 0) return;
    e.preventDefault();
    // Stage 3a: paste as plain text, newlines collapsed (block-splitting paste is
    // 3b). The same block-local insert as a keystroke, larger payload.
    this.applyInsertText(text.replace(/\r?\n/g, ' '));
  };

  private onCompositionStart = (): void => {
    this.composing = true;
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    // The IME mutated the focused block's DOM natively; read it back into the
    // model without re-rendering (the caret the IME left is correct).
    const blockEl = focusedBlockElement(this.container, this.registry);
    if (!blockEl) return;
    const found = this.findBlock(blockEl);
    if (!found || !isInlineText(found.block)) return;
    this.commitBlock(found.index, { ...found.block, inline: readInlineFromDOM(blockEl), dirty: true });
    this.scheduleSerialize();
  };

  private applyInsertText(text: string): void {
    const ctx = caretContext(this.container, this.registry);
    if (!ctx) return;
    const found = this.findBlock(ctx.blockEl);
    if (!found || !isInlineText(found.block) || ctx.spansBlocks) return;

    let inline = found.block.inline;
    if (!ctx.collapsed) inline = deleteRangeInInline(inline, ctx.start, ctx.end);
    inline = insertTextInInline(inline, ctx.start, text);

    this.commitBlock(found.index, { ...found.block, inline, dirty: true });
    renderInlineInto(ctx.blockEl, inline);
    setCaret(ctx.blockEl, ctx.start + text.length);
    this.scheduleSerialize();
  }

  private applyDeleteBackward(): void {
    const ctx = caretContext(this.container, this.registry);
    if (!ctx) return;
    const found = this.findBlock(ctx.blockEl);
    if (!found || !isInlineText(found.block) || ctx.spansBlocks) return;

    if (ctx.collapsed && ctx.start === 0) {
      this.mergeWithPrevious(found.index, ctx.blockEl);
      return;
    }

    let inline = found.block.inline;
    let caret: number;
    if (!ctx.collapsed) {
      inline = deleteRangeInInline(inline, ctx.start, ctx.end);
      caret = ctx.start;
    } else {
      inline = deleteRangeInInline(inline, ctx.start - 1, ctx.start);
      caret = ctx.start - 1;
    }

    this.commitBlock(found.index, { ...found.block, inline, dirty: true });
    renderInlineInto(ctx.blockEl, inline);
    setCaret(ctx.blockEl, caret);
    this.scheduleSerialize();
  }

  private applyDeleteForward(): void {
    const ctx = caretContext(this.container, this.registry);
    if (!ctx) return;
    const found = this.findBlock(ctx.blockEl);
    if (!found || !isInlineText(found.block) || ctx.spansBlocks) return;

    const len = inlineLength(found.block.inline);
    if (ctx.collapsed && ctx.start >= len) {
      this.mergeWithNext(found.index, ctx.blockEl);
      return;
    }

    const inline = ctx.collapsed
      ? deleteRangeInInline(found.block.inline, ctx.start, ctx.start + 1)
      : deleteRangeInInline(found.block.inline, ctx.start, ctx.end);
    this.commitBlock(found.index, { ...found.block, inline, dirty: true });
    renderInlineInto(ctx.blockEl, inline);
    setCaret(ctx.blockEl, ctx.start);
    this.scheduleSerialize();
  }

  // Enter: split the focused block at the caret. The original keeps its id and the
  // first half; the new block mints a fresh id and takes the second half (the
  // id-survival contract: split mints).
  private applyEnter(): void {
    const ctx = caretContext(this.container, this.registry);
    if (!ctx) return;
    const found = this.findBlock(ctx.blockEl);
    if (!found || !isInlineText(found.block) || ctx.spansBlocks) return;

    let inline = found.block.inline;
    if (!ctx.collapsed) inline = deleteRangeInInline(inline, ctx.start, ctx.end);
    const [left, right] = splitInline(inline, ctx.start);

    const leftBlock: BlockNode = { ...found.block, inline: left, dirty: true };
    const level = found.block.type === 'heading' ? found.block.level : 1;
    const rightBlock = this.newInlineBlock(found.block.type, right, level);

    const blocks = this.doc.blocks.slice();
    blocks.splice(found.index, 1, leftBlock, rightBlock);
    this.doc = { ...this.doc, blocks };

    renderInlineInto(ctx.blockEl, left);
    const rightEl = renderBlock(rightBlock);
    ctx.blockEl.after(rightEl);
    this.registry.set(rightBlock.id, rightEl);
    setCaret(rightEl, 0);
    this.scheduleSerialize();
  }

  // Backspace at a block start: append this block's content to the previous one.
  // The previous block is the survivor and keeps its id (merge keeps survivor);
  // this block is removed.
  private mergeWithPrevious(index: number, currEl: HTMLElement): void {
    if (index === 0) return;
    const prev = this.doc.blocks[index - 1]!;
    const curr = this.doc.blocks[index]!;
    if (!isInlineText(prev) || !isInlineText(curr)) return;

    const joinOffset = inlineLength(prev.inline);
    const merged: BlockNode = { ...prev, inline: [...prev.inline, ...curr.inline], dirty: true };
    const blocks = this.doc.blocks.slice();
    blocks.splice(index - 1, 2, merged);
    this.doc = { ...this.doc, blocks };

    const prevEl = this.registry.get(prev.id);
    this.registry.delete(curr.id);
    currEl.remove();
    if (prevEl) {
      renderInlineInto(prevEl, merged.inline);
      setCaret(prevEl, joinOffset);
    }
    this.scheduleSerialize();
  }

  // Forward-delete at a block end: append the next block's content to this one.
  // This block survives and keeps its id; the next block is removed.
  private mergeWithNext(index: number, currEl: HTMLElement): void {
    const curr = this.doc.blocks[index]!;
    const next = this.doc.blocks[index + 1];
    if (!next || !isInlineText(curr) || !isInlineText(next)) return;

    const joinOffset = inlineLength(curr.inline);
    const merged: BlockNode = { ...curr, inline: [...curr.inline, ...next.inline], dirty: true };
    const blocks = this.doc.blocks.slice();
    blocks.splice(index, 2, merged);
    this.doc = { ...this.doc, blocks };

    const nextEl = this.registry.get(next.id);
    this.registry.delete(next.id);
    nextEl?.remove();
    renderInlineInto(currEl, merged.inline);
    setCaret(currEl, joinOffset);
    this.scheduleSerialize();
  }

  private newInlineBlock(type: 'paragraph' | 'heading', inline: InlineNode[], level: number): BlockNode {
    const base = { id: generateBlockId(), durable: false, src: null, gapBefore: null, dirty: true };
    return type === 'heading' ? { type: 'heading', ...base, level, inline } : { type: 'paragraph', ...base, inline };
  }

  // --- model plumbing ------------------------------------------------------

  private findBlock(blockEl: HTMLElement): { block: BlockNode; index: number } | null {
    const id = blockEl.getAttribute(BLOCK_ID_ATTR);
    if (id == null) return null;
    const index = this.doc.blocks.findIndex((b) => b.id === id);
    if (index < 0) return null;
    return { block: this.doc.blocks[index]!, index };
  }

  private commitBlock(index: number, next: BlockNode): void {
    const blocks = this.doc.blocks.slice();
    blocks[index] = next;
    this.doc = { ...this.doc, blocks };
  }

  private scheduleSerialize(): void {
    if (!this.onDocChange) return;
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.onDocChange?.(this.doc);
    }, SERIALIZE_DEBOUNCE_MS);
  }
}

export type { InlineNode };
