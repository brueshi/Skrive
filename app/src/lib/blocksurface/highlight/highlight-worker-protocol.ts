// Wire contract between the surface's code-highlight controller (main thread)
// and the highlight Worker. Type-only — nothing here is emitted, so both ends
// import it without pulling the worker (and Prism) into the main chunk. Keeping
// the messages in one place means the two ends can't silently drift.

/** A flat, non-overlapping token span within one code block, in raw string
 *  offsets (UTF-16 code units — the same units the block's `text` is sliced by).
 *  `type` is the Prism token type (`keyword`, `string`, `comment`, …); the
 *  painter maps it to a `sk-hl-<type>` class. Spans never overlap and are sorted
 *  by `start`, so the painter walks them in one pass. */
export type HighlightToken = { start: number; end: number; type: string };

/** Main thread → worker. One request per code block that needs re-tokenizing.
 *  `seq` is a per-block monotonic id echoed back so the painter can drop a result
 *  the block has already moved past (a newer edit is in flight). */
export type HighlightRequest = {
  type: 'highlight';
  seq: number;
  blockId: string;
  /** The block's language (fence info string); may be an alias the worker
   *  normalizes, or unsupported (the worker then returns no tokens). */
  lang: string;
  /** The block's full verbatim text. */
  text: string;
};

/** Worker → main thread. The token spans for the request's `seq`/`blockId`.
 *  Empty when the language is unknown or the text has no colourable tokens —
 *  the painter then leaves the block as plain monospace. */
export type HighlightResponse = {
  type: 'tokens';
  seq: number;
  blockId: string;
  tokens: HighlightToken[];
};
