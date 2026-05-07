// orphaned_files — surface every project file with zero inbound edges
// as a finding. Cross-file scope; defaults to off (per
// `docs/skrive-toml-reference.md`). The shell-side `linkGraph.orphanedAmong`
// computes the underlying set; this rule just reshapes it.
//
// Wiki edges aren't tracked in the backward index, so a file referenced
// only via `[[name]]` will be flagged. The rule is opt-in by default;
// users who enable it should be aware of the caveat.

import type { LintFinding } from '@skrive/shared';
import type { ProjectLintContext, ProjectRule } from '../types';

export const orphanedFilesRule: ProjectRule = {
  id: 'orphaned_files',
  scope: 'project',
  defaultSeverity: 'off',
  run(ctx: ProjectLintContext, severity): LintFinding[] {
    return ctx.orphanedFiles.map((path) => ({
      rule: 'orphaned_files' as const,
      severity,
      path,
      line: 1,
      column: 1,
      range: null,
      message: 'No other file in the project links to this file.'
    }));
  }
};
