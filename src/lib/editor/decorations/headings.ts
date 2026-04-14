// Hide the leading `#` / `##` / `###` / ... markers on ATX heading lines
// when the cursor isn't on them. The heading text itself stays sized and
// weighted via the `t.heading` highlight tags, which are left in place
// (unlike emphasis, there's no whitespace-driven parser churn to fight —
// a line starting with `# ` is either a heading or it isn't, and the
// user sees the same state either way).
//
// The `HeaderMark` node in @lezer/markdown covers the `#` characters plus
// the trailing space between them and the heading text. We replace that
// whole range so the text flows left to the line's content padding, which
// is how a finished document reads in a reader.

import { Decoration } from "@codemirror/view";
import type { HandlerMap } from "./shared";

/**
 * Handler for every ATXHeading level. The parser gives us the container
 * node; we find its first child (always `HeaderMark` for an ATX heading)
 * and replace it.
 */
const headingHandler: HandlerMap[string] = (node, ctx) => {
  if (ctx.isOnCursorLine(node.from, node.to)) return;
  const first = node.node.firstChild;
  if (!first || first.name !== "HeaderMark") return;
  ctx.decorations.push(
    Decoration.replace({}).range(first.from, first.to),
  );
};

export const headingHandlers: HandlerMap = {
  ATXHeading1: headingHandler,
  ATXHeading2: headingHandler,
  ATXHeading3: headingHandler,
  ATXHeading4: headingHandler,
  ATXHeading5: headingHandler,
  ATXHeading6: headingHandler,
};
