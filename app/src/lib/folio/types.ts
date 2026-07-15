// The `.folio` v1 document contract (SKR-195). This is Skrive's native
// rich-document format: one file per document, holding the full block model with
// marks and attributes and no reduction to Markdown. The authoritative field-level
// spec is `docs/folio-schema-v1.md`; these types are its executable form.
//
// The encoding deliberately mirrors the block model (`../blockmodel/types.ts`)
// MINUS every Markdown-serialization-fidelity field (spec §2): `src`, `gapBefore`,
// `dirty`, `durable`, `code_block.fence`, `bullet_list.marker`,
// `ordered_list.delimiter` are all dropped, and there is no `frozen_block` — the
// native format models everything, so nothing is ever frozen. `id` is persisted
// for every block (unlike `.md`, where only durable blocks anchor their id).
//
// These types are kept DECOUPLED from the block-model types on purpose: `.folio`
// is a public portability contract with three consumers (the file body, the
// engine's WAL payload, and the Zig<->JS boundary — spec §7), and it must not
// drift when the editing model gains fidelity fields. The mapping between the two
// lives in `convert.ts`, which is the single seam.

/** Inline mark context on a leaf. Only set marks are ever emitted (spec §9);
 *  `code` is a mark (an inline code span), matching the block model. */
export type FolioMarks = {
  em?: boolean;
  strong?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  link?: { href: string; title: string | null };
};

export type FolioText = { kind: 'text'; text: string; marks: FolioMarks };
/** `url` is a reference (relative asset path or asset id), never an embedded blob
 *  (spec §8). Inline images are atoms — one unit of offset space (SKR-155). */
export type FolioImage = {
  kind: 'image';
  url: string;
  alt: string;
  title: string | null;
  marks: FolioMarks;
};
/** A hard line break within a block. */
export type FolioBreak = { kind: 'break'; marks: FolioMarks };
/** An inline tag (`#name`, nested `#parent/child`). `name` is the text after the
 *  `#`. Native to `.folio`: unlike `.md`, where a tag is literal `#name` body text,
 *  here it persists as its own leaf. */
export type FolioTag = { kind: 'tag'; name: string; marks: FolioMarks };

export type FolioInline = FolioText | FolioImage | FolioBreak | FolioTag;

/** Column alignment for a table, from the header row. */
export type FolioAlign = 'left' | 'right' | 'center' | null;

/** A list item holds blocks (enabling nesting). `checked` is present only for
 *  task-list items (`true`/`false`); absent for a plain item. `spread` is the
 *  item's own child rhythm, distinct from the list's `spread`. */
export type FolioListItem = {
  spread: boolean;
  checked?: boolean;
  children: FolioBlock[];
};

export type FolioParagraph = { id: string; type: 'paragraph'; inline: FolioInline[] };
export type FolioHeading = {
  id: string;
  type: 'heading';
  /** 1-6. */
  level: number;
  inline: FolioInline[];
};
export type FolioCodeBlock = {
  id: string;
  type: 'code_block';
  /** `""` when none. */
  lang: string;
  meta: string | null;
  /** Verbatim; newlines as `\n`. */
  text: string;
};
export type FolioHorizontalRule = { id: string; type: 'horizontal_rule' };
export type FolioBulletList = {
  id: string;
  type: 'bullet_list';
  spread: boolean;
  items: FolioListItem[];
};
export type FolioOrderedList = {
  id: string;
  type: 'ordered_list';
  start: number;
  spread: boolean;
  items: FolioListItem[];
};
export type FolioBlockquote = { id: string; type: 'blockquote'; children: FolioBlock[] };
/** Each cell is an inline array. Ragged rows are permitted natively (SKR-159):
 *  the native format has no column-clamp; clamping/padding happens only on
 *  Markdown export. */
export type FolioTable = {
  id: string;
  type: 'table';
  /** Length = column count; each entry from the header. */
  align: FolioAlign[];
  /** Row 0 is the header; the rest are body rows. */
  rows: FolioInline[][][];
};

export type FolioBlock =
  | FolioParagraph
  | FolioHeading
  | FolioCodeBlock
  | FolioHorizontalRule
  | FolioBulletList
  | FolioOrderedList
  | FolioBlockquote
  | FolioTable;

/** Document-level metadata (spec §4). Minimal and extensible — a reader preserves
 *  unknown keys verbatim across a load/save so a newer writer's additions survive
 *  a round-trip through an older reader. No `updatedAt`: a mtime that changed on
 *  every save would break the byte-determinism guarantee (§6). */
export type FolioMeta = {
  /** `null` (or absent) means "derive from the first heading." */
  title: string | null;
  /** ISO-8601 UTC, set once at mint, immutable. */
  createdAt: string;
  /** Forward-compatible additions from a newer writer, preserved verbatim. */
  [key: string]: unknown;
};

export type FolioDocument = {
  schemaVersion: 1;
  /** Stable document identity, minted once at creation, distinct from path
   *  (spec §3). A ULID; see `docid.ts`. Opaque on read. */
  docId: string;
  docMeta: FolioMeta;
  /** The canonical block tree in document order; containers nest their children. */
  blocks: FolioBlock[];
};

export const FOLIO_SCHEMA_VERSION = 1 as const;
