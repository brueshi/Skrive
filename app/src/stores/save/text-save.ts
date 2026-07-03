// The plain-text save path (SKR-204). A `.txt` save is text -> text at its
// simplest: the on-disk bytes ARE the tab's body, verbatim. No frontmatter (a
// `.txt`'s leading `---` is content, not metadata), no whitespace tidy, and — like
// the Markdown save wall (markdown-save.ts) — no reachable block/model serializer.
// This module imports nothing that can serialize a model, so a plain-text save
// can never round-trip through the block model.

/** The only tab shape a plain-text save can see: just its text buffer. */
export type TextSaveTab = { body: string };

/** Build the on-disk bytes for a plain-text tab — the body, untouched. */
export function buildTextPayload(tab: TextSaveTab): string {
  return tab.body;
}
