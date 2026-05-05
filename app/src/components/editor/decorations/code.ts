// Inline code decorations.
//
// The Lezer markdown grammar builds `InlineCode` with exactly two
// children — the opening and closing `CodeMark`s — and the text between
// them is bare characters, not wrapped in any node. Without decorations
// the visual pattern is the backticks look like code and the text between
// them looks like prose. Hiding the backticks on non-cursor lines then
// strips out the only visual signal entirely, which is the bug this
// module fixes.
//
// What we do:
//
//   1. Always apply a `cm-md-code` class on the inner text range so it
//      renders in the monospace font regardless of whether the cursor is
//      on the line. Inline code doesn't suffer from the whitespace-driven
//      parser churn that emphasis does, so a plain view-plugin mark is
//      enough — no state-field stabilization needed.
//
//   2. Hide the backticks only when the cursor isn't on the line. The
//      user needs to see them to edit the boundaries.
//
// Fenced code blocks (triple-backtick with an optional language tag) are
// a separate feature parked for a later mini-phase.

import { Decoration } from '@codemirror/view';
import type { HandlerMap, NodeHandler } from './shared';

const inlineCodeHandler: NodeHandler = (node, ctx) => {
  const container = node.node;
  let first = container.firstChild;
  let last = container.lastChild;
  while (first && first.name !== 'CodeMark') first = first.nextSibling;
  while (last && last.name !== 'CodeMark') last = last.prevSibling;
  if (!first || !last || first === last) return;

  // Style the inner text as code whether or not the cursor is on the line.
  // Also disable the OS spellchecker on the same range — code identifiers
  // are not English prose.
  if (last.from > first.to) {
    ctx.decorations.push(
      Decoration.mark({
        class: 'cm-md-code',
        attributes: { spellcheck: 'false' }
      }).range(first.to, last.from)
    );
  }

  // Hide the backticks on non-cursor lines.
  if (!ctx.isOnCursorLine(node.from, node.to)) {
    ctx.decorations.push(Decoration.replace({}).range(first.from, first.to));
    ctx.decorations.push(Decoration.replace({}).range(last.from, last.to));
  }
};

export const codeHandlers: HandlerMap = {
  InlineCode: inlineCodeHandler
};
