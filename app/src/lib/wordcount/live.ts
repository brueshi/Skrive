// Live word/character counting over the block surface DOM (SKR-53).
//
// The store snapshot both editors emit is debounced, so a counter fed from it
// visibly lags the keystroke. This module instead watches the surface's DOM
// with a MutationObserver and keeps a per-block count map, so an edit recounts
// only the blocks it touched and the running totals tick in real time.
//
// Hot-path posture: the observer callback only files affected blocks and
// schedules a rAF — all counting happens in the animation frame, after the
// editor's keystroke->paint work, and costs O(edited blocks), not O(document).
// The one full O(document) pass is the initial sync on attach.
//
// Word counting delegates to `computeWordCount` (the ticket's contract — no
// new counting logic); this module's job is extracting text with honest word
// boundaries. `textContent` alone is wrong on both sides: it joins adjacent
// list items / table cells into one run ("foo" + "bar" -> "foobar"), while
// naively joining every text node with spaces splits words at inline mark
// boundaries ("he**ll**o" -> "he ll o"). `blockText` inserts separators only
// when crossing block-level element boundaries.

import { computeWordCount } from '../frontmatter';

export type LiveCounts = { words: number; chars: number };

// Elements whose boundary is a word boundary. Inline wrappers (strong, em,
// code, a, span) are deliberately absent so marks never split a word.
const BLOCK_BOUNDARY = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'DIV',
  'FIGURE',
  'FIGCAPTION',
  'HR',
  'BR'
]);

function appendText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? '');
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const boundary = BLOCK_BOUNDARY.has(el.tagName);
  if (boundary) out.push('\n');
  for (let child = el.firstChild; child; child = child.nextSibling) {
    appendText(child, out);
  }
  if (boundary) out.push('\n');
}

/** The element's text with newline separators at block boundaries, so word
 *  counts never join across cells/items or split inside inline marks. */
export function blockText(el: Element): string {
  const out: string[] = [];
  appendText(el, out);
  return out.join('');
}

/** Word/character counts for one top-level block. Characters are the visible
 *  text (`textContent`), without the artificial boundary separators. */
export function countBlock(el: Element): LiveCounts {
  return {
    words: computeWordCount(blockText(el)),
    chars: (el.textContent ?? '').length
  };
}

/**
 * Watch `content` (the block surface host — its children are the top-level
 * blocks) and report live totals. Reports once synchronously on attach, then
 * on every rAF-coalesced batch of mutations that changed the totals.
 * Returns a detach function.
 */
export function attachLiveCounts(
  content: HTMLElement,
  onChange: (counts: LiveCounts) => void
): () => void {
  const perBlock = new Map<Element, LiveCounts>();
  let words = 0;
  let chars = 0;

  const add = (el: Element) => {
    const c = countBlock(el);
    perBlock.set(el, c);
    words += c.words;
    chars += c.chars;
  };

  const remove = (el: Element) => {
    const prev = perBlock.get(el);
    if (!prev) return;
    perBlock.delete(el);
    words -= prev.words;
    chars -= prev.chars;
  };

  /** Recount one tracked block in place; true if its counts moved. */
  const recount = (el: Element): boolean => {
    const prev = perBlock.get(el);
    const next = countBlock(el);
    if (prev && prev.words === next.words && prev.chars === next.chars) {
      return false;
    }
    words += next.words - (prev?.words ?? 0);
    chars += next.chars - (prev?.chars ?? 0);
    perBlock.set(el, next);
    return true;
  };

  const fullSync = () => {
    perBlock.clear();
    words = 0;
    chars = 0;
    for (const child of Array.from(content.children)) add(child);
  };

  /** The top-level block containing `node`, or null if it isn't under one
   *  (detached, or `content` itself). */
  const topBlockOf = (node: Node): Element | null => {
    let cur: Node | null = node;
    while (cur && cur.parentNode !== content) cur = cur.parentNode;
    return cur instanceof Element ? cur : null;
  };

  const dirtyBlocks = new Set<Element>();
  let needsFullSync = false;
  let raf: number | null = null;
  // Compared against the running totals at flush time — removals subtract in
  // the observer callback itself, so a flush-local snapshot would miss them.
  let reported = { words: -1, chars: -1 };

  const flush = () => {
    raf = null;
    if (needsFullSync) {
      needsFullSync = false;
      dirtyBlocks.clear();
      fullSync();
    } else {
      for (const el of dirtyBlocks) {
        // A block filed dirty but since detached: its removal record already
        // subtracted it, so skip rather than resurrect it.
        if (el.parentNode === content) recount(el);
      }
      dirtyBlocks.clear();
    }
    if (words !== reported.words || chars !== reported.chars) {
      reported = { words, chars };
      onChange(reported);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.target === content && r.type === 'childList') {
        // Blocks came or went at the top level (Enter split, block delete,
        // paste): adjust incrementally so a structural edit stays O(changed).
        for (const n of Array.from(r.removedNodes)) {
          if (n instanceof Element) remove(n);
        }
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof Element && n.parentNode === content) {
            dirtyBlocks.add(n);
          }
        }
        continue;
      }
      const top = topBlockOf(r.target);
      if (top) {
        dirtyBlocks.add(top);
      } else if (r.target !== content) {
        // A mutation we can't attribute (target already detached) — recover
        // with one full pass rather than drift.
        needsFullSync = true;
      }
    }
    if (raf == null) raf = requestAnimationFrame(flush);
  });

  fullSync();
  reported = { words, chars };
  onChange(reported);
  observer.observe(content, {
    subtree: true,
    childList: true,
    characterData: true
  });

  return () => {
    observer.disconnect();
    if (raf != null) cancelAnimationFrame(raf);
  };
}
