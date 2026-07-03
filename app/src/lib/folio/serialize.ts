// Deterministic `.folio` writer (SKR-195, spec §9). Unchanged content MUST
// serialize to a byte-identical file so diffs stay clean under git and backup
// tools and a no-op save rewrites nothing.
//
// The strategy: rebuild the document as a tree of plain objects whose keys are
// inserted in the canonical order, then `JSON.stringify(_, null, 2)`. Since
// stringify emits keys in insertion order, indents with 2 spaces, uses `\n` line
// breaks, never emits trailing whitespace, and writes minimal decimal integers,
// the canonical-ordering pass is the whole determinism story. We append a single
// trailing newline; the UTF-8/no-BOM part is the write layer's job.
//
// Key order (spec §9): envelope (schemaVersion, docId, docMeta, blocks); block
// (id, type, then type-specific); inline (kind, then fields, marks last); marks
// (em, strong, code, strikethrough, link); link (href, title); docMeta (title,
// createdAt, then preserved unknown keys in first-seen order).

import type {
  FolioBlock,
  FolioDocument,
  FolioInline,
  FolioListItem,
  FolioMarks,
  FolioMeta
} from './types';

// Only set marks are emitted, in canonical order — never `"em": false`.
function orderMarks(m: FolioMarks): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.em === true) out.em = true;
  if (m.strong === true) out.strong = true;
  if (m.code === true) out.code = true;
  if (m.strikethrough === true) out.strikethrough = true;
  if (m.link) out.link = { href: m.link.href, title: m.link.title ?? null };
  return out;
}

function orderInline(n: FolioInline): Record<string, unknown> {
  switch (n.kind) {
    case 'text':
      return { kind: 'text', text: n.text, marks: orderMarks(n.marks) };
    case 'image':
      return {
        kind: 'image',
        url: n.url,
        alt: n.alt,
        title: n.title ?? null,
        marks: orderMarks(n.marks)
      };
    case 'break':
      return { kind: 'break', marks: orderMarks(n.marks) };
  }
}

function orderListItem(item: FolioListItem): Record<string, unknown> {
  const out: Record<string, unknown> = { spread: item.spread };
  if (typeof item.checked === 'boolean') out.checked = item.checked;
  out.children = item.children.map(orderBlock);
  return out;
}

function orderBlock(b: FolioBlock): Record<string, unknown> {
  switch (b.type) {
    case 'paragraph':
      return { id: b.id, type: b.type, inline: b.inline.map(orderInline) };
    case 'heading':
      return { id: b.id, type: b.type, level: b.level, inline: b.inline.map(orderInline) };
    case 'code_block':
      return { id: b.id, type: b.type, lang: b.lang, meta: b.meta, text: b.text };
    case 'horizontal_rule':
      return { id: b.id, type: b.type };
    case 'blockquote':
      return { id: b.id, type: b.type, children: b.children.map(orderBlock) };
    case 'bullet_list':
      return { id: b.id, type: b.type, spread: b.spread, items: b.items.map(orderListItem) };
    case 'ordered_list':
      return {
        id: b.id,
        type: b.type,
        start: b.start,
        spread: b.spread,
        items: b.items.map(orderListItem)
      };
    case 'table':
      return {
        id: b.id,
        type: b.type,
        align: b.align,
        rows: b.rows.map((row) => row.map((cell) => cell.map(orderInline)))
      };
  }
}

// title and createdAt first, then any preserved unknown keys in first-seen order
// (Object key iteration preserves insertion order, which for a parsed object is
// the order the keys appeared in the source file).
function orderMeta(meta: FolioMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { title: meta.title ?? null, createdAt: meta.createdAt };
  for (const key of Object.keys(meta)) {
    if (key === 'title' || key === 'createdAt') continue;
    out[key] = meta[key];
  }
  return out;
}

function orderDocument(doc: FolioDocument): Record<string, unknown> {
  return {
    schemaVersion: doc.schemaVersion,
    docId: doc.docId,
    docMeta: orderMeta(doc.docMeta),
    blocks: doc.blocks.map(orderBlock)
  };
}

/** Serialize a `.folio` document to its canonical byte form: pretty-printed JSON,
 *  2-space indent, LF, single trailing newline. */
export function serializeFolio(doc: FolioDocument): string {
  return JSON.stringify(orderDocument(doc), null, 2) + '\n';
}
