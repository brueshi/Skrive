// The spellcheck controller: what decides which blocks get judged, when, and
// which of the answers become squiggles.
//
// Three properties shape the whole design.
//
// NOTHING ON THE KEYSTROKE PATH. An edit costs one Set insert on the bus. The
// actual work — reading the document, masking text, the round trip to the host
// checker, painting decorations — happens on a trailing debounce once typing
// settles, and never inside an input event.
//
// VIEWPORT-SCOPED. Only blocks near the viewport are checked and painted. This
// is not a shortcut: a decoration is measured geometry, and the overlay
// reassesses every decorated block on each structural pass, so a document-wide
// misspelling set would turn one Enter keypress into thousands of range
// measurements. Answers are cached by block text, so scrolling back is free and
// nothing is re-asked. It is also the shape virtualization will want.
//
// CACHED BY TEXT, NOT BY TIME. A block is re-checked when its text differs from
// the text its cached answer was computed for. Re-render, reflow, scroll and
// selection changes never cause a round trip.

import type { SpellCheckRequest, SpellRange } from '@skrive/shared';
import type { BlockSurface } from '../blocksurface';
import type { Decoration } from '../blocksurface/decorations';
import { BLOCK_ID_ATTR } from '../blocksurface/render';
import { isCheckable, proseLeavesIn, type BlockText } from './block-text';
import type { SpellDictionary } from './dictionary';
import type { SpellProvider } from './provider';

export type SpellcheckOptions = {
  /** The contenteditable host whose block elements are measured for visibility. */
  surface: HTMLElement;
  /** The scrolling container that defines "near the viewport". */
  scroller: HTMLElement;
  /** The surface being checked — document, invalidation bus, decoration store. */
  blockSurface: BlockSurface;
  /** The oracle. Resolved by the caller, which stays off entirely without one. */
  provider: SpellProvider;
  /** The layered personal + project dictionary, read fresh on each paint so
   *  teaching a word takes effect without rebuilding the controller. */
  dictionary: () => SpellDictionary;
};

export type SpellcheckHandle = {
  /** The misspelling painted at a flat offset in a block, or null. The
   *  correction menu asks this to decide whether a right-click hit a squiggle. */
  misspellingAt(blockId: string, offset: number): { start: number; end: number; word: string } | null;
  /** Drop every cached answer and re-check what is on screen. Called after the
   *  writer teaches or ignores a word, since both change what "misspelled"
   *  means. */
  invalidateAll(): void;
  destroy(): void;
};

/** Milliseconds of quiet before a settled edit is checked. Long enough that a
 *  word in progress is rarely judged (nobody wants "impl" underlined while they
 *  are still typing "implementation"), short enough that a squiggle feels like
 *  part of writing rather than a later report. */
const EDIT_DEBOUNCE_MS = 500;

/** Shorter delay for the paint-only triggers (scroll, reflow): no edit is in
 *  flight, and cached answers should follow the viewport promptly. */
const VIEW_DEBOUNCE_MS = 120;

/** How far beyond the viewport counts as "near", as a fraction of the scroller's
 *  height, on each side. One screen of lead means a normal scroll lands on
 *  already-checked text. */
const VIEWPORT_LEAD = 1;

/** Cached answers are dropped wholesale past this many blocks. A long session in
 *  a large document would otherwise accumulate entries for blocks scrolled far
 *  out of sight; re-checking what is visible costs one round trip. */
const CACHE_CAP = 4000;

/** One cached answer: the exact text that was checked, and what came back. The
 *  text is the cache key — a block whose text no longer matches is re-checked. */
type CachedAnswer = { text: string; ranges: readonly SpellRange[] };

/** The top-level block elements intersecting the viewport, plus the lead margin.
 *
 *  Found by binary search rather than a walk: the surface's direct children are
 *  laid out top to bottom in document order, so the first element whose bottom
 *  edge clears the top limit can be located in O(log n) rect reads, and the walk
 *  forward from there costs one read per visible block. A document with ten
 *  thousand blocks therefore pays about thirty reads, not ten thousand. */
function visibleBlockElements(surface: HTMLElement, scroller: HTMLElement): HTMLElement[] {
  const children = surface.children;
  const count = children.length;
  if (count === 0) return [];
  const viewport = scroller.getBoundingClientRect();
  const lead = viewport.height * VIEWPORT_LEAD;
  const topLimit = viewport.top - lead;
  const bottomLimit = viewport.bottom + lead;

  // First index whose bottom edge is at or below the top limit — i.e. the first
  // element that is not entirely above the region we care about.
  let lo = 0;
  let hi = count - 1;
  let first = count;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = (children[mid] as HTMLElement).getBoundingClientRect();
    if (rect.bottom >= topLimit) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const out: HTMLElement[] = [];
  for (let i = first; i < count; i++) {
    const el = children[i] as HTMLElement;
    if (el.getBoundingClientRect().top > bottomLimit) break;
    if (el.hasAttribute(BLOCK_ID_ATTR)) out.push(el);
  }
  return out;
}

export function attachSpellcheck({
  surface,
  scroller,
  blockSurface,
  provider,
  dictionary
}: SpellcheckOptions): SpellcheckHandle {
  const store = blockSurface.decorations;
  const answers = new Map<string, CachedAnswer>();
  // The leaves painted on the last pass, by block id — what the correction menu
  // hit-tests against, so it can only ever offer a correction for a squiggle the
  // writer can actually see.
  let painted = new Map<string, readonly SpellRange[]>();
  // Blocks whose text changed since the last pass: their cached answers are
  // dropped at the next flush. A full reassess (structural pass) is `true`.
  const dirty = new Set<string>();
  let reassessAll = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  let destroyed = false;

  const schedule = (delayMs: number): void => {
    if (destroyed) return;
    const at = Date.now() + delayMs;
    // An earlier deadline wins: a scroll should not have to wait out an edit's
    // longer debounce, and flush is idempotent either way.
    if (timer !== null) {
      if (at >= deadline) return;
      clearTimeout(timer);
    }
    deadline = at;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  /** The collapsed caret's position, when it is inside a plain block leaf. Read
   *  once per pass rather than tracked per selection change: knowing it exactly
   *  at every moment would cost work on the keystroke path, and the only thing
   *  it buys is suppressing the squiggle on the word being typed. */
  const caretPosition = (): { id: string; offset: number } | null => {
    const range = blockSurface.readSelectionRange();
    if (!range) return null;
    const { anchor, focus } = range;
    if (anchor.leaf.kind !== 'block' || focus.leaf.kind !== 'block') return null;
    if (anchor.leaf.id !== focus.leaf.id || anchor.offset !== focus.offset) return null;
    return { id: anchor.leaf.id, offset: anchor.offset };
  };

  /** Repaint from cache. Pure read: no round trips, no model access beyond the
   *  leaves the caller already collected. */
  const paint = (leaves: readonly BlockText[]): void => {
    const dict = dictionary();
    const caret = caretPosition();
    const decorations: Decoration[] = [];
    const next = new Map<string, readonly SpellRange[]>();
    for (const leaf of leaves) {
      const cached = answers.get(leaf.id);
      if (!cached || cached.text !== leaf.text) continue;
      const kept: SpellRange[] = [];
      for (const range of cached.ranges) {
        const word = cached.text.slice(range.start, range.end);
        // Skrive's dictionaries only ever remove a misspelling, never add one.
        if (dict.has(word)) continue;
        // The word under the caret is being written, not finished. Judging it
        // mid-keystroke is the difference between a checker that helps and one
        // that nags.
        if (caret && caret.id === leaf.id && caret.offset >= range.start && caret.offset <= range.end) {
          continue;
        }
        kept.push(range);
        decorations.push({ blockId: leaf.id, start: range.start, end: range.end, type: 'misspelling' });
      }
      if (kept.length > 0) next.set(leaf.id, kept);
    }
    painted = next;
    store.setType('misspelling', decorations);
  };

  const flush = async (): Promise<void> => {
    if (destroyed) return;

    if (reassessAll) {
      reassessAll = false;
      dirty.clear();
      // A structural pass can move text between blocks while ids survive, so no
      // cached answer can be trusted by id alone — but each is keyed by the text
      // it was computed for, so a block whose text is unchanged still hits.
    }
    for (const id of dirty) answers.delete(id);
    dirty.clear();

    if (answers.size > CACHE_CAP) answers.clear();

    // What is on screen, as prose leaves. Visibility is per top-level block; a
    // list or blockquote contributes each of its paragraphs.
    const visibleIds = new Set<string>();
    for (const el of visibleBlockElements(surface, scroller)) {
      const id = el.getAttribute(BLOCK_ID_ATTR);
      if (id) visibleIds.add(id);
    }
    const leaves: BlockText[] = [];
    for (const block of blockSurface.getDocument().blocks) {
      if (visibleIds.has(block.id)) proseLeavesIn(block, leaves);
    }

    // Ask only about leaves whose current text has no cached answer. Text that
    // is nothing but masked content and whitespace answers itself.
    const requests: SpellCheckRequest[] = [];
    for (const leaf of leaves) {
      if (answers.get(leaf.id)?.text === leaf.text) continue;
      if (!isCheckable(leaf.text)) {
        answers.set(leaf.id, { text: leaf.text, ranges: [] });
        continue;
      }
      requests.push({ id: leaf.id, text: leaf.text });
    }

    if (requests.length === 0) {
      paint(leaves);
      return;
    }

    // The text each request was made against, so an answer that arrives after
    // the writer has moved on is discarded rather than painted at stale offsets.
    const asked = new Map(requests.map((r) => [r.id, r.text]));
    let results;
    try {
      results = await provider.check(requests);
    } catch {
      // A failed check is not an error the writer should see: the squiggles for
      // these blocks simply do not appear, and the next pass asks again.
      return;
    }
    if (destroyed) return;
    for (const result of results) {
      const text = asked.get(result.id);
      if (text === undefined) continue;
      answers.set(result.id, { text, ranges: result.ranges });
    }
    // Re-derive the leaves: the document may have changed while we waited, and
    // painting the pre-request snapshot would paint text that no longer exists.
    const fresh: BlockText[] = [];
    for (const block of blockSurface.getDocument().blocks) {
      if (visibleIds.has(block.id)) proseLeavesIn(block, fresh);
    }
    paint(fresh);
  };

  const unsubscribe = blockSurface.spell.subscribe((ids) => {
    if (ids === null) reassessAll = true;
    else for (const id of ids) dirty.add(id);
    schedule(EDIT_DEBOUNCE_MS);
  });
  const unsubscribeStructure = blockSurface.onStructureChange(() => schedule(VIEW_DEBOUNCE_MS));

  const onView = (): void => schedule(VIEW_DEBOUNCE_MS);
  scroller.addEventListener('scroll', onView, { passive: true });
  window.addEventListener('resize', onView);

  // First pass: whatever is on screen when the document opens.
  schedule(VIEW_DEBOUNCE_MS);

  return {
    misspellingAt(blockId, offset) {
      for (const range of painted.get(blockId) ?? []) {
        if (offset < range.start || offset > range.end) continue;
        const cached = answers.get(blockId);
        if (!cached) return null;
        return { start: range.start, end: range.end, word: cached.text.slice(range.start, range.end) };
      }
      return null;
    },
    invalidateAll() {
      answers.clear();
      schedule(VIEW_DEBOUNCE_MS);
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      unsubscribeStructure();
      scroller.removeEventListener('scroll', onView);
      window.removeEventListener('resize', onView);
      if (timer !== null) clearTimeout(timer);
      store.clearType('misspelling');
    }
  };
}
