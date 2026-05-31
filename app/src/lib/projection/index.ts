// The projection bridge: a ProseMirror rich-edit tree projected over canonical
// Markdown text. Text is the source of truth; PM is the projection.
//
//   parseDoc(md)        Markdown -> PM doc, capturing a verbatim source map.
//   serializeDoc(doc)   PM doc -> Markdown, splicing untouched blocks verbatim.
//   dirtyPlugin         marks only the touched top-level blocks dirty as you edit.
//   schema              the PM schema for the Rich surface.
//
// See planning/projection-editor-master-plan.md (Stage 1).

export { schema } from './schema';
export { parseDoc } from './parse';
export { serializeDoc } from './serialize';
export { dirtyPlugin } from './dirty';
