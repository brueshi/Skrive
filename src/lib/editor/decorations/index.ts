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
import { imageHandlers } from "./images";
import { linkHandlers } from "./links";
import { stableEmphasisField } from "./stable";

const HANDLERS: HandlerMap = {
  ...emphasisHandlers,
  ...headingHandlers,
  ...linkHandlers,
  ...codeHandlers,
  ...imageHandlers,
};

export function inlinePreview() {
  // Three pieces:
  //   - The view plugin that folds markup on *non-cursor* lines.
  //   - The stable-emphasis state field that keeps bold/italic/strikethrough
  //     styling steady on the cursor line even when the parser briefly
  //     loses the span (e.g. trailing whitespace before the closing mark).
  return [createInlinePlugin(HANDLERS), stableEmphasisField];
}
