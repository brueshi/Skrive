// jsdom does not implement Range.prototype.getBoundingClientRect (a known gap:
// https://github.com/jsdom/jsdom/issues/3729) — Element has a (zero) stub, but
// Range is simply undefined. refreshSlash reads a Range rect to anchor the
// slash popover, so any test that opens a slash session needs this polyfilled.
// A zero rect is also exactly what refreshSlash already treats as "degenerate,
// anchor to the block instead", so this doesn't mask real anchoring logic.
//
// Import for its side effect only, before constructing a BlockSurface:
//   import '../jsdom-range-rect';
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = function (): DOMRect {
    return new DOMRect(0, 0, 0, 0);
  };
}
// Same gap for the per-line rects; an empty list is what "no layout" reads as
// (caretRect then falls through to the bounding rect above).
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function (): DOMRectList {
    return [] as unknown as DOMRectList;
  };
}
