// `.folio` v1 — Skrive's native rich-document format (SKR-195). Pure I/O: a
// deterministic writer, a tolerant reader, a docId generator, and the block-model
// seam. No filesystem and no engine dependency — the actual atomic write reuses
// the extension-agnostic `window.skrive.fs.writeFile` host path (temp + fsync +
// rename), and mode routing / save orchestration is wired in SKR-196.
//
// Public spec: `docs/folio-schema-v1.md`.

export * from './types';
export { serializeFolio } from './serialize';
export { parseFolio, FolioForwardError, FolioParseError } from './parse';
export { modelToFolio, folioToModel } from './convert';
export {
  generateDocId,
  makeDocIdGenerator,
  DOC_ID_RE,
  type Clock,
  type UlidRandom
} from './docid';
