// The Markdown save path (SKR-196). This module is the load-bearing wall: a `.md`
// save is text -> text, so it MUST NOT be able to reach any block/model serializer.
//
// It imports frontmatter helpers and nothing else — no `serializeDocument`, no
// `serializeFolio`, no `modelToFolio` — and its tab argument type (`MarkdownSaveTab`)
// deliberately cannot name a `model`. There is therefore no code path from a
// Markdown save to a serializer: the output is the tab's own text buffer, verbatim
// (plus frontmatter and an optional whitespace tidy). `markdown-save-bypass.test.ts`
// asserts this structurally by scanning this file's source for serializer imports.
//
// Reintroducing the SKR-153 round-trip bug class would require editing this file to
// import a serializer (a red test) AND defeating the type wall — that is what makes
// the trap structurally impossible rather than merely avoided.

import { usePreferencesStore } from '../preferences';
import {
  mightHaveLeadingFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  stampAutoFields,
  type FrontmatterMap
} from '../../lib/frontmatter';

/** The only tab shape a Markdown save can see. No `model` field by construction. */
export type MarkdownSaveTab = { body: string; frontmatter: FrontmatterMap };

/** Conservative "format on save": tidy whitespace without touching what renders.
 *  Whitespace-only lines are cleared (blank either way, and never Markdown hard
 *  breaks, which live as trailing spaces on content lines and are preserved here),
 *  and the file ends with exactly one trailing newline. Deliberately does not
 *  reflow, collapse blank runs, or restyle, so it can't change meaning or mangle
 *  code. */
function normalizeMarkdownSpacing(body: string): string {
  const cleared = body
    .split('\n')
    .map((line) => (/^[ \t]+$/.test(line) ? '' : line))
    .join('\n')
    .replace(/\n+$/, '');
  return cleared.length === 0 ? '' : `${cleared}\n`;
}

/**
 * Build the on-disk bytes for a Markdown tab. Re-stamps auto-fields, absorbs any
 * leading `---` block the user typed straight into the editor body into the
 * structured map, and concatenates the serialized frontmatter with the body.
 * Mutates `tab.frontmatter` / `tab.body` if absorption happened so the panel
 * reflects the absorbed fields — callers clone the tab before invoking.
 *
 * The body passes through untouched (save is text -> text); the only optional
 * transform is the whitespace tidy above, gated on the formatOnSave preference.
 */
export function buildMarkdownPayload(tab: MarkdownSaveTab): string {
  // Absorb a leading frontmatter block the user typed into the editor. Only
  // attempts this when the structured map is currently empty — otherwise we'd be
  // silently merging two sources of truth.
  if (Object.keys(tab.frontmatter).length === 0 && mightHaveLeadingFrontmatter(tab.body)) {
    const extracted = parseFrontmatter(tab.body);
    if (Object.keys(extracted.frontmatter).length > 0) {
      tab.frontmatter = extracted.frontmatter;
      tab.body = extracted.body;
    }
  }
  stampAutoFields(tab.frontmatter, tab.body);
  const body = usePreferencesStore.getState().formatOnSave
    ? normalizeMarkdownSpacing(tab.body)
    : tab.body;
  return serializeFrontmatter(tab.frontmatter) + body;
}
