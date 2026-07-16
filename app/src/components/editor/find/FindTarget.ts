// The medium-specific backend the FindBar drives. The bar owns the generic find
// logic (query state, the ordered hit list, the active index, cycling); a target
// owns only what differs between editors: how to search, paint the highlights,
// replace, and save/restore the caret. The block target (below) backs `.folio` via
// the surface's find API + decoration overlay; the textarea target for `.md` /
// plain text arrives with that stage.
//
// A hit is a flat range; `blockId` is present for the block target (its offset
// space is per-leaf) and absent for the textarea target (offsets into the raw
// value). The bar treats hits opaquely and hands them back to the target.

import type { BlockSurface } from '../../../lib/blocksurface';
import { findInDocument, findRanges, replaceRangesInString, type FindFlags } from '../../../lib/find/engine';
import type { TextareaHighlighter } from './TextareaHighlighter';

export type FindHit = { blockId?: string; start: number; end: number };

export interface FindTarget {
  /** All matches of the query in document order. */
  search(query: string, flags: FindFlags): FindHit[];
  /** Paint every match, mark the active one distinctly, and reveal it — without
   *  taking focus, so the bar keeps the keyboard. */
  highlight(hits: FindHit[], activeIndex: number): void;
  /** Remove all find highlights. */
  clearHighlight(): void;
  /** Replace one hit; its own undo step. */
  replace(hit: FindHit, replacement: string): void;
  /** Replace every hit in a single undo step. */
  replaceAll(hits: FindHit[], replacement: string): void;
  /** Remember the caret so Esc can restore it. */
  saveSelection(): void;
  /** Restore the caret saved at open. */
  restoreSelection(): void;
}

/** Find target over the bespoke block surface (`.folio`): searches the block
 *  model, paints via the decoration overlay, and edits through the surface's
 *  find/replace API. */
export class BlockFindTarget implements FindTarget {
  private saved: ReturnType<BlockSurface['readSelectionRange']> = null;

  constructor(private readonly surface: BlockSurface) {}

  search(query: string, flags: FindFlags): FindHit[] {
    return findInDocument(this.surface.getDocument().blocks, query, flags);
  }

  highlight(hits: FindHit[], activeIndex: number): void {
    const dec = this.surface.decorations;
    const active = hits[activeIndex];
    // Every match except the active one paints as find-match; the active one paints
    // as find-active (its stronger style sits on top) so it reads as "this one".
    dec.setType(
      'find-match',
      hits
        .filter((_, i) => i !== activeIndex)
        .filter((h) => h.blockId != null)
        .map((h) => ({ blockId: h.blockId!, start: h.start, end: h.end, type: 'find-match' as const }))
    );
    dec.setType(
      'find-active',
      active?.blockId != null
        ? [{ blockId: active.blockId, start: active.start, end: active.end, type: 'find-active' as const }]
        : []
    );
    if (active?.blockId != null) this.surface.revealBlock(active.blockId);
  }

  clearHighlight(): void {
    this.surface.decorations.clearType('find-match');
    this.surface.decorations.clearType('find-active');
  }

  replace(hit: FindHit, replacement: string): void {
    if (hit.blockId != null) this.surface.replaceMatch(hit.blockId, hit.start, hit.end, replacement);
  }

  replaceAll(hits: FindHit[], replacement: string): void {
    this.surface.replaceAll(
      hits.filter((h) => h.blockId != null).map((h) => ({ blockId: h.blockId!, start: h.start, end: h.end })),
      replacement
    );
  }

  saveSelection(): void {
    this.saved = this.surface.readSelectionRange();
  }

  restoreSelection(): void {
    if (this.saved) this.surface.applySelection(this.saved);
  }
}

/** Find target over a raw `<textarea>` (`.md` / plain text): matches the raw value,
 *  paints through a highlight backdrop (native selection is invisible while the
 *  find bar holds focus), and edits with setRangeText so replacing never steals
 *  focus from the bar. Offsets index the raw string, so hits carry no blockId. */
export class TextareaFindTarget implements FindTarget {
  private savedStart = 0;
  private savedEnd = 0;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly highlighter: TextareaHighlighter
  ) {}

  search(query: string, flags: FindFlags): FindHit[] {
    return findRanges(this.textarea.value, query, flags).map((r) => ({ start: r.start, end: r.end }));
  }

  highlight(hits: FindHit[], activeIndex: number): void {
    this.highlighter.render(hits, activeIndex);
  }

  clearHighlight(): void {
    this.highlighter.clear();
  }

  replace(hit: FindHit, replacement: string): void {
    this.textarea.setRangeText(replacement, hit.start, hit.end, 'preserve');
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  replaceAll(hits: FindHit[], replacement: string): void {
    if (hits.length === 0) return;
    // Rebuild the whole value once and apply it as a single edit — one input event,
    // one value change. Hits are already in ascending order.
    const out = replaceRangesInString(this.textarea.value, hits, replacement);
    this.textarea.setRangeText(out, 0, this.textarea.value.length, 'preserve');
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  saveSelection(): void {
    this.savedStart = this.textarea.selectionStart;
    this.savedEnd = this.textarea.selectionEnd;
  }

  restoreSelection(): void {
    this.textarea.focus();
    this.textarea.setSelectionRange(this.savedStart, this.savedEnd);
  }
}
