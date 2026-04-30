// Public entry point for the inline-preview decorations system.
//
// Call `inlinePreview()` and spread it into your CodeMirror extension
// list. The returned array bundles every per-feature decoration module
// registered in `HANDLERS` below.
//
// Adding a new feature is a two-step change:
//   1. Write a handler module next to this file (e.g. `links.ts`) that
//      exports a `HandlerMap` with the Lezer node names it cares about.
//   2. Spread its handlers into `HANDLERS`.
//
// All features share a single `ViewPlugin` so the syntax tree is only
// walked once per editor update.

import { createInlinePlugin } from "./shared";
import type { HandlerMap } from "./shared";
import { codeHandlers } from "./code";
import { emphasisHandlers } from "./emphasis";
import { headingHandlers } from "./headings";
import { imageContextField, imageHandlers } from "./images";
import { linkHandlers } from "./links";

export { setImageContext } from "./images";
export type { ImageContext } from "./images";
import {
  personalDictionaryField,
  spellcheckFrontmatterPlugin,
  spellcheckHandlers,
} from "./spellcheck";
import { stableEmphasisField } from "./stable";

const HANDLERS: HandlerMap = {
  ...emphasisHandlers,
  ...headingHandlers,
  ...linkHandlers,
  ...codeHandlers,
  ...imageHandlers,
  // Spellcheck handlers operate on node types that none of the other
  // handlers register, so the merge is conflict-free. Inline code's
  // spellcheck disable lives inside `codeHandlers` instead because that
  // handler already mark-decorates the inner range and just adds the
  // attribute alongside its existing class.
  ...spellcheckHandlers,
};

export function inlinePreview() {
  // Five pieces:
  //   - The view plugin that folds markup on *non-cursor* lines and
  //     stamps `spellcheck="false"` on structural markdown regions.
  //   - The stable-emphasis state field that keeps bold/italic/strikethrough
  //     styling steady on the cursor line even when the parser briefly
  //     loses the span (e.g. trailing whitespace before the closing mark).
  //   - The frontmatter spellcheck plugin, separate from the tree-walker
  //     plugin because the markdown grammar doesn't expose frontmatter
  //     as a node — we scan the document prefix ourselves.
  //   - The personal dictionary state field, which tracks a list of
  //     user-supplied words and stamps `spellcheck="false"` on every
  //     occurrence of any listed word. The list is fed in via a
  //     `setPersonalDictionary` StateEffect that Editor.svelte dispatches
  //     whenever the corresponding Svelte rune changes.
  return [
    createInlinePlugin(HANDLERS),
    stableEmphasisField,
    spellcheckFrontmatterPlugin,
    personalDictionaryField,
    imageContextField,
  ];
}
