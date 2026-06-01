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
// We replace the opening `[` with nothing, and replace everything from the
// closing `]` through the end of the Link node. That hides `](url)` in one
// contiguous replace range and leaves the label alone.

import { pushMarker } from './shared';
import type { HandlerMap, NodeHandler } from './shared';

const linkHandler: NodeHandler = (node, ctx) => {
  if (ctx.mode === 'raw') return;

  const container = node.node;
  const first = container.firstChild;
  if (!first || first.name !== 'LinkMark') return;

  let closeStart: number | null = null;
  let child = first.nextSibling;
  while (child) {
    if (child.name === 'LinkMark') {
      closeStart = child.from;
      break;
    }
    child = child.nextSibling;
  }
  if (closeStart === null) return;

  if (ctx.mode === 'concealed' && ctx.isOnCursorLine(node.from, node.to)) {
    return;
  }

  // Opening `[` and the trailing `](url)` are markers; the label between
  // them stays (link-styled by the highlighter).
  pushMarker(ctx, first.from, first.to);
  pushMarker(ctx, closeStart, container.to);
};

export const linkHandlers: HandlerMap = {
  Link: linkHandler
};
