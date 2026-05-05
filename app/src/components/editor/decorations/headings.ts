// Hide the leading `#` / `##` / `###` / ... markers on ATX heading lines
// when the cursor isn't on them. The heading text itself stays sized and
// weighted via the `t.heading` highlight tags, which are left in place.
//
// The `HeaderMark` node in @lezer/markdown covers the `#` characters plus
// the trailing space between them and the heading text. We replace that
// whole range so the text flows left to the line's content padding.

import { Decoration } from '@codemirror/view';
import type { HandlerMap } from './shared';

const headingHandler: HandlerMap[string] = (node, ctx) => {
  if (ctx.isOnCursorLine(node.from, node.to)) return;
  const first = node.node.firstChild;
  if (!first || first.name !== 'HeaderMark') return;
  ctx.decorations.push(Decoration.replace({}).range(first.from, first.to));
};

export const headingHandlers: HandlerMap = {
  ATXHeading1: headingHandler,
  ATXHeading2: headingHandler,
  ATXHeading3: headingHandler,
  ATXHeading4: headingHandler,
  ATXHeading5: headingHandler,
  ATXHeading6: headingHandler
};
