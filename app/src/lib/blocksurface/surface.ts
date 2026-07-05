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

import { generateBlockId, parseDocument, serializeDocument, type BlockNode, type Document, type InlineNode, type ListItem, type TableBlock } from '../blockmodel';
import { markdownForPaste } from '../clipboard/htmlToMarkdown';
import { plainTextParagraphs } from '../clipboard/plainText';
import { buildClipboardPayload } from '../clipboard/copyOut';
import { BLOCK_ID_ATTR, BlockViewRegistry, renderBlock, renderDocument, renderInlineInto, setCodeContent } from './render';
import { caretContext, flatOffsetFromDOM, focusedLeafElement, leafCaretContext, readSelection, setCaret, setCrossBlockSelection, setSelectionRange, writeSelection } from './selection';
import { collapsedRange, isCollapsed, type DocPos, type DocRange } from './doc-position';
import { barrierNeighbor, clearTableCells, deleteAcross, deleteBlock, documentLeaves, mergeBackward, mergeForward, removeBlocks, replaceAcross } from './range-ops';
import { findBlockById, updateBlockById } from './tree';
import { enterInContainer, exitContainer, type StructuralResult } from './structural';
import { graftIntoContainer, spliceParsedAtLeaf } from './paste-graft';
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
import { lineBoundaryRange, wordBoundaryRange } from './word-boundary';
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

// Marks the block element selected as a unit (SKR-203). Data-attribute scoped so
// the ring in BlockEditor.css is unaffected by the surface's :focus-visible
// suppression. Every block element carries BLOCK_ID_ATTR; this rides on the same
// element.
const BLOCK_SELECTED_ATTR = 'data-block-selected';

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

/** The caret's resolved position, when it sits in an inline-text block (the
 *  editable target for typing, marks, list rules, and the slash menu). */
type CurrentInlineBlock = { block: InlineTextBlock; index: number; blockEl: HTMLElement; caret: number; collapsed: boolean };

// A run-delete scan (SKR-165): given a leaf's text, the caret offset in it,
// whether the leaf is a code block, and the direction, return the [from, to)
// slice to remove. Word vs line delete differ only in this function.
type RunScan = (text: string, caret: number, isCode: boolean, direction: 'backward' | 'forward') => [number, number];
const wordScan: RunScan = (text, caret, _isCode, direction) => wordBoundaryRange(text, caret, direction);
const lineScan: RunScan = (text, caret, isCode, direction) => lineBoundaryRange(text, caret, direction, isCode);

/** An in-table cross-cell selection: the rectangle of covered cells to clear. */
type CrossCellSelection = {
  kind: 'cells';
  tableId: string;
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
};

/** A cross-block selection reduced to two block-leaf endpoints in document order,
 *  with any table-cell endpoint mapped to the table's barrier position. */
type NormalizedBlockRange = {
  kind: 'blocks';
  start: { id: string; offset: number };
  end: { id: string; offset: number };
};

export class BlockSurface {
  // Authoritative document. Assigned through the `doc` setter everywhere except
  // the constructor and undo/redo, so every edit funnels one history snapshot.
  private _doc: Document;
  private readonly history = new DocHistory();
  // Hint the setter reads for the next snapshot's edit kind, then resets. Typing
  // and delete set it so consecutive ones coalesce; everything else is its own
  // undo step.
  private nextEditKind: EditKind = 'other';
  // Set while a compound gesture (a paste that deletes a selection THEN inserts)
  // is running: the one snapshot is taken up front, so the setter must not record
  // the intermediate states — the whole gesture is a single undo step (SKR-174).
  private suppressHistory = false;
  private readonly container: HTMLElement;
  private readonly registry = new BlockViewRegistry();
  private readonly onDocChange?: (doc: Document) => void;
  private debounceTimer: number | null = null;
  // The deferred idle-callback handle for the cold path, and whether the doc has
  // changed since we last handed a snapshot to the consumer. Together they let
  // flush() drain synchronously even after the debounce fired and deferred the
  // real emit into requestIdleCallback — the window where a bare timer check is
  // blind and ⌘S/quit would otherwise persist a stale body (SKR-154 / F01/F03).
  private idleHandle: number | null = null;
  private dirtySinceEmit = false;
  private composing = false;
  private selectionCb: ((info: SelectionInfo | null) => void) | null = null;
  private selScheduled = false;
  private savedLink: { blockId: string; start: number; end: number } | null = null;
  // The last text selection observed INSIDE the surface, in MODEL coordinates (a
  // leaf block id + a flat range; a caret is start === end), kept across focus
  // loss. WKWebView collapses a blurred contenteditable's selection the moment a
  // menu takes focus (Chromium preserves it, so the gate harness is blind), which
  // made palette commands no-op because they read no live selection. Command-time
  // resolution (currentInlineBlock / currentConvertibleBlock / leafTarget) falls
  // back to this ONLY when the live selection is null — the generalized form of
  // the savedLink dodge (SKR-173, absorbing SKR-151).
  private lastSelection: { blockId: string; start: number; end: number } | null = null;
  private slash: { blockId: string; slashOffset: number } | null = null;
  private slashCb: ((state: SlashMenuState | null) => void) | null = null;
  // The block object each top-level element was last rendered from, so the
  // incremental reconciler re-renders only the top-level blocks that changed.
  private readonly renderedFrom = new Map<string, BlockNode>();
  // Block selection (SKR-203): the block id(s) selected as a UNIT — a code block
  // or table acted on as an object (select it, delete it, type over it), parallel
  // to the SKR-118 text-range model. Authoritative surface state, deliberately NOT
  // derived from the live DOM selection (WKWebView collapses a blurred selection
  // and drops it): while it is active the DOM selection is cleared but focus stays
  // on the surface, so keydown still routes here. Plural-ready (it feeds
  // removeBlocks) though today's gestures only ever select a single block.
  private blockSel: string[] = [];
  // A drag that started from inside this surface (a selection being dragged),
  // as opposed to content dragged in from another app (SKR-165). Internal moves
  // are refused honestly (dropEffect 'none') rather than silently mishandled —
  // see onDragOver / onDrop. Set on dragstart, cleared on dragend.
  private internalDrag = false;

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
    this.container.addEventListener('click', this.onClick);
    this.container.addEventListener('dragstart', this.onDragStart, true);
    this.container.addEventListener('dragover', this.onDragOver, true);
    this.container.addEventListener('drop', this.onDrop, true);
    this.container.addEventListener('dragend', this.onDragEnd, true);
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
    if (!this.suppressHistory) {
      this.history.record(
        this._doc,
        () => readSelection(this.container),
        this.nextEditKind,
        performance.now()
      );
      this.nextEditKind = 'other';
    }
    this._doc = next;
  }

  /** Run a multi-step gesture (delete-then-insert paste) as ONE undo step: record
   *  a single pre-gesture snapshot up front, then suppress the setter's per-edit
   *  records for the duration. Selection is read now, before the delete moves it. */
  private compoundEdit(fn: () => void): void {
    this.history.record(this._doc, () => readSelection(this.container), 'other', performance.now());
    this.nextEditKind = 'other';
    this.suppressHistory = true;
    try {
      fn();
    } finally {
      this.suppressHistory = false;
    }
  }

  /** Undo the last edit (Cmd/Ctrl+Z). Restores the prior document and selection,
   *  bypassing the setter so the restore isn't itself recorded. */
  undo(): void {
    // Any block selection is transient surface state, not in history; drop it so a
    // restored doc never carries a stale ring (SKR-203).
    this.clearBlockSelectionState();
    const restored = this.history.undo({ doc: this._doc, sel: readSelection(this.container) });
    if (!restored) return;
    this._doc = restored.doc;
    this.reconcile();
    if (restored.sel) writeSelection(this.container, restored.sel, 'undo');
    this.scheduleSerialize();
  }

  /** Redo the last undone edit (Cmd/Ctrl+Shift+Z / Cmd+Y). */
  redo(): void {
    this.clearBlockSelectionState();
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

  /** The block ids currently selected as a unit (empty when none). A read-only view
   *  for consumers (the SKR-124 chrome, tests); the surface owns the state. */
  getSelectedBlockIds(): readonly string[] {
    return this.blockSel;
  }

  /** Return focus to the editing surface (after a menu action that moved focus). */
  focus(): void {
    this.container.focus();
  }

  /** Drain any pending cold-path snapshot immediately (save / blur / unmount).
   *  Cancels both the debounce and a deferred idle emit, then hands the consumer
   *  a fresh snapshot iff the doc changed since the last emit. Idempotent: a
   *  second call with nothing pending is a no-op, so double-draining (e.g. a
   *  closeTab flush followed by the unmount flush) never re-emits stale state. */
  flush(): void {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.cancelIdle();
    if (this.dirtySinceEmit) this.emitDocChange();
  }

  destroy(): void {
    this.container.removeEventListener('beforeinput', this.onBeforeInput, true);
    this.container.removeEventListener('paste', this.onPaste, true);
    this.container.removeEventListener('copy', this.onCopy, true);
    this.container.removeEventListener('cut', this.onCut, true);
    this.container.removeEventListener('compositionstart', this.onCompositionStart, true);
    this.container.removeEventListener('compositionend', this.onCompositionEnd, true);
    this.container.removeEventListener('keydown', this.onKeyDown, true);
    this.container.removeEventListener('click', this.onClick);
    this.container.removeEventListener('dragstart', this.onDragStart, true);
    this.container.removeEventListener('dragover', this.onDragOver, true);
    this.container.removeEventListener('drop', this.onDrop, true);
    this.container.removeEventListener('dragend', this.onDragEnd, true);
    document.removeEventListener('selectionchange', this.onDocSelectionChange);
    // Teardown cancels pending work without emitting — the caller is responsible
    // for flush()ing first if it wants the last edit saved (BlockEditor does).
    // Cancelling the idle handle stops a deferred emit firing after teardown (F03).
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.cancelIdle();
  }

  // --- marks: keyboard shortcuts + commands --------------------------------

  private onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    // A block is selected as a unit (SKR-203): its keys (delete / type-over /
    // dissolve / ⌘A-to-document) are owned here, ahead of every prose handler.
    if (this.blockSel.length > 0 && this.handleBlockSelectionKey(e)) return;
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
          this.exitBarrier(cell.tableId, e.shiftKey ? 'before' : 'after');
        }
        return;
      }
      // A multi-item list selection indents/outdents every covered item together
      // (SKR-169 / F50) rather than dead-ending in native focus escape.
      const listLeafIds = this.selectedLeaves()
        .filter((l) => findImmediateList(this.doc.blocks, l.leaf.id))
        .map((l) => l.leaf.id);
      if (listLeafIds.length > 1) {
        e.preventDefault();
        this.applyListIndentRange(listLeafIds, e.shiftKey);
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
      if (this.handleTableArrow(e) || this.handleCodeArrow(e)) e.preventDefault();
      return;
    }
    // Escape with the caret inside a code block / table selects it as a unit
    // (SKR-203). Only when no overlay owns Escape: the slash menu's own capture
    // listener stops propagation before this fires, and the link editor holds
    // focus off the surface; the guard is belt-and-suspenders for its saved
    // selection. Escape in prose keeps its (currently inert) native behaviour.
    if (e.key === 'Escape') {
      if (this.slash || this.savedLink) return;
      const id = this.currentBarrierBlockId();
      if (id) {
        e.preventDefault();
        this.selectBlock(id);
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // Cmd/Ctrl+A inside a barrier escalates Notion/Docs-style: leaf text -> whole
    // block -> document. Outside a barrier it is left to the browser's select-all.
    if (e.key.toLowerCase() === 'a' && !e.shiftKey) {
      if (this.handleSelectAll()) e.preventDefault();
      return;
    }
    // Cmd/Ctrl+Shift+8 / +7 toggle bullet / ordered list (Google-Docs parity).
    // Keyed on e.code so it is layout-independent (Shift+8 is '*' on a US layout).
    if (e.shiftKey && (e.code === 'Digit8' || e.code === 'Digit7')) {
      e.preventDefault();
      this.toggleList(e.code === 'Digit8' ? 'bullet_list' : 'ordered_list');
      return;
    }
    // Mark chords are unshifted (⌘B/⌘I/⌘E). ⌘⇧B and ⌘⇧E are separately bound at
    // the app level (backlinks panel, cycle layout — see registry.ts) and must
    // reach the window dispatcher untouched, not get eaten here too (SKR-171).
    const key = e.key.toLowerCase();
    if (e.shiftKey) return;
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

  /** Dismiss the link editor without touching the document (Escape / click-out),
   *  RESTORING the selection it was applied over. The commit path restores through
   *  the re-render; cancel has no re-render, so it re-selects the saved range on the
   *  live element. Focus is taken back first: the caret otherwise lands arbitrarily
   *  in WKWebView when focus returns from the URL input to a surface with no live
   *  selection (SKR-173 / F71). The later focusEditor() call is then a no-op. */
  cancelLink(): void {
    const saved = this.savedLink;
    this.savedLink = null;
    if (!saved) return;
    const el = this.leafElementById(saved.blockId);
    if (!el) return;
    this.container.focus();
    setSelectionRange(el, saved.start, saved.end);
    this.emitSelection();
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

  /** Convert the current block's type, or insert a divider/table. Keeps the
   *  inline content (and the block id) across a paragraph<->heading change.
   *
   *  Divider and table are insertions, not conversions (SKR-170 / F66): a block
   *  with text has content that a "replace" would destroy, so an empty current
   *  block still gets the old replace-in-place behavior (this is the only way
   *  the slash menu reaches here, since it requires an empty block to open), but
   *  a non-empty block is left untouched and the divider/table is spliced in
   *  after it. The branch lives here so every caller (toolbar, palette, slash)
   *  gets it for free. */
  setBlockType(spec: BlockTypeSpec): void {
    // Multi-block textblock conversions (Text / Heading / Code) map over every
    // covered inline-text leaf as one history step, mirroring the mark commands
    // (SKR-169 / F50). Barriers are skipped for free: selectedLeaves only yields
    // inline-text leaves. Container wraps (list/quote) and divider/table on a
    // multi-block selection go through the dedicated toggles / the paths below.
    if (spec.kind === 'paragraph' || spec.kind === 'heading' || spec.kind === 'code') {
      const leaves = this.selectedLeaves();
      if (leaves.length > 1) {
        this.convertLeavesInPlace(leaves, spec);
        return;
      }
    }
    // A collapsed caret (or a within-block selection) whose leaf is nested inside a
    // container: the top-level resolver below lands on the list/quote wrapper and
    // bails, so the toolbar looks enabled but the conversion no-ops (SKR-169 / F84).
    // Route these to the container-aware path.
    const leaf = this.leafTarget();
    if (leaf && !this.isTopLevel(leaf.blockEl, leaf.leaf.id)) {
      this.setBlockTypeNested(leaf.leaf.id, leaf.start, spec);
      return;
    }
    const cur = this.currentConvertibleBlock();
    if (!cur) return;
    const empty = inlineLength(cur.inline) === 0;
    if (spec.kind === 'divider') {
      if (empty) this.replaceWithDivider(cur);
      else this.insertDividerAfter(cur);
      return;
    }
    if (spec.kind === 'table' && !empty) {
      this.insertTableAfter(cur);
      return;
    }

    const { node: next, caretLeafId } = this.convertedBlock(spec, cur.block);
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
      setCaret(caretEl, Math.min(cur.caret, inlineLength(this.inlineOf(cur.block))));
    }
    this.scheduleSerialize();
  }

  /** Mark a block dirty for re-serialization, leaving a frozen block (which has no
   *  dirty flag and re-emits verbatim) untouched — the guard liftItemToParagraph
   *  uses, shared by the wrap/unwrap toggles that re-home blocks. */
  private dirtyBlock(b: BlockNode): BlockNode {
    return b.type === 'frozen_block' ? b : ({ ...b, dirty: true } as BlockNode);
  }

  /** The inline content a conversion carries across from a source block: a
   *  paragraph/heading's own inline, or a code block's text flowed to a single run
   *  (newlines -> spaces, per SKR-168). Other block kinds carry no inline. */
  private inlineOf(source: BlockNode): InlineNode[] {
    if (isInlineText(source)) return source.inline;
    if (source.type === 'code_block') {
      const text = source.text.replace(/\n/g, ' ');
      return text.length > 0 ? [{ kind: 'text', text, marks: {} }] : [];
    }
    return [];
  }

  /** Build the block a type conversion produces from `source`, reusing its id and
   *  seam. Textblock kinds keep the id and carry the inline across; container kinds
   *  wrap a fresh nested paragraph (its own id, returned as caretLeafId, so the
   *  caret lands in an editable leaf). The single source of truth the top-level,
   *  nested, and multi-block converts all build from, so the three can't drift. A
   *  type change drops the captured src (it would re-serialize as the old
   *  construct); the seam gap is unchanged. */
  private convertedBlock(spec: BlockTypeSpec, source: BlockNode): { node: BlockNode; caretLeafId: string | null } {
    const base = { id: source.id, durable: source.durable, src: null, gapBefore: source.gapBefore, dirty: true };
    const inline = this.inlineOf(source);
    switch (spec.kind) {
      case 'heading':
        return { node: { type: 'heading', ...base, level: spec.level, inline }, caretLeafId: null };
      case 'blockquote': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        return { node: { type: 'blockquote', ...base, children: [inner] }, caretLeafId: inner.id };
      }
      case 'bullet_list': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        return { node: { type: 'bullet_list', ...base, marker: '-', spread: false, items: [{ spread: false, children: [inner] }] }, caretLeafId: inner.id };
      }
      case 'ordered_list': {
        const inner = this.newInlineBlock('paragraph', inline, 1);
        return { node: { type: 'ordered_list', ...base, start: spec.start ?? 1, delimiter: spec.delimiter ?? '.', spread: false, items: [{ spread: false, children: [inner] }] }, caretLeafId: inner.id };
      }
      case 'code':
        return { node: { type: 'code_block', ...base, lang: '', meta: null, fence: null, text: inlinePlainText(inline) }, caretLeafId: null };
      case 'table':
        // A starter 2x2 table (header row + one body row), empty cells.
        return { node: { type: 'table', ...base, align: [null, null], rows: [[[], []], [[], []]] }, caretLeafId: null };
      case 'divider':
        return { node: { type: 'horizontal_rule', ...base }, caretLeafId: null };
      case 'paragraph':
      default:
        return { node: { type: 'paragraph', ...base, inline }, caretLeafId: null };
    }
  }

  /** Multi-block "Turn into": convert every covered inline-text leaf in place, as
   *  one history step (one doc assignment). Barriers were already filtered out by
   *  selectedLeaves. Restores the same highlight the user acted on. */
  private convertLeavesInPlace(
    leaves: ReadonlyArray<{ leaf: InlineTextBlock; start: number; end: number }>,
    spec: BlockTypeSpec
  ): void {
    let blocks = this.doc.blocks;
    for (const l of leaves) {
      blocks = updateBlockById(blocks, l.leaf.id, (b) => this.convertedBlock(spec, b).node);
    }
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const first = leaves[0];
    const last = leaves[leaves.length - 1];
    if (first && last) {
      const firstEl = this.leafElementById(first.leaf.id);
      const lastEl = this.leafElementById(last.leaf.id);
      if (firstEl && lastEl) {
        if (firstEl === lastEl) setSelectionRange(firstEl, first.start, last.end);
        else setCrossBlockSelection(firstEl, first.start, lastEl, last.end);
      }
    }
    this.scheduleSerialize();
    this.emitSelection();
  }

  /** Convert a leaf nested inside a container (SKR-169 / F84). Divider/table insert
   *  AFTER the enclosing top-level container (never inside the list/quote). A leaf
   *  inside a LIST item is lifted out of the list first (Notion behavior) by
   *  composing the existing outdent/lift ops, so headings and paragraphs land at
   *  top level; a leaf inside a BLOCKQUOTE converts in place (a quote legitimately
   *  contains headings). Both do exactly one doc assignment => one history step. */
  private setBlockTypeNested(leafId: string, offset: number, spec: BlockTypeSpec): void {
    if (spec.kind === 'divider' || spec.kind === 'table') {
      this.insertBesideContainer(leafId, spec);
      return;
    }
    let blocks = this.doc.blocks;
    // A list item lifts out of its list before converting: outdent until it is a
    // top-level item, then lift it to a top-level block. The leaf keeps its id, so
    // the follow-up type change and the caret restore both still address it.
    if (findImmediateList(blocks, leafId)) {
      let out: BlockNode[] | null;
      while ((out = outdentItem(blocks, leafId, generateBlockId)) !== null) blocks = out;
      const lifted = liftItemToParagraph(blocks, leafId, generateBlockId);
      if (lifted) blocks = lifted;
    }
    const source = findBlockById(blocks, leafId);
    if (!source) return;
    const { node, caretLeafId } = this.convertedBlock(spec, source);
    const clamped = Math.min(offset, inlineLength(this.inlineOf(source)));
    blocks = updateBlockById(blocks, leafId, () => node);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    writeSelection(
      this.container,
      collapsedRange({ leaf: { kind: 'block', id: caretLeafId ?? leafId }, offset: clamped }),
      'structural'
    );
    this.scheduleSerialize();
  }

  /** Insert a divider/table after the top-level block that encloses `leafId`, per
   *  SKR-170's insert-beside semantics — never inside the list/quote the leaf lives
   *  in. Reuses the top-level insert-after helpers on the container's index. */
  private insertBesideContainer(leafId: string, spec: BlockTypeSpec): void {
    const index = this.doc.blocks.findIndex((b) => findBlockById([b], leafId) !== null);
    if (index < 0) return;
    if (spec.kind === 'divider') this.insertDividerAfter({ index });
    else if (spec.kind === 'table') this.insertTableAfter({ index });
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

  /** Insert a divider after a non-empty current block (SKR-170 / F66), leaving its
   *  text untouched. A divider has no caret home of its own, so the caret needs a
   *  landing spot after it: the existing next block when it's inline text, or a
   *  freshly seeded paragraph otherwise (including when the divider would be the
   *  last block) — the same "never a trap" seeding exitBarrier uses for arrow-key
   *  exits out of a barrier. */
  private insertDividerAfter(cur: { index: number }): void {
    const hr: BlockNode = { type: 'horizontal_rule', id: generateBlockId(), durable: false, src: null, gapBefore: null, dirty: true };
    const blocks = this.doc.blocks.slice();
    const next = blocks[cur.index + 1];
    let landing: BlockNode;
    if (next && (next.type === 'paragraph' || next.type === 'heading')) {
      landing = next;
      blocks.splice(cur.index + 1, 0, hr);
    } else {
      landing = this.newInlineBlock('paragraph', [], 1);
      blocks.splice(cur.index + 1, 0, hr, landing);
    }
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const el = this.leafElementById(landing.id);
    if (el) setCaret(el, 0);
    this.scheduleSerialize();
  }

  /** Insert a starter 2x2 table after a non-empty current block (SKR-170 / F66),
   *  leaving its text untouched. The caret always lands in the first cell, same as
   *  the empty-block (replace-in-place) table path. */
  private insertTableAfter(cur: { index: number }): void {
    const table: BlockNode = {
      type: 'table',
      id: generateBlockId(),
      durable: false,
      src: null,
      gapBefore: null,
      dirty: true,
      align: [null, null],
      rows: [[[], []], [[], []]]
    };
    const blocks = this.doc.blocks.slice();
    blocks.splice(cur.index + 1, 0, table);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const tableEl = this.leafElementById(table.id);
    const firstCell = tableEl?.querySelector('[data-cell-row="0"][data-cell-col="0"]') as HTMLElement | null;
    if (firstCell) setCaret(firstCell, 0);
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

  /** Apply Tab/Shift+Tab to every selected list item as one history step (SKR-169 /
   *  F50), so a multi-item selection indents/outdents together instead of falling
   *  through to native focus escape. Items are processed in document order over the
   *  evolving tree; ids are preserved by the ops, so the range restore still holds. */
  private applyListIndentRange(leafIds: string[], outdent: boolean): void {
    let blocks = this.doc.blocks;
    for (const id of leafIds) {
      const next = outdent
        ? (outdentItem(blocks, id, generateBlockId) ?? liftItemToParagraph(blocks, id, generateBlockId))
        : indentItem(blocks, id, generateBlockId);
      if (next) blocks = next;
    }
    if (blocks === this.doc.blocks) return; // nothing applied (e.g. all items first-in-list)
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    this.restoreRangeAcross(leafIds[0]!, leafIds[leafIds.length - 1]!);
    this.scheduleSerialize();
    this.emitSelection();
  }

  /** Toggle the focused block(s) to/from a list of `target` kind (Cmd/Ctrl+Shift+8/7,
   *  toolbar). A multi-block selection wraps the covered top-level blocks into one
   *  list (or unwraps when they are all already that kind). A single caret: not in a
   *  list -> wrap into one; in a list of the same kind -> outdent/lift off; in a
   *  list of the other kind -> switch the kind. */
  toggleList(target: 'bullet_list' | 'ordered_list'): void {
    const tops = this.selectedTopLevelBlocks();
    // Multi when the selection spans several top-level blocks OR several leaves of
    // one container (a multi-item list) — the latter is how a repeat toggle, whose
    // range now sits inside the single wrapped list, still unwraps every item.
    if (tops.length > 0 && (tops.length > 1 || this.selectedLeaves().length > 1)) {
      this.toggleListMulti(tops, target);
      return;
    }
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

  /** Wrap the selected contiguous top-level blocks into ONE list of `target` kind,
   *  or unwrap them when every one is already that kind (the toggle-off). An
   *  existing list among the selection contributes its items (so lists merge rather
   *  than nest); every other block becomes one item. One doc assignment. */
  private toggleListMulti(tops: Array<{ id: string; index: number }>, target: 'bullet_list' | 'ordered_list'): void {
    const blocks = this.doc.blocks;
    const first = tops[0]!.index;
    const last = tops[tops.length - 1]!.index;
    const run = blocks.slice(first, last + 1);
    const out = blocks.slice();

    if (run.every((b) => b.type === target)) {
      // Unwrap: drop each list, lifting its items' children to top level in place.
      const lifted: BlockNode[] = [];
      for (const b of run) {
        if (b.type === 'bullet_list' || b.type === 'ordered_list') {
          for (const item of b.items) for (const child of item.children) lifted.push(this.dirtyBlock(child));
        } else {
          lifted.push(b);
        }
      }
      out.splice(first, run.length, ...lifted);
      this.commitWrapToggle(out, lifted[0] ?? null, lifted[lifted.length - 1] ?? null);
      return;
    }

    const items: ListItem[] = [];
    for (const b of run) {
      if (b.type === 'bullet_list' || b.type === 'ordered_list') items.push(...b.items);
      else items.push({ spread: false, children: [this.dirtyBlock(b)] });
    }
    const base = { id: generateBlockId(), durable: false, src: null, gapBefore: run[0]!.gapBefore, dirty: true };
    const list: BlockNode =
      target === 'ordered_list'
        ? { type: 'ordered_list', ...base, start: 1, delimiter: '.', spread: false, items }
        : { type: 'bullet_list', ...base, marker: '-', spread: false, items };
    out.splice(first, run.length, list);
    this.commitWrapToggle(out, list, list);
  }

  /** Toggle the selected top-level blocks into / out of a single blockquote (SKR-169
   *  / F50). Multi-block wraps the covered blocks into one quote (or unwraps when
   *  all are quotes). A single caret in a top-level quote unwraps it; elsewhere it
   *  wraps (delegating to setBlockType, which lifts a list item first). */
  toggleQuote(): void {
    const tops = this.selectedTopLevelBlocks();
    if (tops.length > 0 && (tops.length > 1 || this.selectedLeaves().length > 1)) {
      this.toggleQuoteMulti(tops);
      return;
    }
    const t = this.leafTarget();
    if (!t || t.spansBlocks || !isInlineText(t.leaf)) return;
    const index = this.doc.blocks.findIndex((b) => findBlockById([b], t.leaf.id) !== null);
    const top = index >= 0 ? this.doc.blocks[index] : null;
    if (top && top.type === 'blockquote') {
      // Unwrap: replace the quote with its children, lifted to top level.
      const out = this.doc.blocks.slice();
      out.splice(index, 1, ...top.children.map((c) => this.dirtyBlock(c)));
      this.doc = { ...this.doc, blocks: out };
      this.reconcile();
      writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: t.leaf.id }, offset: t.start }), 'structural');
      this.scheduleSerialize();
      this.emitSelection();
      return;
    }
    this.setBlockType({ kind: 'blockquote' });
  }

  private toggleQuoteMulti(tops: Array<{ id: string; index: number }>): void {
    const blocks = this.doc.blocks;
    const first = tops[0]!.index;
    const last = tops[tops.length - 1]!.index;
    const run = blocks.slice(first, last + 1);
    const out = blocks.slice();

    if (run.every((b) => b.type === 'blockquote')) {
      const lifted: BlockNode[] = [];
      for (const b of run) {
        if (b.type === 'blockquote') for (const child of b.children) lifted.push(this.dirtyBlock(child));
      }
      out.splice(first, run.length, ...lifted);
      this.commitWrapToggle(out, lifted[0] ?? null, lifted[lifted.length - 1] ?? null);
      return;
    }

    const children: BlockNode[] = [];
    for (const b of run) {
      if (b.type === 'blockquote') for (const child of b.children) children.push(this.dirtyBlock(child));
      else children.push(this.dirtyBlock(b));
    }
    const quote: BlockNode = {
      type: 'blockquote',
      id: generateBlockId(),
      durable: false,
      src: null,
      gapBefore: run[0]!.gapBefore,
      dirty: true,
      children
    };
    out.splice(first, run.length, quote);
    this.commitWrapToggle(out, quote, quote);
  }

  /** Assign the wrapped/unwrapped blocks and restore a highlight spanning the
   *  result's first-to-last leaf, so a repeat toggle sees the same span and can
   *  reverse it (Docs behaviour). One doc assignment => one history step. */
  private commitWrapToggle(blocks: BlockNode[], firstBlock: BlockNode | null, lastBlock: BlockNode | null): void {
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const firstId = firstBlock ? this.firstLeafId(firstBlock) : null;
    const lastId = lastBlock ? this.lastLeafId(lastBlock) : null;
    if (firstId && lastId) this.restoreRangeAcross(firstId, lastId);
    this.scheduleSerialize();
    this.emitSelection();
  }

  /** The contiguous run of top-level blocks the current selection intersects, in
   *  document order. The unit multi-block wrap toggles and Turn-into operate on. */
  private selectedTopLevelBlocks(): Array<{ id: string; index: number }> {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const out: Array<{ id: string; index: number }> = [];
    this.doc.blocks.forEach((b, index) => {
      const el = this.registry.get(b.id);
      if (el && range.intersectsNode(el)) out.push({ id: b.id, index });
    });
    return out;
  }

  /** The first / last editable leaf id within a block (descending into containers),
   *  for restoring a selection across a freshly wrapped or unwrapped run. */
  private firstLeafId(block: BlockNode): string | null {
    return documentLeaves([block])[0]?.id ?? null;
  }
  private lastLeafId(block: BlockNode): string | null {
    const leaves = documentLeaves([block]);
    return leaves[leaves.length - 1]?.id ?? null;
  }

  /** Restore a highlight from the start of one leaf to the end of another (each
   *  addressed by id, resolved through the post-reconcile DOM). Collapses to a
   *  single-leaf range when the two coincide. */
  private restoreRangeAcross(firstLeafId: string, lastLeafId: string): void {
    const firstEl = this.leafElementById(firstLeafId);
    const lastEl = this.leafElementById(lastLeafId);
    if (!firstEl || !lastEl) return;
    const lastBlock = findBlockById(this.doc.blocks, lastLeafId);
    const lastLen = lastBlock
      ? isInlineText(lastBlock)
        ? inlineLength(lastBlock.inline)
        : lastBlock.type === 'code_block'
          ? lastBlock.text.length
          : 0
      : 0;
    if (firstEl === lastEl) setSelectionRange(firstEl, 0, lastLen);
    else setCrossBlockSelection(firstEl, 0, lastEl, lastLen);
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
   *  type. Called by the menu (which preserves the caret on mousedown).
   *
   *  Belt-and-suspenders (SKR-172): the menu's own selection can go stale — the
   *  selection observer that would otherwise close the session is rAF-async, so
   *  a fast click-into-another-block-then-Enter can reach here before it runs.
   *  Refuse instead of converting whatever block the caret currently sits in. */
  applySlashCommand(spec: BlockTypeSpec): void {
    const slash = this.slash;
    if (!slash) return;
    const cur = this.currentInlineBlock();
    if (!this.slashCaretIntact(cur)) {
      this.closeSlash();
      return;
    }
    const text = inlinePlainText(cur.block.inline);
    const inline = deleteRangeInInline(cur.block.inline, slash.slashOffset, text.length);
    this.commitBlock(cur.index, { ...cur.block, inline, dirty: true });
    renderInlineInto(cur.blockEl, inline);
    setCaret(cur.blockEl, slash.slashOffset);
    this.closeSlash();
    this.setBlockType(spec);
  }

  closeSlash(): void {
    if (!this.slash) return;
    this.slash = null;
    this.slashCb?.(null);
  }

  /** True while `cur` is a collapsed caret still inside the active slash
   *  session's block — the only state in which the session may continue.
   *  Shared by refreshSlash (after an edit), applySlashCommand (the
   *  belt-and-suspenders recheck), and the selection observer (a pure caret
   *  move, with no edit to hang a refresh off of). A type predicate so callers
   *  get `cur` narrowed to non-null on the true branch. */
  private slashCaretIntact(cur: CurrentInlineBlock | null): cur is CurrentInlineBlock {
    return !!cur && !!this.slash && cur.block.id === this.slash.blockId && cur.collapsed;
  }

  private currentInlineBlock(): CurrentInlineBlock | null {
    const ctx = caretContext(this.container, this.registry);
    if (ctx) {
      const found = this.findBlock(ctx.blockEl);
      if (!found || !isInlineText(found.block)) return null;
      return { block: found.block, index: found.index, blockEl: ctx.blockEl, caret: ctx.start, collapsed: ctx.collapsed };
    }
    // No live selection in the surface — fall back to the last observed range so a
    // command from a menu that took focus still targets the right block. Only the
    // null case falls back: a live caret in a non-inline context keeps returning
    // null, preserving the commands' existing gating.
    const saved = this.savedTopLevelBlock();
    if (!saved || !isInlineText(saved.block)) return null;
    return {
      block: saved.block,
      index: saved.index,
      blockEl: saved.blockEl,
      caret: Math.min(saved.start, inlineLength(saved.block.inline)),
      collapsed: saved.start === saved.end
    };
  }

  // The block a Turn-into acts on, with the inline content to carry across the
  // conversion. An inline-text block carries its own inline; a code block converts
  // too (F45 — otherwise the whole type menu is a dead no-op inside code): its text
  // becomes a single flowed paragraph, newlines flowing to spaces (Joe's call).
  // Other barriers (table / hr / frozen) aren't convertible and return null.
  private currentConvertibleBlock(): { block: BlockNode; index: number; blockEl: HTMLElement; caret: number; inline: InlineNode[] } | null {
    // Live caret first; on a null selection fall back to the saved top-level block
    // so block restyle from the palette still converts after a menu took focus and
    // WKWebView collapsed the selection. Both resolvers yield the same shape.
    const ctx = caretContext(this.container, this.registry);
    let block: BlockNode;
    let index: number;
    let blockEl: HTMLElement;
    let caret: number;
    if (ctx) {
      const found = this.findBlock(ctx.blockEl);
      if (!found) return null;
      ({ block, index } = found);
      blockEl = ctx.blockEl;
      caret = ctx.start;
    } else {
      const saved = this.savedTopLevelBlock();
      if (!saved) return null;
      ({ block, index, blockEl } = saved);
      caret = saved.start;
    }
    if (isInlineText(block)) {
      return { block, index, blockEl, caret: Math.min(caret, inlineLength(block.inline)), inline: block.inline };
    }
    if (block.type === 'code_block') {
      const text = block.text.replace(/\n/g, ' ');
      const inline: InlineNode[] = text.length > 0 ? [{ kind: 'text', text, marks: {} }] : [];
      return { block, index, blockEl, caret: 0, inline };
    }
    return null;
  }

  /** The top-level block backing `lastSelection`, or null when the fallback must
   *  not fire: no saved range, an active SKR-203 block selection (its commands
   *  route through handleBlockSelectionKey, never here), or the saved block is gone
   *  from the doc (removed / a file switch remounted the surface). The block-exists
   *  and offset-clamp checks are the model validation the O(1) observer defers to
   *  command time. Top-level only (registry membership); a saved caret inside a
   *  container resolves through leafTarget's own fallback instead. */
  private savedTopLevelBlock(): { block: BlockNode; index: number; blockEl: HTMLElement; start: number; end: number } | null {
    if (this.blockSel.length > 0) return null;
    const saved = this.lastSelection;
    if (!saved) return null;
    const index = this.doc.blocks.findIndex((b) => b.id === saved.blockId);
    if (index < 0) return null;
    const block = this.doc.blocks[index]!;
    const blockEl = this.registry.get(block.id);
    if (!blockEl) return null;
    return { block, index, blockEl, start: saved.start, end: saved.end };
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
    if (!this.slashCaretIntact(cur)) return this.closeSlash();
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
      this.dissolveOnUserSelection();
      this.closeSlashOnSelectionMove();
      this.emitSelection();
    });
  };

  /** Dissolve an active block selection when a real DOM selection appears inside
   *  the surface — a click (or an arrow the browser resolved) placed a caret, so
   *  the block-as-object gesture is over and the caret wins. Our own removeAllRanges
   *  leaves rangeCount 0, so ESTABLISHING a block selection never trips this — the
   *  self-inflicted-dissolution guard. Lives in the observer, not scattered
   *  handlers, so every user-driven selection change routes through one place. */
  private dissolveOnUserSelection(): void {
    if (this.blockSel.length === 0) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this.container.contains(range.startContainer)) return;
    this.clearBlockSelectionState();
  }

  /** Close an open slash session when the selection moves out from under it —
   *  a click into another block, a drag that turns the caret into a range, or
   *  focus leaving the surface (SKR-172 / F69). refreshSlash already closes on
   *  a stale block after an EDIT; this covers a pure selection move with no
   *  edit to hang a refresh off of. Reuses the same intact-caret check so the
   *  two paths can't drift apart. */
  private closeSlashOnSelectionMove(): void {
    if (!this.slash) return;
    if (!this.slashCaretIntact(this.currentInlineBlock())) this.closeSlash();
  }

  private emitSelection(): void {
    this.recordSelection();
    const cb = this.selectionCb;
    if (!cb) return;
    cb(this.selectionSummary());
  }

  /** Keep lastSelection fresh from the rAF-coalesced selection observer, so a
   *  command issued after focus moves to a menu (which collapses the selection in
   *  WKWebView) still knows the range it should act on. A selection outside the
   *  surface — or an active block selection, whose DOM selection is intentionally
   *  cleared — records nothing, so the last in-surface range stays. This rides the
   *  observer (once per frame), never the typing hot path; leaf resolution keeps it
   *  O(1)-ish and model validation is left to the command-time fallback. */
  private recordSelection(): void {
    if (this.blockSel.length > 0) return;
    const ctx = leafCaretContext(this.container);
    if (!ctx) return;
    const blockId = ctx.blockEl.getAttribute(BLOCK_ID_ATTR);
    if (blockId != null) this.lastSelection = { blockId, start: ctx.start, end: ctx.end };
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
    // A block selection owns input in keydown (SKR-203); swallow any native input
    // event that still slips through while it is active so nothing edits behind it.
    if (this.blockSel.length > 0) {
      (event as InputEvent).preventDefault();
      return;
    }
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
    } else if (type === 'deleteWordBackward') {
      e.preventDefault();
      this.applyRunDelete('backward', wordScan);
    } else if (type === 'deleteWordForward') {
      e.preventDefault();
      this.applyRunDelete('forward', wordScan);
    } else if (type === 'deleteSoftLineBackward' || type === 'deleteHardLineBackward') {
      // WebKit emits Hard for Cmd+Backspace, Chromium Soft; both map to the same
      // pragmatic run delete (to the text-run start — SKR-165), so accept either.
      e.preventDefault();
      this.applyRunDelete('backward', lineScan);
    } else if (type === 'deleteSoftLineForward' || type === 'deleteHardLineForward') {
      e.preventDefault();
      this.applyRunDelete('forward', lineScan);
    } else if (type.startsWith('insert') || type.startsWith('delete')) {
      // Still-unmodeled edits (e.g. insertFromDrop / deleteByDrag, handled by the
      // drop listener instead) — block them so the browser cannot mutate structure
      // behind the model. This catch-all is load-bearing; leave it in place.
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
    // interpretTransfer claims the gesture (preventDefault) only when the transfer
    // actually carried something to land — an empty clipboard is left to the
    // browser, exactly as before. A drop reuses the same body (see onDrop).
    this.interpretTransfer(data, () => e.preventDefault());
  };

  // Land a DataTransfer's content at the current caret through the one paste
  // pipeline (SKR-119 / SKR-165): a code block takes it verbatim, else it is
  // parsed as Markdown blocks, else it falls back to the plain split-paste, which
  // also handles nested/list/quote/cell contexts. A ClipboardEvent.clipboardData
  // and a DragEvent.dataTransfer are both DataTransfer, so paste and drop share
  // this. `claim` is invoked only when there IS interpretable content, so the
  // caller can preventDefault conditionally (paste) or unconditionally (drop, which
  // must always cancel the native DOM mutation). Returns whether content landed.
  private interpretTransfer(data: DataTransfer, claim: () => void): boolean {
    const plain = data.getData('text/plain');
    const html = data.getData('text/html');
    // Rich HTML wins; fall back to interpreting plain text as Markdown.
    const fromHtml = html ? markdownForPaste(html) : null;
    const markdown = fromHtml ?? (plain && plain.length > 0 ? plain : null);
    if (markdown == null) return false;
    claim();
    const literal = plain && plain.length > 0 ? plain : markdown;
    // A code block takes the clipboard verbatim — newlines intact, no Markdown
    // interpretation (Notion / VS Code / Obsidian all paste literally into code).
    // Must run before segmentation, which would flow the newlines to spaces (F24).
    if (this.pasteIntoCode(literal)) return true;
    // Block insert only lands at a collapsed caret in a top-level inline leaf.
    // Anywhere else (nested list/quote, code, table cell, or a selection) falls
    // back to the plain split-paste for v1 — see SKR-119 scope.
    if (!this.insertMarkdownBlocks(markdown)) this.pasteText(literal, 'flow');
    return true;
  }

  // Drag-and-drop (SKR-165). External text dropped from another app lands through
  // the same interpretation pipeline as paste, at the drop point. An internal drag
  // (a selection dragged within the doc) is refused honestly — see onDragOver — so
  // the OS shows the not-allowed cursor rather than the gesture silently doing
  // nothing; reliable in-doc move needs selection lifetime + source/target
  // reconciliation across the drag that only the real WKWebView shell can prove.
  private onDragStart = (): void => {
    this.internalDrag = true;
  };
  private onDragEnd = (): void => {
    this.internalDrag = false;
  };
  private onDragOver = (event: Event): void => {
    const e = event as DragEvent;
    if (this.internalDrag) {
      // Refuse the internal move: no preventDefault, so `drop` never fires, and the
      // OS shows not-allowed. An honest rejection, not silent inertness.
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    // An external drop is accepted; the browser only fires `drop` when dragover was
    // preventDefaulted.
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    e.preventDefault();
  };
  private onDrop = (event: Event): void => {
    const e = event as DragEvent;
    // Never let the browser mutate the DOM directly on a drop.
    e.preventDefault();
    if (this.internalDrag) return; // rung: internal moves refused (see onDragOver)
    const data = e.dataTransfer;
    if (!data) return;
    const point = this.resolveCaretPoint(e.clientX, e.clientY);
    if (!point || !this.placeCaretAtPoint(point)) return; // drop landed off the doc
    this.clearBlockSelectionState(); // a drop supersedes any block-as-unit selection
    this.nextEditKind = 'other'; // a drop is one atomic history step
    this.interpretTransfer(data, () => {});
  };

  // The single caret-from-point wrapper (SKR-165). caretPositionFromPoint (the
  // spec / Firefox name) and caretRangeFromPoint (WebKit / Chromium) resolve a
  // viewport point to a DOM position but differ in name and return shape; wrap
  // both. Null where the platform offers neither — jsdom implements no caret-from-
  // point, so this resolution is Playwright / shell only there.
  private resolveCaretPoint(x: number, y: number): { node: Node; offset: number } | null {
    // `Document` in this module is the block model's; the DOM document's caret
    // APIs are non-standard / partial in lib.dom, so reach them structurally.
    const doc = this.container.ownerDocument as unknown as {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof doc.caretRangeFromPoint === 'function') {
      const r = doc.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (typeof doc.caretPositionFromPoint === 'function') {
      const p = doc.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

  // Place the caret at a resolved DOM point via sel.collapse (not addRange —
  // WKWebView commits a collapse but can drop an added range; the caret-blindspot
  // note). Rejects a point outside the surface so a drop onto chrome can't move
  // the caret out of the document. Returns whether the caret was placed.
  private placeCaretAtPoint(point: { node: Node; offset: number }): boolean {
    if (!this.container.contains(point.node)) return false;
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.collapse(point.node, point.offset);
    this.container.focus();
    return true;
  }

  // Paste verbatim into a code block: splice the raw clipboard text — newlines and
  // all — into block.text, replacing any selection within the block. Returns false
  // when the caret isn't in a single code block, so the caller runs the normal
  // interpreted paste. Line endings are normalized to \n (the model's one policy);
  // otherwise the text is untouched — no Markdown parsing, no newline flowing.
  private pasteIntoCode(text: string): boolean {
    const t = this.leafTarget();
    if (!t || t.leaf.type !== 'code_block' || t.spansBlocks) return false;
    const raw = text.replace(/\r\n?/g, '\n');
    const next = t.leaf.text.slice(0, t.start) + raw + t.leaf.text.slice(t.end);
    this.editCodeText(t.leaf, t.blockEl, next, t.start + raw.length);
    this.scheduleSerialize();
    return true;
  }

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

  // Cut (SKR-164): deletability is decided BEFORE anything touches the clipboard,
  // so a range that can't actually be deleted never silently degrades to a copy.
  // A block selected as a unit (SKR-203) has no DOM range to read at all — it
  // gets its own path. A plain collapsed selection is left to the browser
  // unchanged, same as before this fix.
  private onCut = (event: Event): void => {
    const e = event as ClipboardEvent;
    if (this.blockSel.length > 0) {
      this.cutBlockSelection(e);
      return;
    }
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return; // nothing selected: leave to the browser
    const plan = this.planRangeCutDeletion();
    if (!plan) {
      e.preventDefault(); // genuinely undeletable: decline rather than degrade to copy
      return;
    }
    if (!this.writeSelectionToClipboard(e)) return; // nothing serializes either: leave to the browser
    plan();
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
        // A selection covering the whole block keeps its type — copying an entire
        // heading yields `# Title`, not bare text (F35). A partial slice strips to
        // a paragraph, so copying a word out of a heading never carries the `#`.
        if (start.offset <= 0 && end.offset >= inlineLength(block.inline)) {
          return serializeDocument({ blocks: [{ ...block, gapBefore: null, dirty: true }], trailingGap: '' });
        }
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

    // Multi-leaf selection: keep exactly the blocks the selection spans and trim
    // the two endpoint leaves in place. Dropping every leaf outside the
    // [start, end] index range stops an unselected barrier (code / table) that
    // sits beyond the document's first/last inline leaf from leaking onto the
    // clipboard (F32); trimming the endpoints in place — rather than merging them
    // into the document's first/last leaf, whose type used to win — keeps each
    // endpoint its own block type (F33). Fully-covered barriers between the ends
    // are kept, since the selection genuinely spans them.
    const startLeafId = start.leaf.id;
    const endLeafId = end.leaf.id;
    const leaves = documentLeaves(this.doc.blocks);
    const si = leaves.findIndex((l) => l.id === startLeafId);
    const ei = leaves.findIndex((l) => l.id === endLeafId);
    if (si < 0 || ei < 0 || si > ei) return null;

    // Endpoints must be inline text to head/tail-trim to Markdown; a barrier
    // endpoint (code / table) defers to the caller's plain-text fallback.
    const startBlock = findBlockById(this.doc.blocks, startLeafId);
    const endBlock = findBlockById(this.doc.blocks, endLeafId);
    if (!startBlock || !endBlock || !isInlineText(startBlock) || !isInlineText(endBlock)) return null;

    const dropIds = new Set<string>();
    for (let i = 0; i < leaves.length; i++) if (i < si || i > ei) dropIds.add(leaves[i]!.id);

    let sliced = removeBlocks(this.doc.blocks, dropIds);
    sliced = updateBlockById(sliced, startLeafId, (b) => {
      const inline = (b as { inline: InlineNode[] }).inline;
      return { ...b, inline: deleteRangeInInline(inline, 0, start.offset), dirty: true } as BlockNode;
    });
    sliced = updateBlockById(sliced, endLeafId, (b) => {
      const inline = (b as { inline: InlineNode[] }).inline;
      return { ...b, inline: deleteRangeInInline(inline, end.offset, inlineLength(inline)), dirty: true } as BlockNode;
    });
    // Dropping the blocks before the selection leaves the new first block's
    // gap (the blank line that separated it from what was removed) as leading
    // blank lines on the copy; clear it so the slice starts at its content.
    if (sliced.length > 0 && sliced[0]!.gapBefore) {
      sliced = [{ ...sliced[0]!, gapBefore: null } as BlockNode, ...sliced.slice(1)];
    }
    return serializeDocument({ blocks: sliced, trailingGap: '' });
  }

  // Plan the deletion half of a cut over the current window selection, computed
  // (not applied) before anything touches the clipboard (SKR-164). A same-leaf
  // range — within one code block, within one table cell — routes through the
  // leaf-local paths Backspace already uses (editCodeText / commitCell), because
  // deleteAcross only ever addresses a CROSS-leaf range (its same-id branch is for
  // plain prose, not a barrier) and clearTableCells would otherwise wipe the whole
  // cell instead of the selected slice. Cross-cell / barrier-crossing ranges reuse
  // the SKR-166 classifier via planBarrierCrossingDeletion. Null when there is
  // genuinely nothing addressable to delete — the caller declines the cut.
  private planRangeCutDeletion(): (() => void) | null {
    const cell = this.cellTarget();
    if (cell) {
      if (cell.spansCells) return this.planBarrierCrossingDeletion();
      if (cell.collapsed) return null;
      return () => this.commitCell(cell, deleteRangeInInline(cell.inline, cell.start, cell.end), cell.start);
    }
    const t = this.leafTarget();
    if (!t) return null;
    if (t.spansBlocks) return this.planBarrierCrossingDeletion();
    if (t.collapsed) return null;
    if (t.leaf.type === 'code_block') {
      const leaf = t.leaf;
      const blockEl = t.blockEl;
      const start = t.start;
      const end = t.end;
      return () => this.editCodeText(leaf, blockEl, leaf.text.slice(0, start) + leaf.text.slice(end), start);
    }
    if (!isInlineText(t.leaf)) return null;
    const id = t.leaf.id;
    const start = t.start;
    const end = t.end;
    return () => {
      const r = deleteAcross(this.doc.blocks, id, start, id, end);
      if (r) this.applyStructural(r);
    };
  }

  // Cut a block selected as a unit (SKR-203 / SKR-164). There is no DOM range to
  // read here — the selection is authoritative surface state — so the payload is
  // built directly from the model rather than through writeSelectionToClipboard,
  // then the block is removed via the substrate's existing deleteSelectedBlocks
  // (one undo step, same as Backspace on a block selection). Declines outright
  // (clipboard and model both untouched) when the selection doesn't resolve to
  // something serializable, never a silent half-cut.
  private cutBlockSelection(e: ClipboardEvent): void {
    const ids = this.blockSel.slice();
    const data = e.clipboardData;
    const md = data ? this.serializeBlockSelectionMarkdown(ids) : null;
    if (!data || md == null) {
      e.preventDefault();
      return;
    }
    const { text, html } = buildClipboardPayload(md);
    data.setData('text/plain', text);
    data.setData('text/html', html);
    e.preventDefault();
    this.deleteSelectedBlocks();
  }

  // Serialize the selected block(s) to Markdown exactly as copy would for a range
  // fully covering them: the same serializeDocument primitive the whole-heading
  // copy branch above uses, applied to whichever barriers are selected. Null when
  // any id isn't a code block / table — a block selection is only ever one of
  // those (SKR-203), so this is a defensive guard, not a real fallback.
  private serializeBlockSelectionMarkdown(ids: string[]): string | null {
    const blocks: BlockNode[] = [];
    for (const id of ids) {
      const block = findBlockById(this.doc.blocks, id);
      if (!block || (block.type !== 'code_block' && block.type !== 'table')) return null;
      blocks.push({ ...block, gapBefore: null, dirty: true } as BlockNode);
    }
    if (blocks.length === 0) return null;
    return serializeDocument({ blocks, trailingGap: '' });
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

  // Parse `md` into blocks and land them at the caret, preserving structure and
  // marks (SKR-119, extended by SKR-174). Returns false (declining) only when the
  // parse yields nothing or the caret is a spot the plain paste owns (a table cell,
  // a code block), so the caller falls back to pasteText. Otherwise handles it:
  //
  //   - a SELECTION is deleted first through the shared delete classifier, then the
  //     pasted blocks land at the resulting collapsed caret — the whole gesture is
  //     one undo step (delete + insert coalesced), and structure/marks survive
  //     because the ordinary collapsed insert runs at the join (F25/defect 1);
  //   - a collapsed caret in a CONTAINER (list item / blockquote) grafts rather
  //     than flattens (F25/defect 2);
  //   - a collapsed caret in a top-level inline leaf splits the caret block, keeping
  //     its identity — a heading never demotes to a paragraph (F25/defect 3).
  //
  // Inline HTML in the pasted prose is neutralized to literal text (F27/defect 4)
  // so a stray `<tag>` doesn't freeze the whole block; block-level HTML still
  // freezes.
  private insertMarkdownBlocks(md: string): boolean {
    const parsed = parseDocument(md, { inlineHtmlAsText: true }).blocks;
    if (parsed.length === 0) return false;

    // A selection (a range of prose, not a collapsed caret and not a table cell —
    // cells and same-block code keep their own leaf-local paste). Delete it through
    // the same classifier Backspace/cut use, then insert at the collapsed join.
    const sel = this.cellTarget() ? null : this.leafTarget();
    if (sel && !sel.collapsed && !(sel.leaf.type === 'code_block' && !sel.spansBlocks)) {
      this.compoundEdit(() => {
        this.deleteSelectionForPaste(sel);
        if (!this.placeParsedAtCollapsedCaret(parsed)) this.appendMarkdownBlocks(parsed);
      });
      return true;
    }

    return this.placeParsedAtCollapsedCaret(parsed);
  }

  // Place already-parsed blocks at the current COLLAPSED caret. Appends when there
  // is no caret target, grafts when the caret is nested in a container, splits the
  // caret block when it is a top-level inline leaf, and declines (false) for a
  // cell / code / non-inline / still-selected caret so the caller can fall back.
  private placeParsedAtCollapsedCaret(parsed: BlockNode[]): boolean {
    const t = this.leafTarget();
    // No caret in the surface (unfocused, or a selection that doesn't resolve to a
    // leaf): append at the document end so a paste never silently vanishes.
    if (!t) {
      this.appendMarkdownBlocks(parsed);
      return true;
    }
    if (!t.collapsed) return false;

    // A collapsed caret nested inside a list item / blockquote: graft the pasted
    // blocks in (SKR-174). A single inline-only paragraph is left to the plain path
    // so a one-line paste merges as text rather than opening a new list item.
    if (isInlineText(t.leaf) && !this.isTopLevel(t.blockEl, t.leaf.id)) {
      if (parsed.length === 1 && parsed[0]!.type === 'paragraph') return false;
      return this.graftIntoContainerAt(parsed, t.leaf.id, t.start);
    }

    // A caret that isn't a top-level inline leaf (code, table cell) falls back to
    // the plain paste path, which handles those in place — see SKR-119 scope.
    if (!isInlineText(t.leaf) || !this.isTopLevel(t.blockEl, t.leaf.id)) return false;

    const index = this.doc.blocks.findIndex((b) => b.id === t.leaf.id);
    if (index < 0) return false;

    const [head, tail] = splitInline(t.leaf.inline, t.start);

    // Seamless single-paragraph merge — like typing the text in at the caret.
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

    // Structured / multi-block paste: split the caret block around the insertion,
    // keeping its identity (a heading never demotes) — spliceParsedAtLeaf.
    const { blocks: out, caret } = spliceParsedAtLeaf(t.leaf, t.start, parsed, generateBlockId);
    const blocks = this.doc.blocks.slice();
    blocks.splice(index, 1, ...out);
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: caret.id }, offset: caret.offset }), 'paste');
    this.scheduleSerialize();
    return true;
  }

  // Delete the current prose selection ahead of a paste, leaving a collapsed caret
  // at the join. A cross-block / barrier range goes through the shared classifier
  // (deleteSelectionRange — clamp/clear semantics unchanged); a within-leaf range
  // is a leaf-local inline delete. Runs inside compoundEdit, so it records no undo
  // step of its own.
  private deleteSelectionForPaste(t: { leaf: BlockNode; blockEl: HTMLElement; start: number; end: number; spansBlocks: boolean }): void {
    if (t.spansBlocks) {
      this.deleteSelectionRange();
      return;
    }
    if (!isInlineText(t.leaf)) return;
    const inline = deleteRangeInInline(t.leaf.inline, t.start, t.end);
    this.commitInline(t.leaf.id, inline, t.blockEl, t.start);
  }

  // Graft pasted blocks into the container holding the caret leaf (list / quote),
  // splitting out any block a container can't hold after the top-level container.
  // Returns false when the leaf isn't actually nested in a container.
  private graftIntoContainerAt(parsed: BlockNode[], leafId: string, offset: number): boolean {
    const result = graftIntoContainer(this.doc.blocks, leafId, offset, parsed, generateBlockId);
    if (!result) return false;
    this.applyStructural(result);
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

  // Click below the last block: give it a caret home. Native placement lands
  // inside a trailing barrier's fence/cell or nowhere (F57), so a click in the
  // empty area under the document places the caret at the end of a trailing inline
  // block, or seeds a fresh paragraph after a trailing barrier so the document is
  // never un-appendable. Bound to `click` (not pointerup — WKWebView drops it on a
  // motionless press).
  private onClick = (event: Event): void => {
    const last = this.doc.blocks[this.doc.blocks.length - 1];
    if (!last) return;
    const lastEl = this.registry.get(last.id);
    if (!lastEl) return;
    // Only act on a click strictly below the last block — its own content, and the
    // gaps between blocks, are handled by native placement.
    if ((event as MouseEvent).clientY <= lastEl.getBoundingClientRect().bottom) return;
    if (isInlineText(last)) {
      this.focus();
      setCaret(lastEl, inlineLength(last.inline));
      return;
    }
    const para = this.newInlineBlock('paragraph', [], 1);
    this.doc = { ...this.doc, blocks: [...this.doc.blocks, para] };
    this.reconcile();
    this.focus();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id: para.id }, offset: 0 }), 'structural');
    this.scheduleSerialize();
  };

  private onCompositionStart = (): void => {
    this.composing = true;
  };

  private onCompositionEnd = (): void => {
    this.composing = false;
    // The IME mutated the focused block's DOM natively; read it back into the
    // model without re-rendering (the caret the IME left is correct). Every
    // editable leaf must be covered or the composed text lives only in the DOM
    // and is lost on the next serialize / re-render (SKR-156 / F82).

    // A table cell: focusedLeafElement resolves the whole table, so read the
    // specific cell out of the selection and write just that cell back.
    const cell = this.cellTarget();
    if (cell) {
      this.updateCellModel(cell, readInlineFromDOM(cell.cellEl));
      this.scheduleSerialize();
      return;
    }

    const blockEl = focusedLeafElement(this.container);
    if (!blockEl) return;
    const id = blockEl.getAttribute(BLOCK_ID_ATTR);
    if (id == null) return;
    const leaf = findBlockById(this.doc.blocks, id);
    if (!leaf) return;

    // A code block: its content is a raw <code> text node, not inline runs. Read
    // the text straight from the DOM into the model — not via editCodeText, which
    // re-renders and would move the caret the IME just committed.
    if (leaf.type === 'code_block') {
      const text = (blockEl.querySelector('code') ?? blockEl).textContent ?? '';
      this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, id, (b) => (b.type === 'code_block' ? ({ ...b, text, dirty: true } as BlockNode) : b)) };
      this.scheduleSerialize();
      return;
    }

    if (!isInlineText(leaf)) return;
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, id, (b) => ({ ...b, inline: readInlineFromDOM(blockEl), dirty: true }) as BlockNode) };
    this.scheduleSerialize();
  };

  private applyInsertText(text: string): void {
    this.nextEditKind = 'type'; // consecutive keystrokes coalesce into one undo
    const cell = this.cellTarget();
    if (cell) {
      // Typing over a cross-cell / table-crossing selection replaces it rather
      // than eating the keystroke (SKR-166); replaceSelectionRange classifies.
      if (cell.spansCells) {
        this.replaceSelectionRange(text);
        return;
      }
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
      // A selection dragged across cells (or out of the table) is barrier-aware:
      // clear the covered cells, or clamp a table-crossing range to the prose edges
      // — the table survives either way (SKR-166). deleteSelectionRange classifies.
      if (cell.spansCells) {
        this.deleteSelectionRange();
        this.closeSlash();
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

    // Backspace on an EMPTY code block deletes it (via deleteBlock); a
    // non-empty block keeps its no-op boundary (SKR-152). Checked independent of
    // the reported offset: an empty <code> carries a placeholder <br>, whose
    // range.toString() length is 0 in Chromium but can read as 1 in WKWebView —
    // an empty block has only one caret position either way.
    if (t.collapsed && t.leaf.type === 'code_block' && t.leaf.text.length === 0) {
      const r = deleteBlock(this.doc.blocks, t.leaf.id);
      if (r) this.applyStructural(r);
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
        // A null merge means the previous leaf is a barrier, not that there is
        // none (SKR-167): a divider gets deleted outright, a code block / table
        // gets selected instead of eating the gesture.
        else this.handleBarrierAdjacency(t.leaf.id, 0, 'backward');
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
      // Cross-cell / table-crossing selection: same barrier-aware handling as
      // Backspace (clear covered cells, or clamp to the prose edges).
      if (cell.spansCells) {
        this.deleteSelectionRange();
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
      if (t.leaf.type === 'code_block' && len === 0) {
        // Delete on an EMPTY code block removes it (mirror of Backspace-at-start).
        const r = deleteBlock(this.doc.blocks, t.leaf.id);
        if (r) this.applyStructural(r);
      } else if (isInlineText(t.leaf)) {
        // Pull the next inline leaf up into this one (across a container boundary).
        const r = mergeForward(this.doc.blocks, t.leaf.id);
        if (r) this.applyStructural(r);
        // A null merge means the next leaf is a barrier, not that there is none
        // (SKR-167): a divider gets deleted outright, a code block / table gets
        // selected instead of eating the gesture.
        else this.handleBarrierAdjacency(t.leaf.id, t.start, 'forward');
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

  // Word / line delete (SKR-165). Only a COLLAPSED caret mid-run needs the scan:
  // it deletes the computed [from, to) slice through the same leaf-local path a
  // plain Backspace uses (commitInline / editCodeText / commitCell), one undo
  // step. Every other shape is byte-for-byte a plain char delete — a non-collapsed
  // selection deletes exactly that selection, and a caret at the run edge
  // (from === to) hands off to the boundary merge / barrier action — so it
  // delegates to applyDeleteBackward / applyDeleteForward rather than reinventing
  // those branches. `direction` is 'backward' (⌥⌫ / ⌘⌫) or 'forward' (their fn
  // mirrors); `scan` is wordScan or lineScan.
  private applyRunDelete(direction: 'backward' | 'forward', scan: RunScan): void {
    const cell = this.cellTarget();
    if (cell && cell.collapsed && !cell.spansCells) {
      const [from, to] = scan(inlinePlainText(cell.inline), cell.start, false, direction);
      if (from >= to) return this.plainDelete(direction); // at the cell edge
      this.nextEditKind = 'other'; // a word / line delete is its own atomic step
      this.commitCell(cell, deleteRangeInInline(cell.inline, from, to), from);
      this.scheduleSerialize();
      return;
    }
    const t = this.leafTarget();
    if (t && t.collapsed && !t.spansBlocks && (t.leaf.type === 'code_block' || isInlineText(t.leaf))) {
      const leaf = t.leaf;
      if (leaf.type === 'code_block') {
        const [from, to] = scan(leaf.text, t.start, true, direction);
        if (from >= to) return this.plainDelete(direction); // at the code-line / block edge
        this.nextEditKind = 'other';
        this.editCodeText(leaf, t.blockEl, leaf.text.slice(0, from) + leaf.text.slice(to), from);
        this.scheduleSerialize();
        return;
      }
      const [from, to] = scan(inlinePlainText(leaf.inline), t.start, false, direction);
      if (from >= to) return this.plainDelete(direction); // at the leaf edge
      this.nextEditKind = 'other';
      this.commitInline(leaf.id, deleteRangeInInline(leaf.inline, from, to), t.blockEl, from);
      this.scheduleSerialize();
      this.refreshSlash(); // an open slash menu tracks the edit, as plain delete does
      return;
    }
    // A selection (delete it), no caret, or a leaf the scan doesn't own: identical
    // to a plain char delete, which already routes every one of those shapes.
    this.plainDelete(direction);
  }

  private plainDelete(direction: 'backward' | 'forward'): void {
    if (direction === 'backward') this.applyDeleteBackward();
    else this.applyDeleteForward();
  }

  // Backspace-at-start / Delete-at-end next to a barrier that mergeBackward /
  // mergeForward refused to merge across (SKR-167): a leading divider was
  // otherwise undeletable (there's no prose before it to select across) and a
  // code block / table sat there un-actionable from outside it. A content-free
  // atom (hr) deletes outright, one gesture and one undo step; a content-bearing
  // barrier (code block / table) gets selected as a unit instead — Notion's
  // first-Backspace-selects convention, reusing SKR-203's substrate — so a
  // second Backspace/Delete (routed through handleBlockSelectionKey) deletes it.
  // `offset` is the caret's own offset in `leafId`, restored after an hr delete
  // since that leaf is untouched by removing its distant neighbour.
  private handleBarrierAdjacency(leafId: string, offset: number, direction: 'backward' | 'forward'): void {
    const neighbor = barrierNeighbor(this.doc.blocks, leafId, direction);
    if (!neighbor) return; // no leaf in that direction at all: the boundary stands
    if (neighbor.type === 'horizontal_rule') {
      const r = deleteBlock(this.doc.blocks, neighbor.id);
      if (r) this.applyStructural({ blocks: r.blocks, caret: { id: leafId, offset } });
      return;
    }
    if (neighbor.type === 'code_block' || neighbor.type === 'table') {
      this.selectBlock(neighbor.id);
    }
    // image / frozen barriers fall through unchanged: SKR-203's block-selection
    // substrate isn't wired for them, so this stays out of scope for SKR-167.
  }

  // Enter: in a code block, insert a newline. Otherwise split the block — but in
  // Stage 3e only at top level (nested split / list-item Enter is 3f); the
  // original keeps its id and first half, the new block mints an id (split mints).
  private applyEnter(): void {
    // Enter in a table cell steps to the cell directly below, and exits below the
    // table from the last row — a spreadsheet-style move (F46). Was a silent no-op.
    // (An in-cell line break isn't used: a cell serializes its breaks to a space on
    // the Markdown floor, so it wouldn't round-trip until .folio.)
    const cell = this.cellTarget();
    if (cell) {
      // A cross-cell / table-crossing selection was a silent no-op until SKR-164
      // (166 fixed Backspace/Delete/type-over but left Enter behind): clear/clamp
      // it first, exactly like those, then re-run Enter at the resulting collapsed
      // caret so it gets ordinary Enter semantics rather than an invented split.
      if (cell.spansCells) {
        this.enterOverSelection();
        return;
      }
      const table = findBlockById(this.doc.blocks, cell.tableId);
      if (!table || table.type !== 'table') return;
      if (cell.row < table.rows.length - 1) this.focusCell(table, cell.row + 1, cell.col, cell.start);
      else this.exitBarrier(cell.tableId, 'after');
      return;
    }
    const t = this.leafTarget();
    if (!t) return;
    if (t.spansBlocks) {
      this.enterOverSelection();
      return;
    }
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
    // Enter at the END of a heading drops to body text (the Docs/Notion
    // convention); splitting mid-heading keeps the heading type for the rest.
    const rightType = t.leaf.type === 'heading' && inlineLength(right) === 0 ? 'paragraph' : t.leaf.type;
    const level = t.leaf.type === 'heading' ? t.leaf.level : 1;
    const rightBlock = this.newInlineBlock(rightType, right, level);

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

  // Enter over a cross-cell or table-crossing selection (SKR-164, the Enter
  // sibling of SKR-166's Backspace/Delete/type-over fix): clear the covered cells
  // or clamp to the prose edges — the same classifier deleteSelectionRange uses —
  // then re-run Enter at the resulting collapsed caret, so the caller gets
  // whatever Enter already does there (step to the cell below / split the
  // surviving prose) instead of a split rule invented for the selection shape.
  // A shape the clamp can't address (no prose survives between two adjacent
  // barriers) leaves the selection unchanged, so bail rather than loop.
  private enterOverSelection(): void {
    this.deleteSelectionRange();
    this.closeSlash();
    const after = readSelection(this.container);
    if (!after || !isCollapsed(after)) return;
    this.applyEnter();
  }

  // Boundary merges (Backspace at a block start, Delete at a block end) and
  // cross-block selection delete / replace all go through the document range ops
  // (range-ops.ts) and applyStructural — one spine, container-aware, instead of
  // the old top-level-only splices.

  // Delete the current cross-block selection as a single range op. An in-table
  // cross-cell selection clears the covered cells (table survives); a selection
  // that crosses a barrier (table / code) is clamped to the prose edges, so the
  // barrier survives and the prose up to it is deleted (SKR-166).
  private deleteSelectionRange(): void {
    const plan = this.planBarrierCrossingDeletion();
    if (plan) plan();
  }

  // Compute (without applying) the deletion for a cross-cell or barrier-crossing
  // selection, so a caller can know whether it will do anything before committing
  // to a side effect (cut needs this — SKR-164). Null when the range holds no
  // prose to delete at all (e.g. two adjacent barriers with nothing between them)
  // or is a single leaf (the leaf-local path handles that shape instead).
  private planBarrierCrossingDeletion(): (() => void) | null {
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return null;
    const norm = this.normalizeSelection(range);
    if (!norm) return null;
    if (norm.kind === 'cells') return () => this.clearCrossCells(norm);
    if (norm.start.id === norm.end.id) return null; // single leaf: the block-local path handles it
    const result = deleteAcross(this.doc.blocks, norm.start.id, norm.start.offset, norm.end.id, norm.end.offset);
    return result ? () => this.applyStructural(result) : null;
  }

  // Replace the current cross-block selection with typed / pasted text. Mirrors
  // deleteSelectionRange's classification: cross-cell clears the covered cells and
  // types into the first, a barrier-crossing range clamps to the prose edges.
  private replaceSelectionRange(text: string): void {
    const range = readSelection(this.container);
    if (!range || isCollapsed(range)) return;
    const norm = this.normalizeSelection(range);
    if (!norm) return;
    if (norm.kind === 'cells') {
      this.replaceCrossCells(norm, text);
      return;
    }
    if (norm.start.id === norm.end.id) return;
    const r = replaceAcross(this.doc.blocks, norm.start.id, norm.start.offset, norm.end.id, norm.end.offset, text);
    if (r) this.applyStructural(r);
  }

  // Classify a cross-endpoint selection into the two barrier-aware shapes
  // (SKR-166 / F55): an in-table cross-cell selection (both endpoints cells of the
  // same table) that clears the covered cells, versus a block range whose cell
  // endpoints are mapped to their table's barrier position so deleteAcross snaps
  // them inward. Endpoints are returned in document order. Null when unaddressable.
  private normalizeSelection(range: DocRange): CrossCellSelection | NormalizedBlockRange | null {
    const a = range.anchor.leaf;
    const f = range.focus.leaf;
    if (a.kind === 'cell' && f.kind === 'cell' && a.tableId === f.tableId) {
      return {
        kind: 'cells',
        tableId: a.tableId,
        minRow: Math.min(a.row, f.row),
        maxRow: Math.max(a.row, f.row),
        minCol: Math.min(a.col, f.col),
        maxCol: Math.max(a.col, f.col)
      };
    }
    // Map a cell endpoint to its table's barrier position (offset is irrelevant —
    // deleteAcross snaps a barrier endpoint away). A prose endpoint keeps its offset.
    const anchor = a.kind === 'cell' ? { id: a.tableId, offset: 0 } : { id: a.id, offset: range.anchor.offset };
    const focus = f.kind === 'cell' ? { id: f.tableId, offset: 0 } : { id: f.id, offset: range.focus.offset };
    const leaves = documentLeaves(this.doc.blocks);
    const ai = leaves.findIndex((l) => l.id === anchor.id);
    const fi = leaves.findIndex((l) => l.id === focus.id);
    if (ai < 0 || fi < 0) return null;
    const [start, end] = ai < fi || (ai === fi && anchor.offset <= focus.offset) ? [anchor, focus] : [focus, anchor];
    return { kind: 'blocks', start, end };
  }

  // Empty every cell the selection covers, then land the caret at the top-left of
  // the cleared block. The table and its shape survive (the Docs cross-cell delete).
  private clearCrossCells(sel: CrossCellSelection): void {
    const blocks = clearTableCells(this.doc.blocks, sel.tableId, sel.minRow, sel.minCol, sel.maxRow, sel.maxCol);
    if (!blocks) return;
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const table = findBlockById(this.doc.blocks, sel.tableId);
    if (table && table.type === 'table') this.focusCell(table, sel.minRow, sel.minCol, 0);
    this.scheduleSerialize();
    this.closeSlash();
  }

  // Clear the covered cells, then type `text` into the top-left one — the cross-cell
  // equivalent of replacing a prose selection.
  private replaceCrossCells(sel: CrossCellSelection, text: string): void {
    const cleared = clearTableCells(this.doc.blocks, sel.tableId, sel.minRow, sel.minCol, sel.maxRow, sel.maxCol);
    if (!cleared) return;
    const blocks = updateBlockById(cleared, sel.tableId, (b) => {
      if (b.type !== 'table') return b;
      const rows = b.rows.map((row, r) =>
        r === sel.minRow ? row.map((cell, c) => (c === sel.minCol ? insertTextInInline([], 0, text) : cell)) : row
      );
      return { ...b, rows, dirty: true } as BlockNode;
    });
    this.doc = { ...this.doc, blocks };
    this.reconcile();
    const table = findBlockById(this.doc.blocks, sel.tableId);
    if (table && table.type === 'table') this.focusCell(table, sel.minRow, sel.minCol, text.length);
    this.scheduleSerialize();
  }

  // --- block selection: a code block / table as a unit (SKR-203) ------------

  /** The barrier block (code block / table) the caret sits in, by id, or null when
   *  the caret is in prose. The unit Escape and the ⌘A block-step select. */
  private currentBarrierBlockId(): string | null {
    const cell = this.cellTarget();
    if (cell) return cell.tableId;
    const t = this.leafTarget();
    if (t && !t.spansBlocks && t.leaf.type === 'code_block') return t.leaf.id;
    return null;
  }

  /** Select a whole block as a unit. Stores the id as authoritative state, paints
   *  the ring, then clears the DOM selection while KEEPING focus on the surface —
   *  so keydown still routes here and the state never depends on a live
   *  (WKWebView-collapsible) selection. */
  private selectBlock(id: string): void {
    this.blockSel = [id];
    this.renderBlockSelection();
    window.getSelection()?.removeAllRanges();
    this.container.focus();
    this.emitSelection();
  }

  /** Paint the ring: clear any stale marks, then mark the current selection's
   *  elements. Idempotent, so re-render after a reconcile is safe. */
  private renderBlockSelection(): void {
    for (const el of this.container.querySelectorAll(`[${BLOCK_SELECTED_ATTR}]`)) {
      el.removeAttribute(BLOCK_SELECTED_ATTR);
    }
    for (const id of this.blockSel) this.leafElementById(id)?.setAttribute(BLOCK_SELECTED_ATTR, '');
  }

  /** Clear the block-selection state and its ring, without moving the caret. */
  private clearBlockSelectionState(): void {
    if (this.blockSel.length === 0) return;
    this.blockSel = [];
    for (const el of this.container.querySelectorAll(`[${BLOCK_SELECTED_ATTR}]`)) {
      el.removeAttribute(BLOCK_SELECTED_ATTR);
    }
  }

  /** Keys owned while a block is selected. Returns true when consumed. Undo/redo
   *  and other chords fall through (return false) to the normal handler. */
  private handleBlockSelectionKey(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    const key = e.key;
    // ⌘A's third step: select the whole document.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && key.toLowerCase() === 'a' && !e.shiftKey) {
      e.preventDefault();
      this.selectDocument();
      return true;
    }
    // Let undo/redo (and any other chord) run through the normal handler.
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault();
      this.deleteSelectedBlocks();
      return true;
    }
    if (key === 'Escape' || key === 'ArrowUp' || key === 'ArrowLeft') {
      e.preventDefault();
      this.dissolveBlockSelectionToCaret('before');
      return true;
    }
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      e.preventDefault();
      this.dissolveBlockSelectionToCaret('after');
      return true;
    }
    // A printable character replaces the block with a paragraph of that character.
    if (key.length === 1) {
      e.preventDefault();
      this.replaceSelectedBlockWithText(key);
      return true;
    }
    return false;
  }

  /** ⌘A inside a barrier, escalating leaf text -> whole block. Returns false when
   *  the caret is not in a barrier, so the browser's own select-all runs. The
   *  block -> document step is handled while a block is already selected. */
  private handleSelectAll(): boolean {
    const cell = this.cellTarget();
    if (cell) {
      const len = inlineLength(cell.inline);
      const full = len === 0 || (!cell.spansCells && cell.start === 0 && cell.end === len);
      if (full) this.selectBlock(cell.tableId);
      else setSelectionRange(cell.cellEl, 0, len);
      return true;
    }
    const t = this.leafTarget();
    if (t && !t.spansBlocks && t.leaf.type === 'code_block') {
      const len = t.leaf.text.length;
      const full = len === 0 || (!t.collapsed && t.start === 0 && t.end === len);
      if (full) this.selectBlock(t.leaf.id);
      else setSelectionRange(t.blockEl, 0, len);
      return true;
    }
    return false;
  }

  /** ⌘A's third step: dissolve the ring and select the whole document. A ranged
   *  selection (not a post-rebuild caret), so a plain range is safe here. */
  private selectDocument(): void {
    this.clearBlockSelectionState();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(this.container);
    sel.addRange(range);
    this.emitSelection();
  }

  /** Delete the selected block(s) as one undo step. deleteBlock repositions the
   *  caret onto an inline neighbour and seeds a paragraph when the doc empties. */
  private deleteSelectedBlocks(): void {
    const ids = this.blockSel.slice();
    if (ids.length === 0) return;
    this.clearBlockSelectionState();
    // Single block is the only shape today's gestures produce.
    if (ids.length === 1) {
      const r = deleteBlock(this.doc.blocks, ids[0]!);
      if (r) this.applyStructural(r);
    } else {
      // Plural-ready: fold the rest into the same removeBlocks so it stays one
      // undo step, landing the caret beside the first removed block.
      const first = deleteBlock(this.doc.blocks, ids[0]!);
      if (first) {
        const blocks = removeBlocks(first.blocks, new Set(ids.slice(1)));
        this.applyStructural({ blocks, caret: first.caret });
      }
    }
    this.closeSlash();
  }

  /** Typing over a selected block: replace it with a paragraph holding the typed
   *  character, reusing the block's id + seam. One doc assignment => one undo step,
   *  so a single undo restores the original block. */
  private replaceSelectedBlockWithText(text: string): void {
    const id = this.blockSel[0];
    if (!id) return;
    this.clearBlockSelectionState();
    const orig = findBlockById(this.doc.blocks, id);
    if (!orig) return;
    const para: BlockNode = {
      type: 'paragraph',
      id,
      durable: false,
      src: null,
      gapBefore: orig.gapBefore,
      dirty: true,
      inline: text ? [{ kind: 'text', text, marks: {} }] : []
    };
    this.doc = { ...this.doc, blocks: updateBlockById(this.doc.blocks, id, () => para) };
    this.reconcile();
    writeSelection(this.container, collapsedRange({ leaf: { kind: 'block', id }, offset: text.length }), 'structural');
    this.scheduleSerialize();
  }

  /** Dissolve the block selection back to a text caret. 'before' lands at the end
   *  of the previous inline leaf (or just before the block); 'after' at the start
   *  of the next. Reuses exitBarrier, which seeds a paragraph when there is no
   *  inline neighbour and places the caret through the robust path. */
  private dissolveBlockSelectionToCaret(side: 'before' | 'after'): void {
    const id = this.blockSel[0];
    this.clearBlockSelectionState();
    if (!id) return;
    if (this.exitBarrier(id, side)) return;
    // Fallback for a nested barrier exitBarrier cannot step out of: caret at the
    // block's own start (still via sel.collapse, never a bare addRange).
    const el = this.leafElementById(id);
    if (el) setCaret(el, 0);
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
    if (ctx) {
      const id = ctx.blockEl.getAttribute(BLOCK_ID_ATTR);
      if (id == null) return null;
      const leaf = findBlockById(this.doc.blocks, id);
      if (!leaf) return null;
      return { leaf, blockEl: ctx.blockEl, start: ctx.start, end: ctx.end, collapsed: ctx.collapsed, spansBlocks: ctx.spansBlocks };
    }
    return this.leafTargetFromSaved();
  }

  /** The saved-selection fallback for leafTarget: with no live selection (WKWebView
   *  collapsed it on focus loss), reconstruct the target from the last observed
   *  range so a palette list / link command still acts on the right leaf. Resolves
   *  nested leaves too (findBlockById + leafElementById, unlike the top-level-only
   *  savedTopLevelBlock). Refuses during a block selection and when the saved block
   *  is gone; clamps the offsets to the leaf's current length. spansBlocks is false
   *  by construction — a leaf-local saved range can never cross blocks. */
  private leafTargetFromSaved(): {
    leaf: BlockNode;
    blockEl: HTMLElement;
    start: number;
    end: number;
    collapsed: boolean;
    spansBlocks: boolean;
  } | null {
    if (this.blockSel.length > 0) return null;
    const saved = this.lastSelection;
    if (!saved) return null;
    const leaf = findBlockById(this.doc.blocks, saved.blockId);
    if (!leaf) return null;
    const blockEl = this.leafElementById(saved.blockId);
    if (!blockEl) return null;
    const len = isInlineText(leaf) ? inlineLength(leaf.inline) : leaf.type === 'code_block' ? leaf.text.length : 0;
    const start = Math.min(saved.start, len);
    const end = Math.min(saved.end, len);
    return { leaf, blockEl, start, end, collapsed: start === end, spansBlocks: false };
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
          : this.exitBarrier(cell.tableId, 'before');
      case 'ArrowDown':
        return cell.row < rows - 1
          ? this.focusCell(table, cell.row + 1, cell.col, cell.start)
          : this.exitBarrier(cell.tableId, 'after');
      case 'ArrowLeft':
        if (cell.start > 0) return false; // move within the cell's text
        if (cell.col > 0) return this.focusCellEnd(table, cell.row, cell.col - 1);
        if (cell.row > 0) return this.focusCellEnd(table, cell.row - 1, cols - 1);
        return this.exitBarrier(cell.tableId, 'before');
      case 'ArrowRight':
        if (cell.start < len) return false; // move within the cell's text
        if (cell.col < cols - 1) return this.focusCell(table, cell.row, cell.col + 1, 0);
        if (cell.row < rows - 1) return this.focusCell(table, cell.row + 1, 0, 0);
        return this.exitBarrier(cell.tableId, 'after');
      default:
        return false;
    }
  }

  // Arrow-key exit for a code block: like handleTableArrow, at the fence's edges
  // step the caret OUT to the adjacent block (seeding a paragraph when the code
  // block is the last block), since the native caret can't reliably leave a code
  // block and dead-ends there (SKR-152). Mid-text arrows fall through to native
  // movement. Returns true when it handled the key (caller preventDefaults).
  private handleCodeArrow(e: KeyboardEvent): boolean {
    const t = this.leafTarget();
    if (!t || !t.collapsed || t.leaf.type !== 'code_block') return false;
    if (!this.isTopLevel(t.blockEl, t.leaf.id)) return false; // nested: native
    const text = t.leaf.text;
    const at = t.start;
    switch (e.key) {
      case 'ArrowRight':
        return at >= text.length ? this.exitBarrier(t.leaf.id, 'after') : false;
      case 'ArrowLeft':
        return at <= 0 ? this.exitBarrier(t.leaf.id, 'before') : false;
      case 'ArrowDown':
        // On the last visual line (no newline at or after the caret) -> exit below.
        return text.indexOf('\n', at) === -1 ? this.exitBarrier(t.leaf.id, 'after') : false;
      case 'ArrowUp':
        // On the first line (no newline before the caret) -> exit above.
        return text.lastIndexOf('\n', at - 1) === -1 ? this.exitBarrier(t.leaf.id, 'before') : false;
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
  // Step the caret out of a barrier block (table / code block) to the adjacent
  // inline block, seeding a fresh paragraph when none exists — so a barrier is
  // never a one-way trap, whether it sits mid-document or is the last block.
  private exitBarrier(blockId: string, dir: 'before' | 'after'): boolean {
    const index = this.doc.blocks.findIndex((b) => b.id === blockId);
    if (index < 0) return false; // nested barrier: leave it to native movement
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
    setCodeContent(code as HTMLElement, next);
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
    // The doc changed; a snapshot is now owed. flush() reads this to know an emit
    // is still pending even after the debounce hands off to requestIdleCallback.
    this.dirtySinceEmit = true;
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      // Run the cold path (serialize + store write + lint + app re-render) during
      // an idle gap so it never lands between keystrokes — the "type 3, pause,
      // 4th" hitch. flush() (Cmd-S / quit / unmount) still runs it synchronously.
      // Track the idle handle so flush()/destroy() can cancel a deferred emit.
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
        .requestIdleCallback;
      if (typeof ric === 'function') {
        this.idleHandle = ric(() => {
          this.idleHandle = null;
          this.emitDocChange();
        }, { timeout: 1000 });
      } else {
        this.emitDocChange();
      }
    }, SERIALIZE_DEBOUNCE_MS);
  }

  /** Hand the current document to the consumer and clear the pending flag. The
   *  single choke point through which a snapshot ever reaches onDocChange. */
  private emitDocChange(): void {
    this.dirtySinceEmit = false;
    this.onDocChange?.(this.doc);
  }

  /** Cancel a deferred idle emit if one is scheduled. */
  private cancelIdle(): void {
    if (this.idleHandle == null) return;
    const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void })
      .cancelIdleCallback;
    if (typeof cancel === 'function') cancel(this.idleHandle);
    this.idleHandle = null;
  }
}

export type { InlineNode };
