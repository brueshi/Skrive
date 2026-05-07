// broken_internal_links — surface every dead-link entry from the link
// graph as a finding. Cross-file scope; consumes the precomputed
// `linkGraph.getDeadLinks()` IPC result, doesn't re-implement link
// extraction.

import type { LintFinding } from '@skrive/shared';
import type { ProjectLintContext, ProjectRule } from '../types';

export const brokenInternalLinksRule: ProjectRule = {
  id: 'broken_internal_links',
  scope: 'project',
  defaultSeverity: 'error',
  run(ctx: ProjectLintContext, severity): LintFinding[] {
    return ctx.deadLinks.map((dead) => ({
      rule: 'broken_internal_links' as const,
      severity,
      path: dead.source,
      // Link-graph lines/columns are 0-indexed; lint findings are 1-indexed.
      line: dead.line + 1,
      column: dead.column + 1,
      range: dead.range,
      message: `Link target "${dead.target}" doesn't exist in this project.`
    }));
  }
};
