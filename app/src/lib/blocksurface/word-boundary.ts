// Word / line boundary scanning for the macOS delete chords (SKR-165). Pure
// string math over a single leaf's text, so the surface can map Option+Backspace
// (deleteWordBackward), Option-fn-Backspace (deleteWordForward) and Cmd+Backspace
// (deleteSoftLineBackward) onto its existing delete primitives.
//
// Word boundaries use Intl.Segmenter (granularity 'word'), which is built into
// WebKit and Chromium and is i18n-correct — it segments scripts that have no
// spaces (CJK) the way a hand-rolled \w scan never could. The segmenter is
// created once and reused: constructing one per keystroke is measurable cost.

// One shared segmenter (locale-default). Null only where the runtime predates
// Intl.Segmenter, in which case the scanners fall back to a whitespace rule.
const wordSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : null;

/**
 * The [from, to) slice a word delete removes from `text` at `caret`.
 *
 * Backward (Option+Backspace) deletes from the start of the previous word-ish
 * segment up to the caret, so any whitespace/punctuation between the caret and
 * that word goes with it — native macOS text-field behaviour. Forward is the
 * mirror. `from === to` signals the caret sits at the text edge (offset 0 for
 * backward, length for forward): the caller falls back to a plain char delete,
 * which owns the block-boundary merge / barrier action.
 */
export function wordBoundaryRange(text: string, caret: number, direction: 'backward' | 'forward'): [number, number] {
  if (direction === 'backward') {
    if (caret <= 0) return [0, 0];
    return [wordStartBefore(text, caret), caret];
  }
  if (caret >= text.length) return [text.length, text.length];
  return [caret, wordEndAfter(text, caret)];
}

/**
 * The [from, to) slice a line delete removes from `text` at `caret`. Pragmatic
 * v1 semantics (SKR-165): the current text RUN, not the visual soft-wrapped line
 * — in prose the whole leaf (block start / end), in a code block the current
 * code line (bounded by the nearest newlines). True visual-line boundaries need
 * caret geometry and are deferred. `from === to` signals the caller to fall back
 * to a plain char delete.
 */
export function lineBoundaryRange(text: string, caret: number, direction: 'backward' | 'forward', isCode: boolean): [number, number] {
  if (direction === 'backward') {
    const start = isCode ? text.lastIndexOf('\n', caret - 1) + 1 : 0;
    return [start, caret];
  }
  if (isCode) {
    const nl = text.indexOf('\n', caret);
    return [caret, nl === -1 ? text.length : nl];
  }
  return [caret, text.length];
}

// The start index of the word to delete when Backspacing left from `caret`: the
// last word-like segment beginning before the caret. When none exists (only
// whitespace / punctuation precedes the caret) the start of the last segment
// before it, so a run of leading spaces still deletes as one gesture.
function wordStartBefore(text: string, caret: number): number {
  if (!wordSegmenter) return whitespaceWordStart(text, caret);
  let lastWordStart: number | null = null;
  let lastSegStart = 0;
  for (const seg of wordSegmenter.segment(text)) {
    if (seg.index >= caret) break;
    lastSegStart = seg.index;
    if (seg.isWordLike) lastWordStart = seg.index;
  }
  return lastWordStart ?? lastSegStart;
}

// The end index of the word to delete when forward-deleting right from `caret`:
// the end of the first word-like segment reaching past the caret. When none
// remains, the end of the first segment past the caret, else the text end.
function wordEndAfter(text: string, caret: number): number {
  if (!wordSegmenter) return whitespaceWordEnd(text, caret);
  let firstSegEnd: number | null = null;
  for (const seg of wordSegmenter.segment(text)) {
    const end = seg.index + seg.segment.length;
    if (end <= caret) continue;
    if (firstSegEnd === null) firstSegEnd = end;
    if (seg.isWordLike) return end;
  }
  return firstSegEnd ?? text.length;
}

/**
 * Clamp a word/line-delete run so it never silently consumes a single-cell atom
 * (an image, a hard break, a footnote reference — SCAN_ATOM placeholders in the
 * scan text). The run truncates at the atom nearest the caret; when that empties
 * the run entirely (the atom is adjacent to the caret), the caller falls back to
 * a plain char delete, which owns the atom gestures — a footnote reference's
 * arming beat, a break/image's single-cell delete. Without this, one
 * Option+Backspace could blow through a reference and take its footer definition
 * with it, with no beat at all.
 */
export function clampRunToAtoms(
  scanText: string,
  from: number,
  to: number,
  caret: number,
  atomChar: string,
  direction: 'backward' | 'forward'
): [number, number] {
  if (direction === 'backward') {
    const cut = caret > 0 ? scanText.lastIndexOf(atomChar, caret - 1) : -1;
    if (cut >= from) return [cut + 1, to];
  } else {
    const cut = scanText.indexOf(atomChar, caret);
    if (cut !== -1 && cut < to) return [from, cut];
  }
  return [from, to];
}

const WS = /\s/;

// Whitespace-only fallback for runtimes without Intl.Segmenter: skip whitespace
// left of the caret, then the run of non-whitespace before it.
function whitespaceWordStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0 && WS.test(text[i - 1]!)) i--;
  while (i > 0 && !WS.test(text[i - 1]!)) i--;
  return i;
}

function whitespaceWordEnd(text: string, caret: number): number {
  let i = caret;
  while (i < text.length && WS.test(text[i]!)) i++;
  while (i < text.length && !WS.test(text[i]!)) i++;
  return i;
}
