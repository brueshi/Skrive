// Hide the bracket and URL portions of a Markdown link on non-cursor lines.
//
// The Lezer markdown grammar parses `[label](https://example.com)` as a
// `Link` node whose children are (in document order):
//
//   LinkMark `[`
//   ... label content (plain text, possibly with nested Emphasis / Code / ...)
//   LinkMark `]`
//   LinkMark `(`
//   URL
//   LinkMark `)`
//
// (optionally with a LinkTitle between URL and the final `)`).
//
// We want the label text to appear as a clean, link-styled phrase — so we
// replace the opening `[` with nothing, and replace everything from the
// closing `]` through the end of the Link node with nothing. That hides
// `](url)` in one contiguous replace range and leaves the label alone.
//
// Link styling itself (color + underline) comes from the `t.link` highlight
// tag in `skrive-theme.ts`. We don't need to add a class here because
// emphasis styling is the only thing we yanked out of the highlight style,
// and links aren't subject to the whitespace-driven parser churn that made
// emphasis worth relocating.
//
// Reference-style links (`[label][ref]`, `[label]`, `[ref]: url`) are a
// separate category in the grammar (`LinkReference` etc.) and are not
// handled here. Adding them is a follow-up once they matter.

import { Decoration } from "@codemirror/view";
import type { HandlerMap, NodeHandler } from "./shared";

const linkHandler: NodeHandler = (node, ctx) => {
  if (ctx.isOnCursorLine(node.from, node.to)) return;

  const container = node.node;
  const first = container.firstChild;
  if (!first || first.name !== "LinkMark") return;

  // The second `LinkMark` in the child list is the closing `]`. Everything
  // from its start position to the end of the Link node is `](url)`
  // (plus optional title).
  let closeStart: number | null = null;
  let child = first.nextSibling;
  while (child) {
    if (child.name === "LinkMark") {
      closeStart = child.from;
      break;
    }
    child = child.nextSibling;
  }
  if (closeStart === null) return;

  ctx.decorations.push(Decoration.replace({}).range(first.from, first.to));
  ctx.decorations.push(
    Decoration.replace({}).range(closeStart, container.to),
  );
};

export const linkHandlers: HandlerMap = {
  Link: linkHandler,
};
