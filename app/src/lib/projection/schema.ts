// The ProseMirror schema for the Rich surface, projected over canonical Markdown.
//
// PM is a projection; the Markdown text on disk is the truth. The fidelity
// mechanism lives in the block attributes:
//   - src        the verbatim original Markdown bytes for this block, captured
//                at parse time; null for a block created fresh in the editor.
//   - gapBefore  the verbatim bytes at the SEAM before this block (blank lines /
//                separators). A captured string (possibly '') means the seam is
//                known and serializes verbatim; null means the seam is new and
//                the separator is reconstructed. Keying gaps to the seam this way
//                — rather than to the block's dirty state — is what lets inter-
//                block whitespace survive a block changing type or being edited.
//   - dirty      whether this block's content was modified since parse. Clean
//                blocks serialize from `src` verbatim; dirty blocks serialize
//                canonically (subject to the idempotence guard).
//
// Splicing is at top-level block granularity: a list is one block, so editing
// any item marks the whole list dirty. Finer (per-item) granularity is a later
// refinement, not the mechanism.
//
// `frozen_block` is the honest home for any construct the schema does not model
// richly (raw HTML, and constructs nested in a container we don't recurse into). It
// is an atom holding its verbatim source; it always serializes byte-for-byte and
// can never be canonicalized into something lossy. This is strictly safer than
// projecting an unmodeled construct onto a paragraph, which would silently strip
// its syntax the moment the writer edits it.

import { Schema } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';

const blockAttrs = {
  src: { default: null as string | null },
  gapBefore: { default: null as string | null },
  dirty: { default: false }
};

// prosemirror-tables supplies the table / row / cell node specs (and, paired
// with its `tableEditing` plugin in the Rich surface, the cell-selection and
// navigation behaviour). GFM table cells are inline-only, so `cellContent` is
// `inline*`. `align` carries the GFM column alignment: set per cell from the
// source's delimiter row at parse time, read back from the header row when
// serializing. The `table` node additionally takes the projection blockAttrs so
// it owns its verbatim `src` as a unit, exactly like every other top-level block.
const tableSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'inline*',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = `text-align: ${String(value)}`;
      }
    }
  }
});

export const schema = new Schema({
  nodes: {
    doc: {
      content: 'block+',
      // Bytes after the last block to end-of-file (trailing newline, etc.).
      attrs: { trailingGap: { default: '' } }
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { ...blockAttrs },
      toDOM: () => ['p', 0]
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { ...blockAttrs, level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0]
    },
    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      // `fence` is the literal opening fence captured from the source ('```',
      // '~~~~', ...; null for an indented block or one created in the editor) and
      // `meta` is the info string after the language. Both are style/fidelity
      // captures: a dirty block re-serializes with the writer's own fence
      // character — re-fencing a `~~~` block with backticks corrupts it when the
      // body contains ``` lines — and keeps the info string the parser exposes
      // but the editor does not surface.
      attrs: {
        ...blockAttrs,
        lang: { default: '' },
        meta: { default: null as string | null },
        fence: { default: null as string | null }
      },
      code: true,
      defining: true,
      toDOM: () => ['pre', ['code', 0]]
    },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      // `marker` (`*`, `-`, or `+`) is a style hint captured from the source so a
      // dirty list re-serializes in the writer's own marker, not one canonical
      // form. `spread` records whether the list is loose (blank lines between
      // items) so it re-serializes with the same rhythm. Style-aware
      // serialization keeps editing from churning bytes the writer never chose.
      attrs: { ...blockAttrs, marker: { default: '-' }, spread: { default: false } },
      toDOM: () => ['ul', 0]
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      // `start` is the first ordinal; `delimiter` is `.` or `)`; `spread` records
      // loose vs tight. All captured from source for style-aware re-serialization.
      attrs: {
        ...blockAttrs,
        start: { default: 1 },
        delimiter: { default: '.' },
        spread: { default: false }
      },
      toDOM: (node) => ['ol', { start: node.attrs.start }, 0]
    },
    list_item: {
      // `paragraph block*` (the prosemirror-schema-list shape): an item opens
      // with a paragraph and may carry further blocks — nested sub-lists, extra
      // paragraphs for a loose item. This is what lets nested and loose lists be
      // modeled instead of frozen.
      content: 'paragraph block*',
      // `spread` is the ITEM's own rhythm — whether ITS child blocks are blank-
      // line-separated — distinct from the list's spread (blank lines between
      // items). A loose list can hold a tight item (intro paragraph with a
      // nested sub-list packed right under it); joining that item's blocks by
      // the list's spread would inject a blank line and flip the re-parsed
      // listItem.spread.
      attrs: { spread: { default: false } },
      defining: true,
      toDOM: () => ['li', 0]
    },
    blockquote: {
      group: 'block',
      // Holds any block content: prose, headings, dividers, lists, nested
      // quotes. The blockquote owns its verbatim `src` as a unit — its children
      // carry no source map and are only emitted when the quote is dirtied,
      // re-quoted line-by-line by the serializer.
      content: 'block+',
      attrs: { ...blockAttrs },
      toDOM: () => ['blockquote', 0]
    },
    horizontal_rule: {
      group: 'block',
      // An atom: no content to edit, only inserted or deleted. It still carries
      // the block attrs so a parsed rule round-trips its own marker style (`---`
      // vs `***` vs `___`) verbatim while clean, and a freshly-inserted one
      // serializes to the canonical `---`.
      atom: true,
      selectable: true,
      attrs: { ...blockAttrs },
      toDOM: () => ['hr', { class: 'pm-hr' }]
    },
    frozen_block: {
      group: 'block',
      atom: true,
      selectable: true,
      // No `dirty`: a frozen block is always emitted verbatim from `src`.
      attrs: { src: { default: '' }, gapBefore: { default: null as string | null } },
      toDOM: (node) => ['div', { class: 'pm-frozen-block', 'data-frozen': '' }, String(node.attrs.src)]
    },
    table: { ...tableSpecs.table, attrs: { ...blockAttrs } },
    table_row: tableSpecs.table_row,
    table_cell: tableSpecs.table_cell,
    table_header: tableSpecs.table_header,
    text: { group: 'inline' },
    // A within-block line break (Shift-Enter), distinct from a soft break (a bare
    // `\n` in the source, which renders as a space). Serializes to a CommonMark
    // backslash hard break; renders as <br>. It may carry marks: a break inside
    // emphasis must stay inside the emphasis when the serializer reconstructs
    // the inline tree, or the emphasis splits in two on re-parse.
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br']
    },
    // An inline image, modeled as a real leaf so dirtying its paragraph cannot
    // delete it (it used to fall through inlineToPM's text-only default and
    // vanish). Fidelity first: url/alt/title round-trip exactly; display polish
    // (placeholders, resolution of relative paths) is a separate concern.
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      draggable: false,
      attrs: {
        url: { default: '' },
        alt: { default: '' },
        title: { default: null as string | null }
      },
      toDOM: (node) => {
        const attrs: Record<string, string> = {
          src: String(node.attrs.url),
          alt: String(node.attrs.alt),
          class: 'pm-image'
        };
        if (node.attrs.title != null) attrs.title = String(node.attrs.title);
        return ['img', attrs];
      }
    }
  },
  marks: {
    // Order matters only for default nesting; serialization coalesces runs.
    code: {
      toDOM: () => ['code', 0]
    },
    em: { toDOM: () => ['em', 0] },
    strong: { toDOM: () => ['strong', 0] },
    link: {
      // `title` is the optional CommonMark link title (`[t](url "title")`),
      // captured so a dirtied paragraph does not silently drop it.
      attrs: { href: {}, title: { default: null as string | null } },
      toDOM: (mark) => {
        const attrs: Record<string, string> = { href: String(mark.attrs.href) };
        if (mark.attrs.title != null) attrs.title = String(mark.attrs.title);
        return ['a', attrs, 0];
      }
    }
  }
});
