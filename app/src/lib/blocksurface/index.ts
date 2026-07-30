// The bespoke editing surface (SKR-95, Stage 3): one contenteditable host over
// the canonical block model, with a React-free, block-local keystroke hot path.
// Stage 3a is the engine core (render + selection + prose typing); structural
// edits, marks, block types, and affordances arrive in 3b-3d.

export {
  BlockSurface,
  type BlockSurfaceOptions,
  type SelectionInfo,
  type BlockTypeSpec,
  type SlashMenuState,
  type TableMenuState,
  type TagMenuState,
  type CodeLangMenuState,
  type ImagePasteDelegate
} from './surface';
export { renderDocument, renderBlock, renderInlineInto, BlockViewRegistry, BLOCK_ID_ATTR } from './render';
export type { AssetResolver } from './render';
export {
  caretContext,
  focusedBlockElement,
  flatOffsetFromDOM,
  domPointFromFlatOffset,
  setCaret,
  type CaretContext
} from './selection';
export { insertTextInInline, deleteRangeInInline, readInlineFromDOM } from './inline-ops';
export { DocHistory } from './history';
// Decoration overlay (view-only highlights / squiggles over live text). The frozen
// consumer contract is small: a feature owns one decoration TYPE and drives it with
// `surface.decorations.setType(type, decorations)` and `clearType(type)` (or the
// finer `add`). Everything else — the overlay painter, the store's subscribe /
// invalidate / forBlock / blockIds — is the internal wiring the editor and painter
// use; consumers do not touch it.
export { DecorationStore, type Decoration, type DecorationType } from './decorations';
export {
  attachDecorationOverlay,
  contentBox,
  type ContentBox,
  type DecorationOverlayHandle
} from './decoration-overlay';
// Table hover chrome (per-block affordance layer for tables). The painter is
// attached by the editor; `tableGutterSlots` is exported because it is the pure
// arithmetic half, verified without layout.
export {
  attachTableChrome,
  measureTable,
  tableGutterSlots,
  tableHandleSlot,
  hoverZone,
  zoneContains,
  GUTTER_METRICS,
  type GutterSlot,
  type HoverCell,
  type TableGeometry,
  type HoverZone,
  type TableChromeHandle
} from './table-chrome';
// Per-block hover chrome (the grip and + beside a hovered block). Same split as
// the table chrome: the painter is attached by the editor, and the pure
// arithmetic half is exported because it is verified without layout.
export {
  attachBlockChrome,
  measureBlock,
  blockChromeSlots,
  blockDropEdges,
  blockDropIndicatorRect,
  blockHoverZone,
  blocksInSweep,
  BLOCK_CHROME_METRICS,
  type BlockSlot,
  type BlockGeometry,
  type BlockChromeHandle
} from './block-chrome';
