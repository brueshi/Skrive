// heading_hierarchy — flag any heading whose level skips more than one
// step over the previous heading (h1 → h3 with no h2 between, etc.).
// Single-file scope.

import type { LintFinding } from '@skrive/shared';
import { extractHeadings } from '../mdast-utils';
import type { FileLintContext, FileRule } from '../types';

export const headingHierarchyRule: FileRule = {
  id: 'heading_hierarchy',
  scope: 'file',
  defaultSeverity: 'warn',
  run(ctx: FileLintContext, severity): LintFinding[] {
    const headings = extractHeadings(ctx.ast);
    let previousLevel = 0;
    const out: LintFinding[] = [];

    for (const heading of headings) {
      if (previousLevel === 0) {
        previousLevel = heading.depth;
        continue;
      }
      if (heading.depth > previousLevel + 1) {
        const start = heading.position?.start;
        const end = heading.position?.end;
        const range =
          typeof start?.offset === 'number' && typeof end?.offset === 'number'
            ? { start: start.offset, end: end.offset }
            : null;
        out.push({
          rule: 'heading_hierarchy',
          severity,
          path: ctx.path,
          line: start?.line ?? 1,
          column: start?.column ?? 1,
          range,
          message: `Heading skips from h${previousLevel} to h${heading.depth}.`
        });
      }
      previousLevel = heading.depth;
    }

    return out;
  }
};
