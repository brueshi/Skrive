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
import { caretContext, flatOffsetFromDOM, focusedLeafElement, leafCaretContext, setCaret, setCrossBlockSelection, setSelectionRange } from './selection';
import { findBlockById, updateBlockById } from './tree';
import { enterInContainer, exitContainer, type StructuralResult } from './structural';
import { changeListType, findImmediateList, indentItem, liftItemToParagraph, outdentItem } from './list-ops';
import {
  type BooleanMark,
  deleteRangeInInline,
  inlineLength,
  inlinePlainText,
  insertTextInInline,
  rangeHasLink,
  rangeHasMark,
  readInlineFromDOM,
  setLinkInInline,
  setMarkInInline,
  splitInline,
  toggleMarkInInline
} from './inline-ops';

/** A block type the insert menu / commands can apply to the current block. */
export type BlockTypeSpec =
  | { kind: 'paragraph' }
  | { kind: 'heading'; level: number }
  | { kind: 'blockquote' }
  | { kind: 'bullet_list' }
  | { kind: 'ordered_list'; start?: number; delimiter?: '.' | ')' }
  | { kind: 'code' }
  | { kind: 'table' }
  | { kind: 'divider' };

/** What the insert (slash) menu needs: where to anchor, and the query typed after
 *  the `/`. Null when the menu is closed. */
export type SlashMenuState = { rect: DOMRect; query: string };

/** What the select->bubble affordance needs: where the selection is on screen and
 *  which marks already cover it (for active state). Null when there is no
 *  bubble-worthy selection (collapsed, empty, or crossing a block boundary). */
export type SelectionInfo = {
  rect: DOMRect;
  marks: { strong: boolean; em: boolean; code: boolean; link: boolean };
};

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
  private selectionCb: ((info: SelectionInfo | null) => void) | null = null;
  private selScheduled = false;
  private savedLink: { blockId: string; start: number; end: number } | null = null;
  private slash: { blockId: string; slashOffset: number } | null = null;
  private slashCb: ((state: SlashMenuState | null) => void) | null = null;
  // The block object each top-level element was last rendered from, so the
  // incremental reconciler re-renders only the top-level blocks that changed.
  private readonly renderedFrom = new Map<string, BlockNode>();

  constructor(opts: BlockSurfaceOptions) {
    this.container = opts.container;
    this.doc = opts.doc;
    this.onDocChange = opts.onDocChange;

    this.container.contentEditable = 'true';
    this.container.spellcheck = false;
    // Disable the OS text services that fire on word boundaries (autocorrect /
    // capitalization / smart substitution). In a contenteditable they emit
    // insertReplacementText on space/period, which the hot path would have to
    // fight — the source of the word-then-space / word-then-period lag.
    this.container.setAttribute('autocorrect', 'off');
    this.container.setAttribute('autocapitalize', 'off');
    this.container.setAttribute('autocomplete', 'off');
    renderDocument(this.container, this.doc.blocks, this.registry);
    for (const block of this.doc.blocks) this.renderedFrom.set(block.id, block);

    this.container.addEventListener('beforeinput', this.onBeforeInput, { capture: true });
    this.container.addEventListener('paste', this.onPaste, { capture: true });
    this.container.addEventListener('compositionstart', this.onCompositionStart, true);
    this.container.addEventListener('compositionend', this.onCompositionEnd, true);
    this.container.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('selectionchange', this.onDocSelectionChange);
  }

  /** Register (or clear, with null) the select->bubble observer. Fired
   *  rAF-coalesced on selection change, never per keystroke. */
  onSelectionChange(cb: ((info: SelectionInfo | null) => void) | null): void {
    this.selectionCb = cb;
  }

  /** Register (or clear) the insert (slash) menu observer. Fired when a `/` opens
   *  the menu on an empty block, as its query changes, and when it closes (null). */
  onSlashMenu(cb: ((state: SlashMenuState | null) => void) | null): void {
    this.slashCb = cb;
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
    this.container.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('selectionchange', this.onDocSelectionChange);
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
  }

  // --- marks: keyboard shortcuts + commands --------------------------------

  private onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    // Tab moves between table cells (no modifier); in a list item it nests
    // (Shift+Tab outdents). Outside a table or list, Tab keeps its native focus
    // behaviour (the early return below without preventDefault).
    if (e.key === 'Tab') {
      const cell = this.cellTarget();
      if (cell) {
        e.preventDefault();
        this.moveCell(cell, e.shiftKey ? -1 : 1);
        return;
      }
      const t = this.leafTarget();
      if (t && !t.spansBlocks && isInlineText(t.leaf) && findImmediateList(this.doc.blocks, t.leaf.id)) {
        e.preventDefault();
        if (e.shiftKey) this.applyOutdent(t.leaf.id, t.start);
        else this.applyIndent(t.leaf.id, t.start);
      }
      return;
    }
    // Enter is handled here (not beforeinput): preventDefault on keydown reliably
    // stops the browser's own newline, so the block splits exactly once.
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.applyEnter();
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // Cmd/Ctrl+Shift+8 / +7 toggle bullet / ordered list (Google-Docs parity).
    // Keyed on e.code so it is layout-independent (Shift+8 is '*' on a US layout).
    if (e.shiftKey && (e.code === 'Digit8' || e.code === 'Digit7')) {
      e.preventDefault();
      this.toggleList(e.code === 'Digit8' ? 'bullet_list' : 'ordered_list');
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      this.toggleMark('strong');
    } else if (key === 'i') {
      e.preventDefault();
      this.toggleMark('em');
    } else if (key === 'e') {
      e.preventDefault();
      this.toggleMark('code');
    }
  };

  /** Toggle a boolean mark over the current selection. A no-op without a
   *  within-block selection (stored marks for a collapsed caret are a later
   *  refinement). */
  toggleMark(mark: BooleanMark): void {
    // A selection can cover several blocks (select-all, triple-click that bleeds
    // into the next block, or a deliberate multi-paragraph drag). Resolve every
    // covered leaf and mark them as one unit so "bold the whole thing" works.
    const leaves = this.selectedLeaves();
    if (leaves.length > 0) {
      this.applyMarkToLeaves(leaves, mark);
      return;
    }
    // No block-id leaf in the selection means a table cell (cells are addressed by
    // coordinates, not a block id) — fall back to the single-region path.
    this.applyToSelection((inline, start, end) => toggleMarkInInline(inline, start, end, mark));
  }

  /** Apply a mark uniformly across the covered leaves. The on/off decision is made
   *  once over the whole selection (Google-Docs semantics: if every covered run
   *  already has the mark, clear it; otherwise set it everywhere), then forced on
   *  each leaf so a half-marked selection ends up fully marked, not inverted. */
  private applyMarkToLeaves(
    leaves: ReadonlyArray<{ leaf: InlineTextBlock; start: number; end: number }>,
    mark: BooleanMark
  ): void {
    const on = !leaves.every((l) => rangeHasMark(l.leaf.inline, l.start, l.end, mark));
    let blocks = this.doc.blocks;
    for (const l of leaves) {
      const inline = setMarkInInline(l.leaf.inline, l.start, l.end, mark, on);
      blocks = updateBlockById(blocks, l.leaf.id, (b) => ({ ...b, inline, dirty: true }) as BlockNode);
    }
    this.doc = { ...this.doc, blocks };
    for (const l of leaves) {
      const el = this.leafElementById(l.leaf.id);
      const updated = findBlockById(this.doc.blocks, l.leaf.id);
      if (el && updated && isInlineText(updated)) renderInlineInto(el, updated.inline);
    }
    const first = leaves[0];
    const last = leaves[leaves.length - 1];
    if (!first || !last) return;
    const firstEl = this.leafElementById(first.leaf.id);
    const lastEl = this.leafElementById(last.leaf.id);
    if (firstEl && lastEl) {
      if (firstEl === lastEl) setSelectionRange(firstEl, first.start, last.end);
      else setCrossBlockSelection(firstEl, first.start, lastEl, last.end);
    }
    this.scheduleSerialize();
    this.emitSelection();
  }

  /** The inline-text leaves the current selection actually covers, in document
   *  order, each clamped to its in-block range. A leaf the selection only grazes
   *  at offset 0 (the classic triple-click bleed into the next block) contributes
   *  nothing and is dropped, so marks land only where text is really selected. */
  private selectedLeaves(): Array<{ leaf: InlineTextBlock; start: number; end: number }> {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const out: Array<{ leaf: InlineTextBlock; start: number; end: number }> = [];
    this.container.querySelectorAll(`[${BLOCK_ID_ATTR}]`).forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const id = node.getAttribute(BLOCK_ID_ATTR);
      if (!id) return;
      const block = findBlockById(this.doc.blocks, id);
      if (!block || !isInlineText(block) || !range.intersectsNode(node)) return;
      const start = node.contains(range.startContainer)
        ? flatOffsetFromDOM(node, range.startContainer, range.startOffset)
        : 0;
      const end = node.contains(range.endContainer)
        ? flatOffsetFromDOM(node, range.endContainer, range.endOffset)
        : inlineLength(block.inline);
      if (start >= end) return;
      out.push({ leaf: block, start, end });
    });
    return out;
  }

  /** Set or clear the link over the current selection. `href` empty/null clears. */
  setLink(href: string | null): void {
    const link = href && href.length > 0 ? { href, title: null } : null;
    this.applyToSelection((inline, start, end) => setLinkInInline(inline, start, end, link));
  }

  /** Remember the current selection so a link can be applied to it after focus
   *  moves to a URL input (which would otherwise collapse the live selection).
   *  Returns false when there is no within-block selection to link. */
  beginLink(): boolean {
    const t = this.leafTarget();
    if (!t || t.collapsed || t.spansBlocks || !isInlineText(t.leaf)) return false;
    this.savedLink = { blockId: t.leaf.id, start: t.start, end: t.end };
    return true;
  }

  /** Apply (or, with null, abandon) a link to the selection saved by beginLink. */
  commitLink(href: string | null): void {
    const saved = this.savedLink;
    this.savedLink = null;
    if (!saved || href == null || href.length === 0) return;
    const block = findBlockById(this.doc.blocks, saved.blockId);
    if (!block || !isInlineText(block)) return;
    const inline = setLinkInInline(block.inline, saved.start, saved.end, { href, title: null });
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, saved.blockId, (b) => ({ ...b, inline, dirty: true }) as BlockNode) };
    const el = this.leafElementById(saved.blockId);
    if (el) {
      renderInlineInto(el, inline);
      setSelectionRange(el, saved.start, saved.end);
    }
    this.scheduleSerialize();
    this.emitSelection();
  }

  private applyToSelection(transform: (inline: InlineNode[], start: number, end: number) => InlineNode[]): void {
    const cell = this.cellTarget();
    if (cell) {
      if (cell.collapsed || cell.spansCells) return;
      const inline = transform(cell.inline, cell.start, cell.end);
      this.commitCell(cell, inline, cell.end);
      setSelectionRange(cell.cellEl, cell.start, cell.end);
      this.scheduleSerialize();
      this.emitSelection();
      return;
    }
    const t = this.leafTarget();
    if (!t || t.collapsed || t.spansBlocks || !isInlineText(t.leaf)) return;
    const inline = transform(t.leaf.inline, t.start, t.end);
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, t.leaf.id, (b) => ({ ...b, inline, dirty: true }) as BlockNode) };
    renderInlineInto(t.blockEl, inline);
    setSelectionRange(t.blockEl, t.start, t.end);
    this.scheduleSerialize();
    this.emitSelection(); // refresh the bubble's active state
  }

  // --- block types + the insert (slash) menu -------------------------------

  /** Convert the current block's type, or insert a divider. Keeps the inline
   *  content (and the block id) across a paragraph<->heading change. */
  setBlockType(spec: BlockTypeSpec): void {
    const cur = this.currentInlineBlock();
    if (!cur) return;
    if (spec.kind === 'divider') {
      this.replaceWithDivider(cur);
      return;
    }
    // A type change invalidates the captured src (it would re-serialize as the old
    // construct), so drop it; the seam gap is unchanged.
    const base = { id: cur.block.id, durable: cur.block.durable, src: null, gapBefore: cur.block.gapBefore, dirty: true };
    const inline = cur.block.inline;

    // Container conversions wrap the inline in a fresh nested paragraph (which gets
    // its own id) so the caret lands in an editable leaf inside the container.
    let next: BlockNode;
    let caretLeafId: string | null = null;
    switch (spec.kind) {
      case 'heading':
        next = { type: 'heading', ...base, level: spec.level, inline };
        break;
      case 'blockquote': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        caretLeafId = inner.id;
        next = { type: 'blockquote', ...base, children: [inner] };
        break;
      }
      case 'bullet_list': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        caretLeafId = inner.id;
        next = { type: 'bullet_list', ...base, marker: '-', spread: false, items: [{ spread: false, children: [inner] }] };
        break;
      }
      case 'ordered_list': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        caretLeafId = inner.id;
        next = { type: 'ordered_list', ...base, start: spec.start ?? 1, delimiter: spec.delimiter ?? '.', spread: false, items: [{ spread: false, children: [inner] }] };
        break;
      }
      case 'code':
        next = { type: 'code_block', ...base, lang: '', meta: null, fence: null, text: inlinePlainText(inline) };
        break;
      case 'table':
        // A starter 2x2 table (header row + one body row), empty cells.
        next = { type: 'table', ...base, align: [null, null], rows: [[[], []], [[], []]] };
        break;
      case 'paragraph':
      default:
        next = { type: 'paragraph', ...base, inline };
        break;
    }

    this.commitBlock(cur.index, next);
    const newEl = renderBlock(next);
    cur.blockEl.replaceWith(newEl);
    this.registry.set(cur.block.id, newEl);
    this.renderedFrom.set(cur.block.id, next);

    if (spec.kind === 'table') {
      const firstCell = newEl.querySelector('[data-cell-row="0"][data-cell-col="0"]') as HTMLElement | null;
      if (firstCell) setCaret(firstCell, 0);
    } else {
      const caretEl = caretLeafId
        ? ((newEl.querySelector(`[${BLOCK_ID_ATTR}="${caretLeafId}"]`) as HTMLElement | null) ?? newEl)
        : newEl;
      setCaret(caretEl, Math.min(cur.caret, inlineLength(inline)));
    }
    this.scheduleSerialize();
  }

  private replaceWithDivider(cur: { block: BlockNode; index: number; blockEl: HTMLElement }): void {
    const hr: BlockNode = {
      type: 'horizontal_rule',
      id: cur.block.id,
      durable: cur.block.durable,
      src: null,
      gapBefore: cur.block.gapBefore,
      dirty: true
    };
    const para = this.newInlineBlock('paragraph', [], 1);
    const blocks = this.doc.blocks.slice();
    blocks.splice(cur.index, 1, hr, para);
    this.doc = { ...this.doc, blocks };

    const hrEl = renderBlock(hr);
    cur.blockEl.replaceWith(hrEl);
    this.registry.set(hr.id, hrEl);
    const paraEl = renderBlock(para);
    hrEl.after(paraEl);
    this.registry.set(para.id, paraEl);
    setCaret(paraEl, 0);
    this.scheduleSerialize();
  }

  // --- list ergonomics (SKR-112) -------------------------------------------

  /** Tab: nest the focused list item under its previous sibling. No-op when the
   *  item is first in its list. The leaf keeps its id, so the caret is restored. */
  private applyIndent(leafId: string, offset: number): void {
    const blocks = indentItem(this.doc.blocks, leafId, generateBlockId);
    if (blocks) this.applyStructural({ blocks, caret: { id: leafId, offset } });
  }

  /** Shift+Tab: outdent a nested item one level; a top-level item is lifted out of
   *  the list to a paragraph (splitting the list). Same dispatch backs toggle-off. */
  private applyOutdent(leafId: string, offset: number): void {
    const blocks =
      outdentItem(this.doc.blocks, leafId, generateBlockId) ??
      liftItemToParagraph(this.doc.blocks, leafId, generateBlockId);
    if (blocks) this.applyStructural({ blocks, caret: { id: leafId, offset } });
  }

  /** Toggle the focused block to/from a list of `target` kind (Cmd/Ctrl+Shift+8/7).
   *  Not in a list -> wrap into one; in a list of the same kind -> outdent/lift off;
   *  in a list of the other kind -> switch the kind. */
  toggleList(target: 'bullet_list' | 'ordered_list'): void {
    const t = this.leafTarget();
    if (!t || t.spansBlocks || !isInlineText(t.leaf)) return;
    const list = findImmediateList(this.doc.blocks, t.leaf.id);
    if (!list) {
      this.setBlockType({ kind: target });
      return;
    }
    if (list.type === target) {
      this.applyOutdent(t.leaf.id, t.start);
      return;
    }
    const blocks = changeListType(this.doc.blocks, t.leaf.id, target);
    if (blocks) this.applyStructural({ blocks, caret: { id: t.leaf.id, offset: t.start } });
  }

  /** Affordance input rule: a typed space after a list marker at the start of a
   *  top-level paragraph (`- `, `* `, `+ `, or `N.`/`N)`) converts the block to a
   *  list and consumes the marker — it never persists as Markdown syntax. Returns
   *  true when it fired. */
  private tryListInputRule(): boolean {
    const cur = this.currentInlineBlock();
    if (!cur || cur.block.type !== 'paragraph' || !this.isTopLevel(cur.blockEl, cur.block.id)) return false;
    const prefix = inlinePlainText(cur.block.inline).slice(0, cur.caret);

    let spec: BlockTypeSpec | null = null;
    let markerLen = 0;
    if (prefix === '- ' || prefix === '* ' || prefix === '+ ') {
      spec = { kind: 'bullet_list' };
      markerLen = 2;
    } else {
      const m = /^(\d{1,9})([.)]) $/.exec(prefix);
      if (m) {
        spec = { kind: 'ordered_list', start: Number(m[1]), delimiter: m[2] as '.' | ')' };
        markerLen = m[0].length;
      }
    }
    if (!spec) return false;

    // Consume the marker text, then convert the (now marker-less) paragraph.
    const inline = deleteRangeInInline(cur.block.inline, 0, markerLen);
    this.commitBlock(cur.index, { ...cur.block, inline, dirty: true });
    renderInlineInto(cur.blockEl, inline);
    setCaret(cur.blockEl, 0);
    this.setBlockType(spec);
    return true;
  }

  /** Apply an insert-menu choice: strip the `/query` text, then set the block
   *  type. Called by the menu (which preserves the caret on mousedown). */
  applySlashCommand(spec: BlockTypeSpec): void {
    const slash = this.slash;
    if (!slash) return;
    const cur = this.currentInlineBlock();
    if (cur && cur.block.id === slash.blockId) {
      const text = inlinePlainText(cur.block.inline);
      const inline = deleteRangeInInline(cur.block.inline, slash.slashOffset, text.length);
      this.commitBlock(cur.index, { ...cur.block, inline, dirty: true });
      renderInlineInto(cur.blockEl, inline);
      setCaret(cur.blockEl, slash.slashOffset);
    }
    this.closeSlash();
    this.setBlockType(spec);
  }

  closeSlash(): void {
    if (!this.slash) return;
    this.slash = null;
    this.slashCb?.(null);
  }

  private currentInlineBlock(): { block: InlineTextBlock; index: number; blockEl: HTMLElement; caret: number } | null {
    const ctx = caretContext(this.container, this.registry);
    if (!ctx) return null;
    const found = this.findBlock(ctx.blockEl);
    if (!found || !isInlineText(found.block)) return null;
    return { block: found.block, index: found.index, blockEl: ctx.blockEl, caret: ctx.start };
  }

  private handleSlashAfterInsert(text: string): void {
    if (!this.slash && text === '/') {
      const cur = this.currentInlineBlock();
      // Open only when the `/` is the entire block (a deliberate, empty-line gesture).
      if (cur && inlinePlainText(cur.block.inline) === '/') {
        this.slash = { blockId: cur.block.id, slashOffset: cur.caret - 1 };
      }
    }
    this.refreshSlash();
  }

  private refreshSlash(): void {
    if (!this.slash) return;
    const cur = this.currentInlineBlock();
    if (!cur || cur.block.id !== this.slash.blockId) return this.closeSlash();
    const text = inlinePlainText(cur.block.inline);
    if (text[this.slash.slashOffset] !== '/') return this.closeSlash();
    const query = text.slice(this.slash.slashOffset + 1, cur.caret);
    if (query.includes(' ')) return this.closeSlash();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.closeSlash();
    let rect = sel.getRangeAt(0).getBoundingClientRect();
    // A caret in an empty block can report a degenerate rect; anchor to the block.
    if (rect.height === 0 && rect.width === 0) rect = cur.blockEl.getBoundingClientRect();
    this.slashCb?.({ rect, query });
  }

  // --- the select->bubble observer -----------------------------------------

  private onDocSelectionChange = (): void => {
    if (this.selScheduled) return;
    this.selScheduled = true;
    requestAnimationFrame(() => {
      this.selScheduled = false;
      this.emitSelection();
    });
  };

  private emitSelection(): void {
    const cb = this.selectionCb;
    if (!cb) return;
    const cell = this.cellTarget();
    if (cell) {
      const sel = window.getSelection();
      if (cell.collapsed || cell.spansCells || !sel || sel.rangeCount === 0) {
        cb(null);
        return;
      }
      cb({
        rect: sel.getRangeAt(0).getBoundingClientRect(),
        marks: {
          strong: rangeHasMark(cell.inline, cell.start, cell.end, 'strong'),
          em: rangeHasMark(cell.inline, cell.start, cell.end, 'em'),
          code: rangeHasMark(cell.inline, cell.start, cell.end, 'code'),
          link: rangeHasLink(cell.inline, cell.start, cell.end)
        }
      });
      return;
    }
    // Use the same multi-leaf resolution as the mark commands so the bubble shows
    // for a whole-block or multi-block selection (not only a single partial run),
    // with the mark active-state aggregated across every covered leaf.
    const leaves = this.selectedLeaves();
    const sel = window.getSelection();
    if (leaves.length === 0 || !sel || sel.rangeCount === 0) {
      cb(null);
      return;
    }
    const every = (mark: BooleanMark): boolean =>
      leaves.every((l) => rangeHasMark(l.leaf.inline, l.start, l.end, mark));
    const single = leaves.length === 1 ? leaves[0] : null;
    cb({
      rect: sel.getRangeAt(0).getBoundingClientRect(),
      marks: {
        strong: every('strong'),
        em: every('em'),
        code: every('code'),
        // A link can only target one block; only offer it for a single-leaf selection.
        link: single ? rangeHasLink(single.leaf.inline, single.start, single.end) : false
      }
    });
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
      // Enter is handled in keydown; swallow any native paragraph so it can't
      // produce a second line break.
      e.preventDefault();
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
    const blockEl = focusedLeafElement(this.container);
    if (!blockEl) return;
    const id = blockEl.getAttribute(BLOCK_ID_ATTR);
    if (id == null) return;
    const leaf = findBlockById(this.doc.blocks, id);
    if (!leaf || !isInlineText(leaf)) return;
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, id, (b) => ({ ...b, inline: readInlineFromDOM(blockEl), dirty: true }) as BlockNode) };
    this.scheduleSerialize();
  };

  private applyInsertText(text: string): void {
    const cell = this.cellTarget();
    if (cell) {
      if (cell.spansCells) return;
      if (cell.collapsed && this.surgicalInsert(text)) {
        this.updateCellModel(cell, insertTextInInline(cell.inline, cell.start, text));
      } else {
        let inline = cell.inline;
        if (!cell.collapsed) inline = deleteRangeInInline(inline, cell.start, cell.end);
        this.commitCell(cell, insertTextInInline(inline, cell.start, text), cell.start + text.length);
      }
      this.scheduleSerialize();
      return;
    }
    const t = this.leafTarget();
    if (!t || t.spansBlocks) return;
    if (t.leaf.type === 'code_block') {
      this.editCodeText(t.leaf, t.blockEl, t.leaf.text.slice(0, t.start) + text + t.leaf.text.slice(t.end), t.start + text.length);
      this.scheduleSerialize();
      return;
    }
    if (!isInlineText(t.leaf)) return;

    // Surgical fast path: insert into the live text node in place. Falls back to a
    // full block re-render only when there is a selection to replace or the caret
    // is not in a text node.
    if (t.collapsed && this.surgicalInsert(text)) {
      const inline = insertTextInInline(t.leaf.inline, t.start, text);
      this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, t.leaf.id, (b) => ({ ...b, inline, dirty: true }) as BlockNode) };
    } else {
      let inline = t.leaf.inline;
      if (!t.collapsed) inline = deleteRangeInInline(inline, t.start, t.end);
      inline = insertTextInInline(inline, t.start, text);
      this.commitInline(t.leaf.id, inline, t.blockEl, t.start + text.length);
    }
    this.scheduleSerialize();
    // A typed space at the start of a paragraph may fire a list input rule (the
    // marker is consumed, never persisted as syntax). It owns the rest of the
    // gesture, so skip slash handling when it fires.
    if (text === ' ' && this.tryListInputRule()) return;
    this.handleSlashAfterInsert(text);
  }

  private applyDeleteBackward(): void {
    const cell = this.cellTarget();
    if (cell) {
      if (cell.spansCells || (cell.collapsed && cell.start === 0)) return; // no merge across cells
      if (cell.collapsed && this.surgicalDeleteBack()) {
        this.updateCellModel(cell, deleteRangeInInline(cell.inline, cell.start - 1, cell.start));
      } else {
        const from = cell.collapsed ? cell.start - 1 : cell.start;
        const to = cell.collapsed ? cell.start : cell.end;
        this.commitCell(cell, deleteRangeInInline(cell.inline, from, to), from);
      }
      this.scheduleSerialize();
      return;
    }
    const t = this.leafTarget();
    if (!t || t.spansBlocks) return;

    if (t.collapsed && t.start === 0) {
      // Boundary: top-level inline-text merge only in 3e; nested merge / exit is 3f.
      if (isInlineText(t.leaf) && this.isTopLevel(t.blockEl, t.leaf.id)) {
        const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
        if (index >= 0) this.mergeWithPrevious(index, t.blockEl);
      }
      this.closeSlash();
      return;
    }

    const from = t.collapsed ? t.start - 1 : t.start;
    const to = t.collapsed ? t.start : t.end;
    if (t.leaf.type === 'code_block') {
      this.editCodeText(t.leaf, t.blockEl, t.leaf.text.slice(0, from) + t.leaf.text.slice(to), from);
      this.scheduleSerialize();
      return;
    }
    if (!isInlineText(t.leaf)) return;

    // Surgical fast path for a within-text-node backspace; full re-render only for
    // a selection delete or a caret at a text-node boundary.
    if (t.collapsed && this.surgicalDeleteBack()) {
      const inline = deleteRangeInInline(t.leaf.inline, from, to);
      this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, t.leaf.id, (b) => ({ ...b, inline, dirty: true }) as BlockNode) };
    } else {
      this.commitInline(t.leaf.id, deleteRangeInInline(t.leaf.inline, from, to), t.blockEl, from);
    }
    this.scheduleSerialize();
    this.refreshSlash();
  }

  private applyDeleteForward(): void {
    const cell = this.cellTarget();
    if (cell) {
      const cellLen = inlineLength(cell.inline);
      if (cell.spansCells || (cell.collapsed && cell.start >= cellLen)) return;
      const from = cell.start;
      const to = cell.collapsed ? cell.start + 1 : cell.end;
      this.commitCell(cell, deleteRangeInInline(cell.inline, from, to), from);
      this.scheduleSerialize();
      return;
    }
    const t = this.leafTarget();
    if (!t || t.spansBlocks) return;
    const len = t.leaf.type === 'code_block' ? t.leaf.text.length : isInlineText(t.leaf) ? inlineLength(t.leaf.inline) : 0;

    if (t.collapsed && t.start >= len) {
      if (isInlineText(t.leaf) && this.isTopLevel(t.blockEl, t.leaf.id)) {
        const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
        if (index >= 0) this.mergeWithNext(index, t.blockEl);
      }
      return;
    }

    const from = t.start;
    const to = t.collapsed ? t.start + 1 : t.end;
    if (t.leaf.type === 'code_block') {
      this.editCodeText(t.leaf, t.blockEl, t.leaf.text.slice(0, from) + t.leaf.text.slice(to), from);
      this.scheduleSerialize();
      return;
    }
    if (!isInlineText(t.leaf)) return;
    this.commitInline(t.leaf.id, deleteRangeInInline(t.leaf.inline, from, to), t.blockEl, from);
    this.scheduleSerialize();
  }

  // Enter: in a code block, insert a newline. Otherwise split the block — but in
  // Stage 3e only at top level (nested split / list-item Enter is 3f); the
  // original keeps its id and first half, the new block mints an id (split mints).
  private applyEnter(): void {
    const t = this.leafTarget();
    if (!t || t.spansBlocks) return;
    if (t.leaf.type === 'code_block') {
      this.editCodeText(t.leaf, t.blockEl, t.leaf.text.slice(0, t.start) + '\n' + t.leaf.text.slice(t.end), t.start + 1);
      this.scheduleSerialize();
      return;
    }
    // Enter inside a container: split into a new list item / quote paragraph, or
    // exit the container when the block is empty.
    if (isInlineText(t.leaf) && !this.isTopLevel(t.blockEl, t.leaf.id)) {
      const result =
        inlineLength(t.leaf.inline) === 0
          ? exitContainer(this.doc.blocks, t.leaf.id, generateBlockId)
          : enterInContainer(this.doc.blocks, t.leaf.id, t.start, generateBlockId);
      if (result) this.applyStructural(result);
      return;
    }
    if (!isInlineText(t.leaf) || !this.isTopLevel(t.blockEl, t.leaf.id)) return;
    const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
    if (index < 0) return;

    let inline = t.leaf.inline;
    if (!t.collapsed) inline = deleteRangeInInline(inline, t.start, t.end);
    const [left, right] = splitInline(inline, t.start);

    const leftBlock: BlockNode = { ...t.leaf, inline: left, dirty: true };
    const level = t.leaf.type === 'heading' ? t.leaf.level : 1;
    const rightBlock = this.newInlineBlock(t.leaf.type, right, level);

    const blocks = this.doc.blocks.slice();
    blocks.splice(index, 1, leftBlock, rightBlock);
    this.doc = { ...this.doc, blocks };

    renderInlineInto(t.blockEl, left);
    const rightEl = renderBlock(rightBlock);
    t.blockEl.after(rightEl);
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

  // The focused editable leaf (inline-text or code), which may be nested inside a
  // container. The editing hot path targets this; structural ops still target the
  // top-level block (see isTopLevel).
  private leafTarget(): {
    leaf: BlockNode;
    blockEl: HTMLElement;
    start: number;
    end: number;
    collapsed: boolean;
    spansBlocks: boolean;
  } | null {
    const ctx = leafCaretContext(this.container);
    if (!ctx) return null;
    const id = ctx.blockEl.getAttribute(BLOCK_ID_ATTR);
    if (id == null) return null;
    const leaf = findBlockById(this.doc.blocks, id);
    if (!leaf) return null;
    return { leaf, blockEl: ctx.blockEl, start: ctx.start, end: ctx.end, collapsed: ctx.collapsed, spansBlocks: ctx.spansBlocks };
  }

  // The focused table cell, addressed by (table id, row, col). Cells are inline
  // regions, not blocks, so they get their own target type parallel to leafTarget.
  private cellTarget(): {
    tableId: string;
    row: number;
    col: number;
    cellEl: HTMLElement;
    inline: InlineNode[];
    start: number;
    end: number;
    collapsed: boolean;
    spansCells: boolean;
  } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node: Node | null = sel.getRangeAt(0).startContainer;
    let cellEl: HTMLElement | null = null;
    while (node && node !== this.container) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.cellRow != null) {
        cellEl = node as HTMLElement;
        break;
      }
      node = node.parentNode;
    }
    if (!cellEl) return null;
    const tableEl = cellEl.closest(`[${BLOCK_ID_ATTR}]`) as HTMLElement | null;
    const tableId = tableEl?.getAttribute(BLOCK_ID_ATTR);
    if (!tableId) return null;
    const table = findBlockById(this.doc.blocks, tableId);
    if (!table || table.type !== 'table') return null;
    const row = Number(cellEl.dataset.cellRow);
    const col = Number(cellEl.dataset.cellCol);
    const inline = table.rows[row]?.[col] ?? [];
    const range = sel.getRangeAt(0);
    const start = flatOffsetFromDOM(cellEl, range.startContainer, range.startOffset);
    const collapsed = range.collapsed;
    const endInCell = cellEl.contains(range.endContainer);
    const end = collapsed || !endInCell ? start : flatOffsetFromDOM(cellEl, range.endContainer, range.endOffset);
    return { tableId, row, col, cellEl, inline, start, end, collapsed, spansCells: !endInCell };
  }

  private updateCellModel(c: { tableId: string; row: number; col: number }, inline: InlineNode[]): void {
    this.doc = {
      ...this.doc,
      blocks: updateBlockById(this.doc.blocks, c.tableId, (b) => {
        if (b.type !== 'table') return b;
        const rows = b.rows.map((r, ri) => (ri === c.row ? r.map((cell, ci) => (ci === c.col ? inline : cell)) : r));
        return { ...b, rows, dirty: true };
      })
    };
  }

  private commitCell(c: { tableId: string; row: number; col: number; cellEl: HTMLElement }, inline: InlineNode[], caret: number): void {
    this.updateCellModel(c, inline);
    renderInlineInto(c.cellEl, inline);
    setCaret(c.cellEl, caret);
  }

  // Surgical DOM edits for the common case: a collapsed caret inside a text node.
  // Insert/delete in place rather than rebuilding the block's DOM, so typing is
  // native-smooth and the selection is never disturbed. Return false to let the
  // caller fall back to a full re-render (selection replace, caret on an element).
  private surgicalInsert(text: string): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const tn = range.startContainer as Text;
    const off = range.startOffset;
    tn.insertData(off, text);
    sel.collapse(tn, off + text.length);
    return true;
  }

  private surgicalDeleteBack(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE || range.startOffset === 0) return false;
    const tn = range.startContainer as Text;
    const off = range.startOffset;
    tn.deleteData(off - 1, 1);
    sel.collapse(tn, off - 1);
    return true;
  }

  // Move the caret to the next/previous cell in row-major order. Off the ends it
  // stops (row/column insertion is a later refinement).
  private moveCell(cell: { tableId: string; row: number; col: number }, dir: 1 | -1): void {
    const table = findBlockById(this.doc.blocks, cell.tableId);
    if (!table || table.type !== 'table') return;
    const cols = table.rows[0]?.length ?? 0;
    if (cols === 0) return;
    const flat = cell.row * cols + cell.col + dir;
    if (flat < 0 || flat >= table.rows.length * cols) return;
    const nr = Math.floor(flat / cols);
    const nc = flat % cols;
    const tableEl = this.leafElementById(cell.tableId);
    const target = tableEl?.querySelector(`[data-cell-row="${nr}"][data-cell-col="${nc}"]`) as HTMLElement | null;
    if (target) setCaret(target, 0);
  }

  private leafElementById(id: string): HTMLElement | null {
    return this.registry.get(id) ?? (this.container.querySelector(`[${BLOCK_ID_ATTR}="${id}"]`) as HTMLElement | null);
  }

  private isTopLevel(blockEl: HTMLElement, id: string): boolean {
    return this.registry.get(id) === blockEl;
  }

  // Replace a (possibly nested) block's inline content, re-render that one block,
  // and place the caret. updateBlockById marks the block and its ancestors dirty.
  private commitInline(id: string, inline: InlineNode[], blockEl: HTMLElement, caret: number): void {
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, id, (b) => ({ ...b, inline, dirty: true }) as BlockNode) };
    renderInlineInto(blockEl, inline);
    setCaret(blockEl, caret);
  }

  // Replace a code block's text, re-render its <code> child, and place the caret.
  private editCodeText(leaf: BlockNode, blockEl: HTMLElement, next: string, caret: number): void {
    if (leaf.type !== 'code_block') return;
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, leaf.id, (b) => ({ ...b, text: next, dirty: true }) as BlockNode) };
    const code = blockEl.querySelector('code') ?? blockEl;
    code.textContent = next;
    setCaret(blockEl, caret);
  }

  // Apply a structural result (Enter/exit inside a container): swap in the new
  // tree, reconcile the top-level DOM, and place the caret at the new leaf.
  private applyStructural(result: StructuralResult): void {
    this.doc = { ...this.doc, blocks: result.blocks };
    this.reconcile();
    const el = this.container.querySelector(`[${BLOCK_ID_ATTR}="${result.caret.id}"]`) as HTMLElement | null;
    if (el) setCaret(el, result.caret.offset);
    this.scheduleSerialize();
  }

  // Incremental top-level render: bring the container's direct children in line
  // with this.doc.blocks, reusing the element for an unchanged block (same object)
  // and re-rendering one whose block object changed. Add/remove/reorder by id.
  // Runs on structural ops only — never on the typing hot path.
  private reconcile(): void {
    const parent = this.container;
    const have = new Map<string, HTMLElement>();
    for (const child of Array.from(parent.children)) {
      const id = (child as HTMLElement).getAttribute(BLOCK_ID_ATTR);
      if (id) have.set(id, child as HTMLElement);
    }

    let i = 0;
    for (const block of this.doc.blocks) {
      let el = have.get(block.id);
      if (!el || this.renderedFrom.get(block.id) !== block) {
        const fresh = renderBlock(block);
        this.registry.set(block.id, fresh);
        if (el) el.replaceWith(fresh);
        el = fresh;
      }
      this.renderedFrom.set(block.id, block);
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
      have.delete(block.id);
      i++;
    }

    for (const [id, el] of have) {
      el.remove();
      this.registry.delete(id);
      this.renderedFrom.delete(id);
    }
  }

  private scheduleSerialize(): void {
    if (!this.onDocChange) return;
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      // Run the cold path (serialize + store write + lint + app re-render) during
      // an idle gap so it never lands between keystrokes — the "type 3, pause,
      // 4th" hitch. flush() (Cmd-S / quit) still runs it synchronously.
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback;
      if (typeof ric === 'function') ric(() => this.onDocChange?.(this.doc), { timeout: 1000 });
      else this.onDocChange?.(this.doc);
    }, SERIALIZE_DEBOUNCE_MS);
  }
}

export type { InlineNode };
