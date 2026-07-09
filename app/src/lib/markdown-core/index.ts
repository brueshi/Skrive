// markdown-core: the substrate-independent Markdown engine shared by the
// projection bridge (ProseMirror) and the canonical block model. Owns the single
// parser, the idempotence guard, and the CommonMark inline reconstruction — the
// subtle, hardened logic that must never fork into two divergent copies. Each
// substrate flattens its own inline content into InlineItem[] and feeds it here.

export { normalizeLineEndings, parseMarkdown } from './mdast';
export { mdastEqual, semanticallyEqual } from './idempotence';
export {
  type InlineItem,
  type LinkRef,
  sameInlineContext,
  buildPhrasing,
  inlineItemsToParagraphMarkdown,
  inlineItemsToHeadingMarkdown
} from './inline';
