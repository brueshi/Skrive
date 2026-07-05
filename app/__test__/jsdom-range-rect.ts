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
