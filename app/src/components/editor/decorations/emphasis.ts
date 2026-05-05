// Emphasis fold: bold, italic, strikethrough.
//
// The Lezer markdown grammar gives us three container nodes we care about:
//
//   - `Emphasis`        — `*italic*` or `_italic_`
//   - `StrongEmphasis`  — `**bold**` or `__bold__`
//   - `Strikethrough`   — `~~strike~~`  (GFM extension)
//
// Each container has marker children — `EmphasisMark` or `StrikethroughMark`
// — at the start and end of its range. We find those children, hide them
// with replace decorations, and apply a `mark` decoration carrying the
// visual style (bold/italic/strikethrough) to the range between them.
//
// Cursor handling: on any line where the cursor is, we skip the container
// entirely. The raw `**word**` shows through so the user can edit it.

import { Decoration } from '@codemirror/view';
import type { HandlerMap, NodeHandler } from './shared';

const CLASS_BOLD = 'cm-md-bold';
const CLASS_ITALIC = 'cm-md-italic';
const CLASS_STRIKETHROUGH = 'cm-md-strikethrough';

const MARKER_NODE_NAMES = new Set(['EmphasisMark', 'StrikethroughMark']);

function findBoundaryMarks(
  node: import('@lezer/common').SyntaxNodeRef
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  const container = node.node;
  let first = container.firstChild;
  let last = container.lastChild;

  while (first && !MARKER_NODE_NAMES.has(first.name)) {
    first = first.nextSibling;
  }
  while (last && !MARKER_NODE_NAMES.has(last.name)) {
    last = last.prevSibling;
  }
  if (!first || !last || first === last) return null;

  return {
    openFrom: first.from,
    openTo: first.to,
    closeFrom: last.from,
    closeTo: last.to
  };
}

function makeHandler(className: string): NodeHandler {
  return (node, ctx) => {
    if (ctx.isOnCursorLine(node.from, node.to)) return;
    const bounds = findBoundaryMarks(node);
    if (!bounds) return;
    const { openFrom, openTo, closeFrom, closeTo } = bounds;

    ctx.decorations.push(Decoration.replace({}).range(openFrom, openTo));
    if (closeFrom > openTo) {
      ctx.decorations.push(
        Decoration.mark({ class: className }).range(openTo, closeFrom)
      );
    }
    ctx.decorations.push(Decoration.replace({}).range(closeFrom, closeTo));
  };
}

export const emphasisHandlers: HandlerMap = {
  Emphasis: makeHandler(CLASS_ITALIC),
  StrongEmphasis: makeHandler(CLASS_BOLD),
  Strikethrough: makeHandler(CLASS_STRIKETHROUGH)
};
