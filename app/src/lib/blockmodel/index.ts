// The canonical block model (SKR-94 / SKR-96): the editing truth under the
// canonical inversion, with Markdown as a save-time serialization. Pure and
// substrate-independent — no ProseMirror, no DOM. The editing surface that
// mutates this model lands in Stage 3.

export * from './types';
export { parseDocument, type ParseOptions } from './parse';
export { serializeDocument } from './serialize';
export {
  generateBlockId,
  makeIdGenerator,
  BLOCK_ID_RE,
  type RandomSource
} from './id';
export {
  formatAnchorComment,
  parseAnchorComment,
  InMemoryAttachmentRegistry,
  type AttachmentRegistry,
  type BlockAnchor,
  type InlineAnchor
} from './anchor';
