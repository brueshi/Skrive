// The canonical block model (SKR-94). Substrate-independent by construction:
// nothing in this directory imports ProseMirror, the DOM, or any view layer.
// The block model is the editing truth; Markdown is a save-time serialization
// (planning/editor-surface-build-plan.md, "The core decision — canonical
// inversion"). Today this model is built and serialized purely; the editing
// surface that mutates it lands in Stage 3.
//
// The shapes mirror the projection schema's block vocabulary one-for-one (the
// trusted set today's editor already round-trips), so the relocated serializer
// is re-pointing reads, not inventing a new contract:
//   - paragraph / heading        inline content
//   - code_block                 verbatim text + fence/lang/meta style capture
//   - bullet_list / ordered_list list items, marker / delimiter / spread style
//   - blockquote                 nested block content
//   - horizontal_rule            atom
//   - table                      header + body rows of inline cells
//   - frozen_block               any unmodeled construct, emitted verbatim
//
// Fidelity attributes (`src` / `gapBefore` / `dirty`) carry the same meaning they
// do in the projection schema; see schema.ts for the canonical prose on each.

/** Inline mark context on a leaf. `code` is a mark (an inline code span), matching
 *  the projection's flat normalized mark sets. */
export type InlineMarks = {
  em?: boolean;
  strong?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  link?: { href: string; title: string | null };
};

export type InlineText = { kind: 'text'; text: string; marks: InlineMarks };
export type InlineImage = {
  kind: 'image';
  url: string;
  alt: string;
  title: string | null;
  marks: InlineMarks;
};
/** A within-block hard line break (Shift-Enter / CommonMark backslash break). */
export type InlineBreak = { kind: 'break'; marks: InlineMarks };

export type InlineNode = InlineText | InlineImage | InlineBreak;

/** Column alignment for a GFM table, from the delimiter row. */
export type TableAlign = 'left' | 'right' | 'center' | null;

// Fields every top-level block carries. Nested blocks (a blockquote's children, a
// list item's blocks) reuse the same shapes but ride their container's verbatim
// `src`, so their `src` / `gapBefore` are null and they are never independently
// dirty-tracked or anchored.
type BlockBase = {
  /** Session-stable identity (SKR-94). Opaque; survives edits within a session.
   *  Restored from an anchor comment when the block is durable, else freshly
   *  generated at load. */
  id: string;
  /** True when this block's identity is persisted to disk as a `<!-- sk:ID -->`
   *  comment — i.e. it carries (or carried) a managed-layer attachment. The
   *  serializer re-emits the comment for durable blocks and nothing else, which
   *  is what keeps a pristine document pristine. See anchor.ts. */
  durable: boolean;
  /** Verbatim original Markdown bytes for this block; null if created fresh. */
  src: string | null;
  /** Verbatim bytes at the seam before this block; null if the seam is new. */
  gapBefore: string | null;
  /** Whether the content changed since parse. Clean blocks emit `src` verbatim. */
  dirty: boolean;
};

export type ParagraphBlock = BlockBase & { type: 'paragraph'; inline: InlineNode[] };
export type HeadingBlock = BlockBase & { type: 'heading'; level: number; inline: InlineNode[] };
export type CodeBlock = BlockBase & {
  type: 'code_block';
  lang: string;
  meta: string | null;
  /** The literal opening fence captured from source (``` / ~~~~ / …); null for an
   *  indented block or one created in the editor. */
  fence: string | null;
  text: string;
};
export type ListItem = {
  /** The item's own rhythm — whether ITS child blocks are blank-line separated,
   *  distinct from the list's spread (blank lines between items). */
  spread: boolean;
  /** GFM task-list state (SKR-142): true/false for `- [x]` / `- [ ]`, absent for
   *  a plain item. Lives in the `.md` bytes themselves — no managed-layer
   *  dependency. */
  checked?: boolean;
  children: BlockNode[];
};
export type BulletListBlock = BlockBase & {
  type: 'bullet_list';
  marker: string; // '-', '*', or '+'
  spread: boolean;
  items: ListItem[];
};
export type OrderedListBlock = BlockBase & {
  type: 'ordered_list';
  start: number;
  delimiter: string; // '.' or ')'
  spread: boolean;
  items: ListItem[];
};
export type BlockquoteBlock = BlockBase & { type: 'blockquote'; children: BlockNode[] };
export type HorizontalRuleBlock = BlockBase & { type: 'horizontal_rule' };
export type TableCell = InlineNode[];
export type TableBlock = BlockBase & {
  type: 'table';
  /** Per-column alignment, length = column count, taken from the header row. */
  align: TableAlign[];
  /** Row 0 is the header; the rest are body rows. Each row is a row of cells. */
  rows: TableCell[][];
};
/** Any construct the model does not represent richly. Always emitted verbatim
 *  from `src`; carries no `dirty` (it can never be canonicalized). */
export type FrozenBlock = {
  type: 'frozen_block';
  id: string;
  durable: boolean;
  src: string;
  gapBefore: string | null;
};

export type BlockNode =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | BulletListBlock
  | OrderedListBlock
  | BlockquoteBlock
  | HorizontalRuleBlock
  | TableBlock
  | FrozenBlock;

/** A loaded document: an ordered list of top-level blocks plus the bytes after
 *  the last block to end-of-file (trailing newline, etc.). */
export type Document = {
  blocks: BlockNode[];
  trailingGap: string;
};

/** Blocks that own per-block fidelity state (everything but frozen). Narrowing
 *  helper so call sites can read `dirty` / `inline` without re-checking `type`. */
export function isFrozen(block: BlockNode): block is FrozenBlock {
  return block.type === 'frozen_block';
}
