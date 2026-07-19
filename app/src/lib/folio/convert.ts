// The seam between the editing block model (`../blockmodel/types.ts`) and the
// `.folio` contract (`./types.ts`) (SKR-195, spec §2). Everything that knows about
// both shapes lives here, so the folio contract can't silently drift when the
// model gains Markdown-fidelity fields.
//
// Outbound (model -> folio): drop every fidelity field — `src`, `gapBefore`,
// `dirty`, `durable`, `code_block.fence`, `bullet_list.marker`,
// `ordered_list.delimiter`. They exist only to hold Markdown bytes byte-faithful,
// which is exactly the contract `.folio` abolishes. A `frozen_block` (a construct
// the Markdown model couldn't represent richly) resolves to a paragraph — the
// native format models everything, so nothing is ever frozen.
//
// Inbound (folio -> model): fill the dropped fields with folio-neutral defaults
// (no captured Markdown bytes, canonical marker/delimiter, no fence). On the rich
// path these are inert — a `.folio`-backed document is model-canonical and is
// never Markdown-serialized — so the defaults only keep the model type valid.

import { FOLIO_SCHEMA_VERSION } from './types';
import type {
  BlockNode,
  Document,
  InlineMarks,
  InlineNode,
  ListItem
} from '../blockmodel/types';
import type {
  FolioBlock,
  FolioDocument,
  FolioInline,
  FolioListItem,
  FolioMarks,
  FolioMeta
} from './types';

// ---- inline ---------------------------------------------------------------

function marksToFolio(m: InlineMarks): FolioMarks {
  const out: FolioMarks = {};
  if (m.em === true) out.em = true;
  if (m.strong === true) out.strong = true;
  if (m.code === true) out.code = true;
  if (m.strikethrough === true) out.strikethrough = true;
  if (m.link) out.link = { href: m.link.href, title: m.link.title };
  return out;
}

function inlineToFolio(n: InlineNode): FolioInline {
  switch (n.kind) {
    case 'text':
      return { kind: 'text', text: n.text, marks: marksToFolio(n.marks) };
    case 'tag':
      return { kind: 'tag', name: n.name, marks: marksToFolio(n.marks) };
    case 'image':
      return { kind: 'image', url: n.url, alt: n.alt, title: n.title, marks: marksToFolio(n.marks) };
    case 'break':
      return { kind: 'break', marks: marksToFolio(n.marks) };
    case 'footnote_ref':
      return { kind: 'footnote_ref', label: n.label, marks: marksToFolio(n.marks) };
  }
}

function marksToModel(m: FolioMarks): InlineMarks {
  const out: InlineMarks = {};
  if (m.em === true) out.em = true;
  if (m.strong === true) out.strong = true;
  if (m.code === true) out.code = true;
  if (m.strikethrough === true) out.strikethrough = true;
  if (m.link) out.link = { href: m.link.href, title: m.link.title };
  return out;
}

function inlineToModel(n: FolioInline): InlineNode {
  switch (n.kind) {
    case 'text':
      return { kind: 'text', text: n.text, marks: marksToModel(n.marks) };
    case 'tag':
      return { kind: 'tag', name: n.name, marks: marksToModel(n.marks) };
    case 'image':
      return { kind: 'image', url: n.url, alt: n.alt, title: n.title, marks: marksToModel(n.marks) };
    case 'break':
      return { kind: 'break', marks: marksToModel(n.marks) };
    case 'footnote_ref':
      return { kind: 'footnote_ref', label: n.label, marks: marksToModel(n.marks) };
  }
}

// ---- blocks: model -> folio -----------------------------------------------

function itemToFolio(item: ListItem): FolioListItem {
  const out: FolioListItem = { spread: item.spread, children: item.children.map(blockToFolio) };
  if (typeof item.checked === 'boolean') out.checked = item.checked;
  return out;
}

function blockToFolio(b: BlockNode): FolioBlock {
  if (b.type === 'frozen_block') {
    // Resolve to a paragraph carrying the raw source as literal text. Rare —
    // only reachable via a future `.md` -> `.folio` upgrade, never from a
    // folio-authored document.
    return { id: b.id, type: 'paragraph', inline: [{ kind: 'text', text: b.src, marks: {} }] };
  }
  switch (b.type) {
    case 'paragraph':
      return { id: b.id, type: 'paragraph', inline: b.inline.map(inlineToFolio) };
    case 'heading':
      return { id: b.id, type: 'heading', level: b.level, inline: b.inline.map(inlineToFolio) };
    case 'code_block':
      return { id: b.id, type: 'code_block', lang: b.lang, meta: b.meta, text: b.text };
    case 'horizontal_rule':
      return { id: b.id, type: 'horizontal_rule' };
    case 'blockquote':
      return { id: b.id, type: 'blockquote', children: b.children.map(blockToFolio) };
    case 'footnote_definition':
      return { id: b.id, type: 'footnote_definition', label: b.label, children: b.children.map(blockToFolio) };
    case 'bullet_list':
      return { id: b.id, type: 'bullet_list', spread: b.spread, items: b.items.map(itemToFolio) };
    case 'ordered_list':
      return {
        id: b.id,
        type: 'ordered_list',
        start: b.start,
        spread: b.spread,
        items: b.items.map(itemToFolio)
      };
    case 'table':
      return {
        id: b.id,
        type: 'table',
        align: b.align,
        rows: b.rows.map((row) => row.map((cell) => cell.map(inlineToFolio)))
      };
  }
}

// ---- blocks: folio -> model -----------------------------------------------

// The dropped fidelity fields, at folio-neutral defaults: no captured Markdown
// bytes, not durable, not dirty. Inert on the rich path (never Markdown-
// serialized); present only to keep the block-model type valid.
const FIDELITY_DEFAULTS = { durable: false, src: null, gapBefore: null, dirty: false } as const;

function itemToModel(item: FolioListItem): ListItem {
  const out: ListItem = { spread: item.spread, children: item.children.map(blockToModel) };
  if (typeof item.checked === 'boolean') out.checked = item.checked;
  return out;
}

function blockToModel(b: FolioBlock): BlockNode {
  switch (b.type) {
    case 'paragraph':
      return { ...FIDELITY_DEFAULTS, id: b.id, type: 'paragraph', inline: b.inline.map(inlineToModel) };
    case 'heading':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'heading',
        level: b.level,
        inline: b.inline.map(inlineToModel)
      };
    case 'code_block':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'code_block',
        lang: b.lang,
        meta: b.meta,
        fence: null,
        text: b.text
      };
    case 'horizontal_rule':
      return { ...FIDELITY_DEFAULTS, id: b.id, type: 'horizontal_rule' };
    case 'blockquote':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'blockquote',
        children: b.children.map(blockToModel)
      };
    case 'footnote_definition':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'footnote_definition',
        label: b.label,
        children: b.children.map(blockToModel)
      };
    case 'bullet_list':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'bullet_list',
        marker: '-',
        spread: b.spread,
        items: b.items.map(itemToModel)
      };
    case 'ordered_list':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'ordered_list',
        start: b.start,
        delimiter: '.',
        spread: b.spread,
        items: b.items.map(itemToModel)
      };
    case 'table':
      return {
        ...FIDELITY_DEFAULTS,
        id: b.id,
        type: 'table',
        align: b.align,
        rows: b.rows.map((row) => row.map((cell) => cell.map(inlineToModel)))
      };
  }
}

// ---- documents ------------------------------------------------------------

/** Project a block-model document into a `.folio` document. `docId` and `docMeta`
 *  are threaded in explicitly because the block model carries no document identity
 *  — the caller (a `.md` -> `.folio` upgrade, or a fresh document) mints them. */
export function modelToFolio(
  doc: Document,
  identity: { docId: string; docMeta: FolioMeta }
): FolioDocument {
  return {
    schemaVersion: FOLIO_SCHEMA_VERSION,
    docId: identity.docId,
    docMeta: identity.docMeta,
    blocks: doc.blocks.map(blockToFolio)
  };
}

/** Load a `.folio` document into the editing block model. `docId`/`docMeta` are
 *  dropped here (the block-model `Document` has no slot for them; the rich path
 *  keeps them alongside the model). `trailingGap` is a Markdown-bytes artifact
 *  with no meaning on the folio path, so it is empty. */
export function folioToModel(doc: FolioDocument): Document {
  return { blocks: doc.blocks.map(blockToModel), trailingGap: '' };
}
