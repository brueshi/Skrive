// Shared infrastructure for all inline-preview decorations.
//
// Every decoration in this directory follows the same pattern:
//
//   1. A `NodeHandler` function that knows how to handle a single Lezer
//      node type from the markdown grammar (Emphasis, Link, Image, ...).
//   2. A handler map registered with `createInlinePlugin`, which walks the
//      syntax tree across visible ranges on every relevant editor update
//      and dispatches to the right handler for each node it sees.
//
// The key correctness point is *cursor awareness*: on the line where the
// user is editing we reveal the raw markup so they can actually change it,
// everywhere else we hide the syntax. Handlers get this as a precomputed
// helper (`ctx.isOnCursorLine`) so they don't each reimplement it.
//
// This is the production replacement for the throwaway regex scanner in
// `src/lib/editor/spike/`. Handlers operate on Lezer nodes, so nested
// emphasis, code spans containing stars, escaped characters, and everything
// else the spike got wrong are handled correctly by the parser.

import type { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type {
  DecorationSet,
  EditorView,
  ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * Context passed to every handler. Handlers push decorations into the
 * shared `decorations` array and use `isOnCursorLine` to decide whether
 * to hide syntax or leave it revealed.
 */
export type DecorationContext = {
  view: EditorView;
  decorations: Range<Decoration>[];
  /**
   * True if any line between `from` and `to` (inclusive) contains a
   * cursor or selection range. Used to exclude the current editing
   * context from the fold so the user can still see what they're typing.
   */
  isOnCursorLine(from: number, to: number): boolean;
};

/**
 * Return `false` from a handler to tell the tree walker to skip this
 * node's subtree. Useful when a container handler (e.g. `Emphasis`) has
 * already produced decorations for its children and doesn't want those
 * children revisited by other handlers.
 */
export type NodeHandler = (
  node: SyntaxNodeRef,
  ctx: DecorationContext,
) => boolean | void;

export type HandlerMap = Record<string, NodeHandler>;

function computeCursorLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  const doc = view.state.doc;
  for (const range of view.state.selection.ranges) {
    const fromLine = doc.lineAt(range.from).number;
    const toLine = doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) lines.add(n);
  }
  return lines;
}

/**
 * Walk the syntax tree across the view's visible ranges and build a
 * `DecorationSet` by dispatching each encountered node to its handler.
 * Called on every relevant `ViewUpdate` — the work is proportional to
 * what's on screen, not the full document size.
 */
export function buildDecorations(
  view: EditorView,
  handlers: HandlerMap,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const cursorLines = computeCursorLines(view);
  const doc = view.state.doc;

  const ctx: DecorationContext = {
    view,
    decorations,
    isOnCursorLine(from, to) {
      const startLine = doc.lineAt(from).number;
      const endLine = doc.lineAt(to).number;
      for (let n = startLine; n <= endLine; n++) {
        if (cursorLines.has(n)) return true;
      }
      return false;
    },
  };

  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const handler = handlers[node.name];
        if (!handler) return;
        const result = handler(node, ctx);
        if (result === false) return false;
      },
    });
  }

  return Decoration.set(decorations, true);
}

/**
 * Build a `ViewPlugin` that keeps its decoration set in sync with the
 * editor's selection, viewport, and document. All inline-preview features
 * share the same plugin — it walks the tree once per update and the
 * per-feature handlers contribute their own decorations.
 */
export function createInlinePlugin(handlers: HandlerMap) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, handlers);
      }

      update(update: ViewUpdate) {
        // `selectionSet` is the critical trigger — the whole point of the
        // cursor-aware fold is that moving the caret toggles the reveal on
        // the affected lines. `docChanged` covers typing, and
        // `viewportChanged` covers scroll-driven reveal of new content.
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildDecorations(update.view, handlers);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
