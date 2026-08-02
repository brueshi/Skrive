// Grapheme arithmetic for the caret.
//
// Inline offsets in this editor are UTF-16 code units — `nodeWidth` measures a
// text node as `text.length` — which is the right unit for the model but the
// wrong unit for a keystroke. A writer pressing Backspace means "remove the
// character I see", and what they see is a GRAPHEME CLUSTER: an astral emoji is
// two code units, a skin-toned one is four, a family is eleven. Stepping by one
// code unit leaves a lone surrogate, which is not merely a rendering glitch —
// it is invalid text that flows through the serializer onto disk.
//
// Intl.Segmenter with grapheme granularity is the correct tool and needs no
// dependency. `word-boundary.ts` sets the precedent for how it is reached here:
// feature-detected once at module load, with a fallback for any runtime that
// lacks it. The fallback is deliberately narrow — it repairs surrogate pairs
// only, since pairing is decidable from the code units themselves, and does not
// pretend to know where a ZWJ sequence ends.
//
// `containing()` is used rather than segmenting a window around the caret. A
// window would be faster but can only be correct up to whatever cluster length
// it assumes, and a mis-sized window fails in exactly the way this module
// exists to prevent. Correctness first; the latency matrix is the check on
// whether that costs anything measurable.

const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** True when `code` is the high half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** True when `code` is the low half of a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * How many code units the grapheme ENDING at `caret` occupies — the amount a
 * single Backspace should remove. Returns 0 at the start of the text (nothing
 * to delete), and never returns more than `caret`.
 */
export function graphemeBefore(text: string, caret: number): number {
  if (caret <= 0) return 0;
  const at = Math.min(caret, text.length);
  if (!graphemeSegmenter) {
    // Surrogate-only fallback: take two units when the caret sits just after a
    // well-formed pair, one otherwise.
    if (at >= 2 && isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2))) {
      return 2;
    }
    return 1;
  }
  const seg = graphemeSegmenter.segment(text).containing(at - 1);
  // A caret that is somehow mid-cluster still yields a sane step: measure from
  // the cluster's start rather than trusting it to align.
  if (!seg) return 1;
  const n = at - seg.index;
  return n > 0 ? n : 1;
}

/**
 * How many code units the grapheme STARTING at `caret` occupies — the amount a
 * single forward Delete should remove. Returns 0 at the end of the text.
 */
export function graphemeAfter(text: string, caret: number): number {
  if (caret >= text.length) return 0;
  const at = Math.max(caret, 0);
  if (!graphemeSegmenter) {
    if (at + 1 < text.length && isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1))) {
      return 2;
    }
    return 1;
  }
  const seg = graphemeSegmenter.segment(text).containing(at);
  if (!seg) return 1;
  const n = seg.index + seg.segment.length - at;
  return n > 0 ? n : 1;
}
