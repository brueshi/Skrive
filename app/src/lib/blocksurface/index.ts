// The bespoke editing surface (SKR-95, Stage 3): one contenteditable host over
// the canonical block model, with a React-free, block-local keystroke hot path.
// Stage 3a is the engine core (render + selection + prose typing); structural
// edits, marks, block types, and affordances arrive in 3b-3d.

export { BlockSurface, type BlockSurfaceOptions, type SelectionInfo } from './surface';
export { SelectionBubble } from './SelectionBubble';
export { renderDocument, renderBlock, renderInlineInto, BlockViewRegistry, BLOCK_ID_ATTR } from './render';
export {
  caretContext,
  focusedBlockElement,
  flatOffsetFromDOM,
  domPointFromFlatOffset,
  setCaret,
  type CaretContext
} from './selection';
export { insertTextInInline, deleteRangeInInline, readInlineFromDOM } from './inline-ops';
