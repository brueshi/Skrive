// Build-resolution shim, aliased in for `decode-named-character-reference`
// (see electron.vite.config.ts). That package — a transitive dependency of
// `mdast-util-from-markdown` via micromark — ships a DOM build, selected by its
// `browser` export condition, that calls `document.createElement` at module
// load to decode HTML entities. The lint engine runs in a Web Worker, which is
// browser-like but has no `document`, so importing that build throws.
//
// This reproduces the package's own Node build verbatim: a pure lookup in the
// `character-entities` table, with results identical to the DOM build. It is the
// canonical implementation (HTML5's named-entity set is fixed and the package is
// 1.x), so the duplication is stable. The alias is renderer-wide; the main
// thread is unaffected because decoding is equivalent (and a touch faster — no
// per-call DOM element churn).

import { characterEntities } from 'character-entities';

const own = {}.hasOwnProperty;

export function decodeNamedCharacterReference(value: string): string | false {
  return own.call(characterEntities, value) ? characterEntities[value]! : false;
}
