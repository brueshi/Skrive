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

import type { BlockNode, Document, InlineNode } from '../blockmodel';
import { BLOCK_ID_ATTR, BlockViewRegistry, renderDocument, renderInlineInto } from './render';
import { caretContext, focusedBlockElement, setCaret } from './selection';
import { deleteRangeInInline, insertTextInInline, readInlineFromDOM } from './inline-ops';

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
    } else if (type === 'deleteContentBackward') {
      e.preventDefault();
      this.applyDeleteBackward();
    } else if (type.startsWith('insert') || type.startsWith('delete')) {
      // Unmodeled structural edit (Enter, forward/word delete) — block it so the
      // browser cannot mutate structure behind the model. Implemented in 3b.
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

    let inline = found.block.inline;
    let caret: number;
    if (!ctx.collapsed) {
      inline = deleteRangeInInline(inline, ctx.start, ctx.end);
      caret = ctx.start;
    } else if (ctx.start > 0) {
      inline = deleteRangeInInline(inline, ctx.start - 1, ctx.start);
      caret = ctx.start - 1;
    } else {
      return; // caret at block start: boundary merge is Stage 3b
    }

    this.commitBlock(found.index, { ...found.block, inline, dirty: true });
    renderInlineInto(ctx.blockEl, inline);
    setCaret(ctx.blockEl, caret);
    this.scheduleSerialize();
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
