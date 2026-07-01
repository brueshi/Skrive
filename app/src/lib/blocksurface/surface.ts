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

import { generateBlockId, parseDocument, serializeDocument, type BlockNode, type Document, type InlineNode, type TableBlock } from '../blockmodel';
import { markdownForPaste } from '../clipboard/htmlToMarkdown';
import { plainTextParagraphs } from '../clipboard/plainText';
import { buildClipboardPayload } from '../clipboard/copyOut';
import { BLOCK_ID_ATTR, BlockViewRegistry, renderBlock, renderDocument, renderInlineInto } from './render';
import { caretContext, flatOffsetFromDOM, focusedLeafElement, leafCaretContext, readSelection, setCaret, setCrossBlockSelection, setSelectionRange, writeSelection } from './selection';
import { collapsedRange, isCollapsed, sameLeaf, type DocPos, type DocRange } from './doc-position';
import { deleteAcross, deleteBlock, documentLeaves, mergeBackward, mergeForward, replaceAcross } from './range-ops';
import { findBlockById, updateBlockById } from './tree';
import { enterInContainer, exitContainer, type StructuralResult } from './structural';
import { changeListType, findImmediateList, indentItem, liftItemToParagraph, outdentItem } from './list-ops';
import {
  type BooleanMark,
  deleteRangeInInline,
  inlineLength,
  inlinePlainText,
  insertTextInInline,
  linkHrefInRange,
  rangeHasLink,
  rangeHasMark,
  readInlineFromDOM,
  setLinkInInline,
  setMarkInInline,
  splitInline,
  toggleMarkInInline
} from './inline-ops';
import { DocHistory, type EditKind } from './history';

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

/** The current selection's formatting context, emitted on every selection change
 *  (rAF-coalesced, never per keystroke). Drives both the fixed toolbar (always
 *  visible, reads block type + container flags) and the floating bubble (shows
 *  only when `empty` is false). `rect` is the selection's bounding box for a
 *  range, or the caret box when collapsed. Null only when focus is outside the
 *  surface entirely. */
export type SelectionInfo = {
  rect: DOMRect;
  /** True when there is no range to format (collapsed caret, or crossing blocks). */
  empty: boolean;
  marks: { strong: boolean; em: boolean; code: boolean; link: boolean };
  /** The href shared across the selection, when it is uniformly one link. */
  linkHref: string | null;
  /** The focused leaf's block type, for the "Turn into" control. */
  blockType: 'paragraph' | 'heading' | 'code_block' | 'table' | 'other';
  headingLevel: number | null;
  inBulletList: boolean;
  inOrderedList: boolean;
  inBlockquote: boolean;
  inTable: boolean;
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
  // Authoritative document. Assigned through the `doc` setter everywhere except
  // the constructor and undo/redo, so every edit funnels one history snapshot.
  private _doc: Document;
  private readonly history = new DocHistory();
  // Hint the setter reads for the next snapshot's edit kind, then resets. Typing
  // and delete set it so consecutive ones coalesce; everything else is its own
  // undo step.
  private nextEditKind: EditKind = 'other';
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
    this._doc = opts.doc; // bypass the setter: initial load is not an undoable edit
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
    this.container.addEventListener('copy', this.onCopy, { capture: true });
    this.container.addEventListener('cut', this.onCut, { capture: true });
    this.container.addEventListener('compositionstart', this.onCompositionStart, true);
    this.container.addEventListener('compositionend', this.onCompositionEnd, true);
    this.container.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('selectionchange', this.onDocSelectionChange);
  }

  // The document. Reads are plain; every assignment records a pre-edit snapshot
  // for undo (using nextEditKind for coalescing) before swapping in the new doc.
  // Reading the selection is deferred to the moment a snapshot is actually
  // pushed, so coalesced keystrokes never touch the DOM on the hot path.
  private get doc(): Document {
    return this._doc;
  }
  private set doc(next: Document) {
    this.history.record(
      this._doc,
      () => readSelection(this.container),
      this.nextEditKind,
      performance.now()
    );
    this.nextEditKind = 'other';
    this._doc = next;
  }

  /** Undo the last edit (Cmd/Ctrl+Z). Restores the prior document and selection,
   *  bypassing the setter so the restore isn't itself recorded. */
  undo(): void {
    const restored = this.history.undo({ doc: this._doc, sel: readSelection(this.container) });
    if (!restored) return;
    this._doc = restored.doc;
    this.reconcile();
    if (restored.sel) writeSelection(this.container, restored.sel, 'undo');
    this.scheduleSerialize();
  }

  /** Redo the last undone edit (Cmd/Ctrl+Shift+Z / Cmd+Y). */
  redo(): void {
    const restored = this.history.redo({ doc: this._doc, sel: readSelection(this.container) });
    if (!restored) return;
    this._doc = restored.doc;
    this.reconcile();
    if (restored.sel) writeSelection(this.container, restored.sel, 'redo');
    this.scheduleSerialize();
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

  /** The current selection's formatting summary, for an on-demand read (e.g. a
   *  controller priming its snapshot). Null when focus is outside the surface. */
  getSelectionInfo(): SelectionInfo | null {
    return this.selectionSummary();
  }

  /** Return focus to the editing surface (after a menu action that moved focus). */
  focus(): void {
    this.container.focus();
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
    this.container.removeEventListener('copy', this.onCopy, true);
    this.container.removeEventListener('cut', this.onCut, true);
    this.container.removeEventListener('compositionstart', this.onCompositionStart, true);
    this.container.removeEventListener('compositionend', this.onCompositionEnd, true);
    this.container.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('selectionchange', this.onDocSelectionChange);
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
  }

  // --- marks: keyboard shortcuts + commands --------------------------------

  private onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    // Cmd/Ctrl+Shift+V = paste literally (escape hatch for prose with incidental
    // * - # that would otherwise be read as Markdown). The native shell doesn't
    // issue a paste event for this chord, so we read the clipboard ourselves and
    // insert it as plain text. preventDefault stops any native default.
    if (e.code === 'KeyV' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.pasteLiteralFromClipboard();
      return;
    }
    // Undo / redo (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, and Ctrl+Y on Windows). The
    // surface owns history; native contenteditable undo mutates the DOM behind
    // the model, so we claim the chord and drive our own stack.
    if (e.code === 'KeyZ' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (e.code === 'KeyY' && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.redo();
      return;
    }
    // Tab moves between table cells (no modifier); in a list item it nests
    // (Shift+Tab outdents). Outside a table or list, Tab keeps its native focus
    // behaviour (the early return below without preventDefault).
    if (e.key === 'Tab') {
      const cell = this.cellTarget();
      if (cell) {
        e.preventDefault();
        // Tab steps cell-to-cell; off the last/first cell it exits the table
        // (instead of dead-ending) so the table is never a one-way trap.
        if (!this.moveCell(cell, e.shiftKey ? -1 : 1)) {
          this.exitTable(cell.tableId, e.shiftKey ? 'before' : 'after');
        }
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
    // Arrow keys inside a table: navigate cell-to-cell and, at the table's edges,
    // step the caret OUT to the adjacent block (the native contenteditable caret
    // can't reliably leave a <table>, worst of all when the table is the last
    // block). Outside a table — or mid-cell — fall through to native movement.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (this.handleTableArrow(e)) e.preventDefault();
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

  /** Remember the current selection so a link can be applied to it after focus
   *  moves to a URL input (which would otherwise collapse the live selection).
   *  Returns false when there is no within-block selection to link. */
  beginLink(): boolean {
    const t = this.leafTarget();
    if (!t || t.collapsed || t.spansBlocks || !isInlineText(t.leaf)) return false;
    this.savedLink = { blockId: t.leaf.id, start: t.start, end: t.end };
    return true;
  }

  /** Apply a link over the selection saved by beginLink. */
  commitLink(href: string): void {
    if (href.length > 0) this.applySavedLink({ href, title: null });
    this.savedLink = null;
  }

  /** Remove any link over the selection saved by beginLink. */
  removeLink(): void {
    this.applySavedLink(null);
    this.savedLink = null;
  }

  /** Discard the saved selection without touching the document (Escape / click-out). */
  cancelLink(): void {
    this.savedLink = null;
  }

  private applySavedLink(link: { href: string; title: string | null } | null): void {
    const saved = this.savedLink;
    if (!saved) return;
    const block = findBlockById(this.doc.blocks, saved.blockId);
    if (!block || !isInlineText(block)) return;
    const inline = setLinkInInline(block.inline, saved.start, saved.end, link);
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
    cb(this.selectionSummary());
  }

  /** Build the current selection's formatting summary, or null when focus is
   *  outside the surface. Always returns a summary while the caret is in the
   *  surface (even collapsed) so the fixed toolbar can reflect the current block;
   *  the bubble keys its visibility off `empty`. */
  private selectionSummary(): SelectionInfo | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!this.container.contains(range.startContainer)) return null;
    const rect = range.getBoundingClientRect();

    const cell = this.cellTarget();
    if (cell) {
      const empty = cell.collapsed || cell.spansCells;
      return {
        rect,
        empty,
        marks: {
          strong: !empty && rangeHasMark(cell.inline, cell.start, cell.end, 'strong'),
          em: !empty && rangeHasMark(cell.inline, cell.start, cell.end, 'em'),
          code: !empty && rangeHasMark(cell.inline, cell.start, cell.end, 'code'),
          link: !empty && rangeHasLink(cell.inline, cell.start, cell.end)
        },
        linkHref: empty ? null : linkHrefInRange(cell.inline, cell.start, cell.end),
        blockType: 'table',
        headingLevel: null,
        inBulletList: false,
        inOrderedList: false,
        inBlockquote: false,
        inTable: true
      };
    }

    // The block-type / container context comes from the focused leaf; the marks
    // come from the multi-leaf resolution the commands use, so the summary agrees
    // with what a toggle would do over the same selection.
    const leaf = this.leafTarget();
    const flags = leaf ? this.containerFlags(leaf.leaf.id) : null;
    const blockType =
      leaf?.leaf.type === 'heading'
        ? 'heading'
        : leaf?.leaf.type === 'code_block'
          ? 'code_block'
          : leaf?.leaf.type === 'paragraph'
            ? 'paragraph'
            : 'other';
    const headingLevel = leaf?.leaf.type === 'heading' ? leaf.leaf.level : null;

    const leaves = this.selectedLeaves();
    const empty = leaves.length === 0;
    const every = (mark: BooleanMark): boolean =>
      !empty && leaves.every((l) => rangeHasMark(l.leaf.inline, l.start, l.end, mark));
    // A link can only target one block; only offer it for a single-leaf selection.
    const single = leaves.length === 1 ? leaves[0] : null;
    return {
      rect,
      empty,
      marks: {
        strong: every('strong'),
        em: every('em'),
        code: every('code'),
        link: single ? rangeHasLink(single.leaf.inline, single.start, single.end) : false
      },
      linkHref: single ? linkHrefInRange(single.leaf.inline, single.start, single.end) : null,
      blockType,
      headingLevel,
      inBulletList: flags?.inBulletList ?? false,
      inOrderedList: flags?.inOrderedList ?? false,
      inBlockquote: flags?.inBlockquote ?? false,
      inTable: false
    };
  }

  /** Which container types the leaf is nested inside, walking its ancestry. */
  private containerFlags(leafId: string): {
    inBulletList: boolean;
    inOrderedList: boolean;
    inBlockquote: boolean;
  } {
    const walk = (
      nodes: BlockNode[],
      acc: { inBulletList: boolean; inOrderedList: boolean; inBlockquote: boolean }
    ): typeof acc | null => {
      for (const b of nodes) {
        if (b.id === leafId) return acc;
        if (b.type === 'blockquote') {
          const r = walk(b.children, { ...acc, inBlockquote: true });
          if (r) return r;
        } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
          const bullet = b.type === 'bullet_list';
          for (const item of b.items) {
            const r = walk(item.children, {
              inBulletList: acc.inBulletList || bullet,
              inOrderedList: acc.inOrderedList || !bullet,
              inBlockquote: acc.inBlockquote
            });
            if (r) return r;
          }
        }
      }
      return null;
    };
    return walk(this.doc.blocks, { inBulletList: false, inOrderedList: false, inBlockquote: false }) ?? {
      inBulletList: false,
      inOrderedList: false,
      inBlockquote: false
    };
  }

  // --- the hot path --------------------------------------------------------

  private onBeforeInput = (event: Event): void => {
    if (this.composing) return; // IME composes natively; reconcile on end
    const e = event as InputEvent;
    const type = e.inputType;
    if (type === 'historyUndo' || type === 'historyRedo') {
      // Backstop for any native undo path (the Edit menu, trackpad gestures):
      // drive our own history so the DOM never diverges from the model.
      e.preventDefault();
      if (type === 'historyUndo') this.undo();
      else this.redo();
    } else if (type === 'insertText' && typeof e.data === 'string') {
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

  // Paste-in interpretation (SKR-119). Rich sources (web pages, Notion, Obsidian
  // reading view) carry `text/html`; we convert it to canonical Markdown and parse
  // that into real blocks. Plain Markdown sources (Obsidian source mode, editors,
  // terminals) carry only `text/plain`, which we also parse as Markdown — the full
  // round trip. Cmd/Ctrl+Shift+V opts out, landing the clipboard verbatim.
  private onPaste = (event: Event): void => {
    const e = event as ClipboardEvent;
    const data = e.clipboardData;
    if (!data) return;
    const plain = data.getData('text/plain');
    const html = data.getData('text/html');

    // Rich HTML wins; fall back to interpreting plain text as Markdown.
    const fromHtml = html ? markdownForPaste(html) : null;
    const markdown = fromHtml ?? (plain && plain.length > 0 ? plain : null);
    if (markdown == null) return;
    e.preventDefault();
    // Block insert only lands at a collapsed caret in a top-level inline leaf.
    // Anywhere else (nested list/quote, code, table cell, or a selection) falls
    // back to the plain split-paste for v1 — see SKR-119 scope.
    if (!this.insertMarkdownBlocks(markdown)) {
      this.pasteText(plain && plain.length > 0 ? plain : markdown, 'flow');
    }
  };

  // Cmd/Ctrl+Shift+V handler: read the OS clipboard's plain text (via the shell
  // bridge, falling back to the async Clipboard API) and insert it literally,
  // bypassing Markdown interpretation.
  private async pasteLiteralFromClipboard(): Promise<void> {
    let text = '';
    try {
      const bridge = (window as unknown as {
        skrive?: { clipboard?: { readText?: () => Promise<string> } };
      }).skrive;
      if (bridge?.clipboard?.readText) text = await bridge.clipboard.readText();
      else if (navigator.clipboard?.readText) text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (text.length > 0) this.pasteText(text, 'literal');
  }

  // Copy / cut (SKR-127). Both serialize the selection to clean Markdown and
  // dual-write it (matching paste-in and the Copy page button), so a round trip
  // through the clipboard stays canonical instead of dragging the rendered DOM.
  // Cut then deletes the selected range. Collapsed selections are left to the
  // browser (nothing to copy).
  private onCopy = (event: Event): void => {
    this.writeSelectionToClipboard(event as ClipboardEvent);
  };

  private onCut = (event: Event): void => {
    if (this.writeSelectionToClipboard(event as ClipboardEvent)) this.deleteSelection();
  };

  // Write the current selection to the clipboard as Markdown (text/plain) + its
  // rendered HTML (text/html). Returns false (declining the event) when there's
  // nothing to copy. Selections bounded by a barrier (code block / table cell)
  // can't serialize to Markdown cleanly, so they fall back to the visible text.
  private writeSelectionToClipboard(e: ClipboardEvent): boolean {
    const data = e.clipboardData;
    if (!data) return false;
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return false;
    const md = this.serializeSelectionMarkdown(range);
    if (md != null && md !== '') {
      const { text, html } = buildClipboardPayload(md);
      data.setData('text/plain', text);
      data.setData('text/html', html);
    } else {
      const text = window.getSelection()?.toString() ?? '';
      if (text === '') return false;
      data.setData('text/plain', text);
    }
    e.preventDefault();
    return true;
  }

  // Serialize just the selected range to Markdown by deleting everything before
  // and after it from a copy of the document, then serializing what remains.
  // Reuses deleteAcross (which already handles nested and multi-block ranges);
  // null when an endpoint isn't an inline leaf, so the caller falls back to text.
  private serializeSelectionMarkdown(range: DocRange): string | null {
    const [start, end] = this.orderRange(range);
    if (start.leaf.kind !== 'block' || end.leaf.kind !== 'block') return null;

    // Selection within a single block: emit just the inline slice, not the
    // block's Markdown. Selecting a word inside a heading must copy the word
    // (with any real marks), not `# word` — the `#` is the block's, not the text's.
    if (start.leaf.id === end.leaf.id) {
      const block = findBlockById(this.doc.blocks, start.leaf.id);
      if (block && (block.type === 'paragraph' || block.type === 'heading')) {
        const sliced = splitInline(splitInline(block.inline, end.offset)[0], start.offset)[1];
        const para: BlockNode = {
          type: 'paragraph',
          id: generateBlockId(),
          durable: false,
          src: null,
          gapBefore: null,
          dirty: true,
          inline: sliced
        };
        return serializeDocument({ blocks: [para], trailingGap: '' });
      }
      if (block && block.type === 'code_block') {
        return block.text.slice(start.offset, end.offset);
      }
    }

    const inlineLeaves = documentLeaves(this.doc.blocks).filter((l) => l.kind === 'inline');
    if (inlineLeaves.length === 0) return null;
    const firstId = inlineLeaves[0]!.id;
    const lastId = inlineLeaves[inlineLeaves.length - 1]!.id;
    const lastBlock = findBlockById(this.doc.blocks, lastId);
    const lastLen =
      lastBlock && (lastBlock.type === 'paragraph' || lastBlock.type === 'heading')
        ? inlineLength(lastBlock.inline)
        : 0;
    const afterTrimmed = deleteAcross(this.doc.blocks, end.leaf.id, end.offset, lastId, lastLen);
    if (!afterTrimmed) return null;
    const sliced = deleteAcross(afterTrimmed.blocks, firstId, 0, start.leaf.id, start.offset);
    if (!sliced) return null;
    return serializeDocument({ blocks: sliced.blocks, trailingGap: '' });
  }

  // Delete the current selection (the cut path). Mirrors a Backspace over a
  // selection; a discrete undo step.
  private deleteSelection(): void {
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return;
    const [start, end] = this.orderRange(range);
    if (start.leaf.kind !== 'block' || end.leaf.kind !== 'block') return;
    const r = deleteAcross(this.doc.blocks, start.leaf.id, start.offset, end.leaf.id, end.offset);
    if (r) this.applyStructural(r);
  }

  // Order a selection's endpoints into document order (start before end).
  private orderRange(range: DocRange): [DocPos, DocPos] {
    const leaves = documentLeaves(this.doc.blocks);
    const indexOf = (p: DocPos): number => {
      if (p.leaf.kind !== 'block') return -1;
      const id = p.leaf.id;
      return leaves.findIndex((l) => l.id === id);
    };
    const ai = indexOf(range.anchor);
    const fi = indexOf(range.focus);
    if (ai !== fi) return ai <= fi ? [range.anchor, range.focus] : [range.focus, range.anchor];
    return range.anchor.offset <= range.focus.offset
      ? [range.anchor, range.focus]
      : [range.focus, range.anchor];
  }

  // Parse `md` into blocks and insert them at a collapsed caret in a top-level
  // inline-text block. Returns false (declining) when the caret isn't such a spot,
  // or the parse yields nothing, so the caller can fall back to a plain paste.
  //
  // Placement (SKR-119): a lone paragraph merges inline into the caret block,
  // carrying its marks — seamless, like typing it. Anything structured or
  // multi-block splits the caret block: head keeps the text before the caret,
  // the pasted blocks land between, and the tail continues after. An empty caret
  // block is fully replaced.
  private insertMarkdownBlocks(md: string): boolean {
    const parsed = parseDocument(md).blocks;
    if (parsed.length === 0) return false;

    const t = this.leafTarget();
    // No caret in the surface (unfocused, or a selection that doesn't resolve to a
    // leaf — easy to hit when focus is elsewhere): append at the document end so a
    // paste never silently vanishes, rather than declining to a fallback that also
    // needs a caret.
    if (!t) {
      this.appendMarkdownBlocks(parsed);
      return true;
    }
    // A caret that isn't a collapsed, top-level inline leaf (nested list/quote,
    // code, table cell, or a selection) falls back to the plain paste path, which
    // handles those in place — see SKR-119 scope.
    if (!t.collapsed || !isInlineText(t.leaf) || !this.isTopLevel(t.blockEl, t.leaf.id)) {
      return false;
    }
    const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
    if (index < 0) return false;

    const [head, tail] = splitInline(t.leaf.inline, t.start);

    // Seamless single-paragraph merge.
    const only = parsed[0]!;
    if (parsed.length === 1 && only.type === 'paragraph') {
      const merged: BlockNode = { ...t.leaf, inline: [...head, ...only.inline, ...tail], dirty: true };
      this.commitBlock(index, merged);
      this.reconcile();
      const caret = inlineLength(head) + inlineLength(only.inline);
      writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: merged.id }, offset: caret }), 'paste');
      this.scheduleSerialize();
      return true;
    }

    // Structured / multi-block paste: split the caret block around the insertion.
    const headEmpty = inlineLength(head) === 0;
    const tailEmpty = inlineLength(tail) === 0;
    const isHeading = t.leaf.type === 'heading';
    const level = t.leaf.type === 'heading' ? t.leaf.level : 1;
    // Clean seam before the first pasted block; later blocks keep the parsed gaps.
    const inserted = parsed.map((b, i) => (i === 0 ? { ...b, gapBefore: null } : b));

    const out: BlockNode[] = [];
    if (!headEmpty) out.push({ ...t.leaf, inline: head, dirty: true });
    out.push(...inserted);

    let caret: { id: string; offset: number };
    if (!tailEmpty) {
      const tailBlock = this.newInlineBlock(isHeading ? 'heading' : 'paragraph', tail, level);
      out.push(tailBlock);
      caret = { id: tailBlock.id, offset: 0 };
    } else {
      caret = this.caretAfterInserted(out, inserted);
    }

    const blocks = this.doc.blocks.slice();
    blocks.splice(index, 1, ...out);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: caret.id }, offset: caret.offset }), 'paste');
    this.scheduleSerialize();
    return true;
  }

  // Append parsed blocks at the document end and place the caret after them.
  // Used when a paste arrives with no caret target (unfocused surface).
  private appendMarkdownBlocks(parsed: BlockNode[]): void {
    const inserted = parsed.map((b, i) => (i === 0 ? { ...b, gapBefore: null } : b));
    const out: BlockNode[] = [...inserted];
    const caret = this.caretAfterInserted(out, inserted);
    this.doc = { ...this.doc, blocks: [...this.doc.blocks, ...out] };
    this.reconcile();
    this.focus();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: caret.id }, offset: caret.offset }), 'paste');
    this.scheduleSerialize();
  }

  // The caret landing after a run of inserted blocks: the end of the last block
  // when it's inline text, otherwise a fresh trailing paragraph (so the caret
  // never lands on a code/table/rule/list block). Pushes that paragraph onto
  // `out` when it creates one.
  private caretAfterInserted(out: BlockNode[], inserted: BlockNode[]): { id: string; offset: number } {
    const last = inserted[inserted.length - 1]!;
    if (isInlineText(last)) return { id: last.id, offset: inlineLength(last.inline) };
    const landing = this.newInlineBlock('paragraph', [], 1);
    out.push(landing);
    return { id: landing.id, offset: 0 };
  }

  // Paste plain text (SKR-118 Stage 3; segmentation reworked in SKR-148).
  // Interpreted paste ('flow') applies CommonMark paragraph semantics: blank
  // lines separate paragraphs, single newlines flow as spaces, line edges are
  // trimmed. Literal paste ('literal', Cmd/Ctrl+Shift+V) keeps every line as its
  // own paragraph, verbatim — the escape hatch for line-oriented text. A single
  // paragraph's worth goes through the normal insert (which also handles
  // replacing a selection). Multi-paragraph paste is supported at a collapsed
  // caret in a top-level inline leaf: the caret splits the block, the first
  // pasted paragraph joins the head, the last joins the tail, the rest land
  // between. A caret in a container / code / cell falls back to a single-block
  // insert (paragraphs joined by spaces) rather than risk corrupting it —
  // refined later.
  private pasteText(raw: string, mode: 'flow' | 'literal'): void {
    const segments =
      mode === 'literal'
        ? raw.replace(/\r/g, '').split(/\n+/).filter((s) => s.length > 0)
        : plainTextParagraphs(raw);
    if (segments.length <= 1) {
      this.applyInsertText(segments.join(' '));
      return;
    }
    const t = this.leafTarget();
    if (!t || !t.collapsed || !isInlineText(t.leaf) || !this.isTopLevel(t.blockEl, t.leaf.id)) {
      this.applyInsertText(segments.join(' '));
      return;
    }
    const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
    if (index < 0) {
      this.applyInsertText(segments.join(' '));
      return;
    }

    const toInline = (s: string): InlineNode[] => (s ? [{ kind: 'text', text: s, marks: {} }] : []);
    const [head, tail] = splitInline(t.leaf.inline, t.start);
    const firstSeg = segments[0]!;
    const lastSeg = segments[segments.length - 1]!;
    const first: BlockNode = { ...t.leaf, inline: [...head, ...toInline(firstSeg)], dirty: true };
    const middle = segments.slice(1, -1).map((s) => this.newInlineBlock('paragraph', toInline(s), 1));
    const last = this.newInlineBlock('paragraph', [...toInline(lastSeg), ...tail], 1);

    const blocks = this.doc.blocks.slice();
    blocks.splice(index, 1, first, ...middle, last);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: last.id }, offset: lastSeg.length }), 'paste');
    this.scheduleSerialize();
  }

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
    this.nextEditKind = 'type'; // consecutive keystrokes coalesce into one undo
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
    if (!t) return;
    // Typing with a cross-block selection: replace the whole range with the text.
    if (t.spansBlocks) {
      this.replaceSelectionRange(text);
      return;
    }
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
    this.nextEditKind = 'delete'; // consecutive deletes coalesce into one undo
    const cell = this.cellTarget();
    if (cell) {
      // A selection dragged across cells means "delete the whole table" (the
      // select-it-and-hit-Delete gesture); a barrier can't be partial-cut.
      if (cell.spansCells) {
        this.removeTable(cell.tableId);
        return;
      }
      if (cell.collapsed && cell.start === 0) return; // start of cell: no merge back
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
    if (!t) return;
    // A selection spanning blocks: delete the whole range (one primitive).
    if (t.spansBlocks) {
      this.deleteSelectionRange();
      this.closeSlash();
      return;
    }

    if (t.collapsed && t.start === 0) {
      if (isInlineText(t.leaf) && findImmediateList(this.doc.blocks, t.leaf.id)) {
        // Backspace at the start of a list item removes its marker: outdent one
        // level, or lift the item out to a paragraph at the top level.
        this.applyOutdent(t.leaf.id, 0);
      } else if (isInlineText(t.leaf)) {
        // Merge into the previous inline leaf in document order — across a list /
        // quote boundary too (the old merge only joined top-level paragraphs).
        const r = mergeBackward(this.doc.blocks, t.leaf.id);
        if (r) this.applyStructural(r);
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
    this.nextEditKind = 'delete'; // consecutive deletes coalesce into one undo
    const cell = this.cellTarget();
    if (cell) {
      // Cross-cell selection: delete the whole table (mirror of Backspace).
      if (cell.spansCells) {
        this.removeTable(cell.tableId);
        return;
      }
      const cellLen = inlineLength(cell.inline);
      if (cell.collapsed && cell.start >= cellLen) return;
      const from = cell.start;
      const to = cell.collapsed ? cell.start + 1 : cell.end;
      this.commitCell(cell, deleteRangeInInline(cell.inline, from, to), from);
      this.scheduleSerialize();
      return;
    }
    const t = this.leafTarget();
    if (!t) return;
    if (t.spansBlocks) {
      this.deleteSelectionRange();
      return;
    }
    const len = t.leaf.type === 'code_block' ? t.leaf.text.length : isInlineText(t.leaf) ? inlineLength(t.leaf.inline) : 0;

    if (t.collapsed && t.start >= len) {
      if (isInlineText(t.leaf)) {
        // Pull the next inline leaf up into this one (across a container boundary).
        const r = mergeForward(this.doc.blocks, t.leaf.id);
        if (r) this.applyStructural(r);
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
      // Enter on an EMPTY list item outdents one level (or lifts to a paragraph at
      // the top level) — the Google-Docs / Notion "Enter on a blank bullet leaves
      // it" gesture, which also reaches nested items the container exit cannot.
      if (inlineLength(t.leaf.inline) === 0 && findImmediateList(this.doc.blocks, t.leaf.id)) {
        this.applyOutdent(t.leaf.id, 0);
        return;
      }
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

  // Boundary merges (Backspace at a block start, Delete at a block end) and
  // cross-block selection delete / replace all go through the document range ops
  // (range-ops.ts) and applyStructural — one spine, container-aware, instead of
  // the old top-level-only splices.

  // Delete the current cross-block selection as a single range op. Clamps (no-op)
  // when an endpoint is a table cell, or a barrier (table / code) lies in the
  // range — a text range never corrupts one.
  private deleteSelectionRange(): void {
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return;
    if (range.anchor.leaf.kind !== 'block' || range.focus.leaf.kind !== 'block') return;
    if (sameLeaf(range.anchor.leaf, range.focus.leaf)) return; // single leaf: normal path
    const r = deleteAcross(this.doc.blocks, range.anchor.leaf.id, range.anchor.offset, range.focus.leaf.id, range.focus.offset);
    if (r) this.applyStructural(r);
  }

  // Replace the current cross-block selection with typed / pasted text.
  private replaceSelectionRange(text: string): void {
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return;
    if (range.anchor.leaf.kind !== 'block' || range.focus.leaf.kind !== 'block') return;
    if (sameLeaf(range.anchor.leaf, range.focus.leaf)) return;
    const r = replaceAcross(this.doc.blocks, range.anchor.leaf.id, range.anchor.offset, range.focus.leaf.id, range.focus.offset, text);
    if (r) this.applyStructural(r);
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

  // Move the caret to the next/previous cell in row-major order. Returns false
  // off the ends (the Tab handler then exits the table) — row/column insertion is
  // a later refinement.
  private moveCell(cell: { tableId: string; row: number; col: number }, dir: 1 | -1): boolean {
    const table = findBlockById(this.doc.blocks, cell.tableId);
    if (!table || table.type !== 'table') return false;
    const cols = table.rows[0]?.length ?? 0;
    if (cols === 0) return false;
    const flat = cell.row * cols + cell.col + dir;
    if (flat < 0 || flat >= table.rows.length * cols) return false;
    const nr = Math.floor(flat / cols);
    const nc = flat % cols;
    return this.focusCell(table, nr, nc, 0);
  }

  // Arrow-key navigation inside a table: step cell-to-cell, and at the grid's
  // edges step OUT to the block before/after the table. Returns true when it
  // handled the key (caller preventDefaults); false to let native movement run
  // (outside a table, mid-cell text, or a non-collapsed selection).
  private handleTableArrow(e: KeyboardEvent): boolean {
    const cell = this.cellTarget();
    if (!cell || !cell.collapsed) return false;
    const table = findBlockById(this.doc.blocks, cell.tableId);
    if (!table || table.type !== 'table') return false;
    const rows = table.rows.length;
    const cols = table.rows[0]?.length ?? 0;
    const len = inlineLength(cell.inline);
    switch (e.key) {
      case 'ArrowUp':
        return cell.row > 0
          ? this.focusCell(table, cell.row - 1, cell.col, cell.start)
          : this.exitTable(cell.tableId, 'before');
      case 'ArrowDown':
        return cell.row < rows - 1
          ? this.focusCell(table, cell.row + 1, cell.col, cell.start)
          : this.exitTable(cell.tableId, 'after');
      case 'ArrowLeft':
        if (cell.start > 0) return false; // move within the cell's text
        if (cell.col > 0) return this.focusCellEnd(table, cell.row, cell.col - 1);
        if (cell.row > 0) return this.focusCellEnd(table, cell.row - 1, cols - 1);
        return this.exitTable(cell.tableId, 'before');
      case 'ArrowRight':
        if (cell.start < len) return false; // move within the cell's text
        if (cell.col < cols - 1) return this.focusCell(table, cell.row, cell.col + 1, 0);
        if (cell.row < rows - 1) return this.focusCell(table, cell.row + 1, 0, 0);
        return this.exitTable(cell.tableId, 'after');
      default:
        return false;
    }
  }

  // Place the caret in a table cell, clamping the offset to the cell's length.
  private focusCell(table: TableBlock, row: number, col: number, offset: number): boolean {
    const inline = table.rows[row]?.[col];
    if (!inline) return false;
    const target = this.leafElementById(table.id)?.querySelector(
      `[data-cell-row="${row}"][data-cell-col="${col}"]`
    ) as HTMLElement | null;
    if (!target) return false;
    setCaret(target, Math.min(offset, inlineLength(inline)));
    return true;
  }

  private focusCellEnd(table: TableBlock, row: number, col: number): boolean {
    return this.focusCell(table, row, col, inlineLength(table.rows[row]?.[col] ?? []));
  }

  // Step the caret out of a (top-level) table to the adjacent block. Lands at the
  // end of the previous inline block / start of the next; when there is no inline
  // block to land in (e.g. the table is the last block, or the neighbour is
  // another barrier), seed an empty paragraph there so the table is never a trap.
  private exitTable(tableId: string, dir: 'before' | 'after'): boolean {
    const index = this.doc.blocks.findIndex((b) => b.id === tableId);
    if (index < 0) return false; // nested table: leave it to native movement
    const neighbor = dir === 'before' ? this.doc.blocks[index - 1] : this.doc.blocks[index + 1];
    if (neighbor && (neighbor.type === 'paragraph' || neighbor.type === 'heading')) {
      const el = this.leafElementById(neighbor.id);
      if (el) {
        setCaret(el, dir === 'before' ? inlineLength(neighbor.inline) : 0);
        return true;
      }
    }
    const para = this.newInlineBlock('paragraph', [], 1);
    const blocks = this.doc.blocks.slice();
    blocks.splice(dir === 'before' ? index : index + 1, 0, para);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: para.id }, offset: 0 }), 'structural');
    this.scheduleSerialize();
    return true;
  }

  // Delete a whole table (the select-across-cells gesture). Removes the block and
  // lands the caret on the nearest inline neighbour (see range-ops.deleteBlock).
  private removeTable(tableId: string): void {
    const r = deleteBlock(this.doc.blocks, tableId);
    if (r) this.applyStructural(r);
    this.closeSlash();
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
    // Place the caret through the document selection map: reconcile() replaced the
    // element the caret was in, so this goes through the robust (rAF re-asserted,
    // instrumented) placement that survives WKWebView's post-rebuild commit gap.
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: result.caret.id }, offset: result.caret.offset }), 'structural');
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
