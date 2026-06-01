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
// richly (tables, HTML, loose/nested lists). It
// is an atom holding its verbatim source; it always serializes byte-for-byte and
// can never be canonicalized into something lossy. This is strictly safer than
// projecting an unmodeled construct onto a paragraph, which would silently strip
// its syntax the moment the writer edits it.

import { Schema } from 'prosemirror-model';

const blockAttrs = {
  src: { default: null as string | null },
  gapBefore: { default: null as string | null },
  dirty: { default: false }
};

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
      attrs: { ...blockAttrs, lang: { default: '' } },
      code: true,
      defining: true,
      toDOM: () => ['pre', ['code', 0]]
    },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      // `marker` (`*`, `-`, or `+`) is a style hint captured from the source so a
      // dirty list re-serializes in the writer's own marker, not one canonical
      // form. Style-aware serialization keeps editing from churning bytes the
      // writer never chose.
      attrs: { ...blockAttrs, marker: { default: '-' } },
      toDOM: () => ['ul', 0]
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      // `start` is the first ordinal; `delimiter` is `.` or `)`. Both captured
      // from source for style-aware re-serialization.
      attrs: { ...blockAttrs, start: { default: 1 }, delimiter: { default: '.' } },
      toDOM: (node) => ['ol', { start: node.attrs.start }, 0]
    },
    list_item: {
      content: 'paragraph+',
      defining: true,
      toDOM: () => ['li', 0]
    },
    blockquote: {
      group: 'block',
      // Holds any block content: prose, headings, dividers, nested quotes (lists
      // join in 2.5c). The blockquote owns its verbatim `src` as a unit — its
      // children carry no source map and are only emitted when the quote is
      // dirtied, re-quoted line-by-line by the serializer.
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
    text: { group: 'inline' }
  },
  marks: {
    // Order matters only for default nesting; serialization coalesces runs.
    code: {
      toDOM: () => ['code', 0]
    },
    em: { toDOM: () => ['em', 0] },
    strong: { toDOM: () => ['strong', 0] },
    link: {
      attrs: { href: {} },
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0]
    }
  }
});
