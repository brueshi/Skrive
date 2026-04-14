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
// Nesting is handled automatically. If the tree has an `Emphasis` inside a
// `StrongEmphasis`, the walker visits both containers and each one installs
// its own markers + inner style, so `***bold italic***` renders correctly.
//
// Cursor handling: on any line where the cursor is, we skip the container
// entirely. The raw `**word**` shows through so the user can edit it. The
// moment the cursor leaves the line the marks vanish again.

import { Decoration } from "@codemirror/view";
import type { HandlerMap, NodeHandler } from "./shared";

// Class names on mark decorations. Styles live in the global CSS block
// at the bottom of Editor.svelte — keeping them there means the decorations
// package has no CSS ownership, which is the simplest arrangement.
const CLASS_BOLD = "cm-md-bold";
const CLASS_ITALIC = "cm-md-italic";
const CLASS_STRIKETHROUGH = "cm-md-strikethrough";

const MARKER_NODE_NAMES = new Set(["EmphasisMark", "StrikethroughMark"]);

/**
 * Given an Emphasis / StrongEmphasis / Strikethrough container node, find
 * its opening and closing marker child nodes. Returns `null` if the tree
 * isn't shaped the way we expect — which happens at the very edge of
 * editing state, e.g. when the user has just typed `*` and the parser
 * hasn't finished the second mark yet.
 */
function findBoundaryMarks(
  node: import("@lezer/common").SyntaxNodeRef,
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  // SyntaxNodeRef doesn't expose the mutable cursor API directly; take
  // the `.node` handle and walk children.
  const container = node.node;
  let first = container.firstChild;
  let last = container.lastChild;

  // Skip past anything that isn't one of our marker names. In practice
  // `firstChild` is the opening mark and `lastChild` is the closing one,
  // but we defend against the parser giving us a different shape during
  // an in-flight edit.
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
    closeTo: last.to,
  };
}

/**
 * Build a handler that folds the markers of a given emphasis container
 * type and styles its interior with `className`. The same pattern works
 * for italic, bold, and strikethrough — the only differences are the
 * container node name (handled by the registration below) and the class
 * applied to the inner text.
 */
function makeHandler(className: string): NodeHandler {
  return (node, ctx) => {
    if (ctx.isOnCursorLine(node.from, node.to)) return;
    const bounds = findBoundaryMarks(node);
    if (!bounds) return;
    const { openFrom, openTo, closeFrom, closeTo } = bounds;

    // The parser guarantees `openTo <= closeFrom`, so the three decorations
    // are pushed in document order — no extra sort required.
    ctx.decorations.push(Decoration.replace({}).range(openFrom, openTo));
    if (closeFrom > openTo) {
      ctx.decorations.push(
        Decoration.mark({ class: className }).range(openTo, closeFrom),
      );
    }
    ctx.decorations.push(Decoration.replace({}).range(closeFrom, closeTo));
  };
}

export const emphasisHandlers: HandlerMap = {
  Emphasis: makeHandler(CLASS_ITALIC),
  StrongEmphasis: makeHandler(CLASS_BOLD),
  Strikethrough: makeHandler(CLASS_STRIKETHROUGH),
};
