// Re-export shim. The single mdast parser now lives in ../markdown-core/mdast,
// shared with the canonical block model so both halves of the round-trip parse
// through the exact same configuration. Kept at this path so the projection's
// parse/serialize and the existing fidelity tests import it unchanged.

export { parseMarkdown } from '../markdown-core/mdast';
