// Internal types shared between engine + rules. The wire shape
// (`LintFinding`, `ProjectLintReport`) lives in `@skrive/shared`.

import type {
  DeadLink,
  LintConfig,
  LintFinding,
  LintRuleId,
  LintSeverity,
  ProjectManifest,
  SkriveProjectConfig
} from '@skrive/shared';
import type { Root as MdastRoot } from 'mdast';

export type LintEngineInput = {
  manifest: ProjectManifest;
  /** Map from project-relative path to current body. The engine pulls
   *  parsed AST + frontmatter for the per-file rules from this map.
   *  Files not present here fall back to a body-less view (reads only
   *  manifest data). */
  bodies: Map<string, string>;
  /** Latest IPC result for `linkGraph.getDeadLinks()`. Drives the
   *  `broken_internal_links` rule. */
  deadLinks: DeadLink[];
  /** Latest IPC result for `linkGraph.getOrphanedFiles()`. Drives the
   *  `orphaned_files` rule. */
  orphanedFiles: string[];
};

/** Per-file context passed to single-file rules. */
export type FileLintContext = {
  path: string;
  body: string;
  ast: MdastRoot;
  /** Already-parsed frontmatter from the manifest. */
  frontmatter: Record<string, unknown>;
  config: LintConfig;
  fullConfig: SkriveProjectConfig;
};

/** Project-wide context passed to cross-file rules. */
export type ProjectLintContext = {
  manifest: ProjectManifest;
  config: LintConfig;
  fullConfig: SkriveProjectConfig;
  deadLinks: DeadLink[];
  orphanedFiles: string[];
};

export type FileRule = {
  id: LintRuleId;
  scope: 'file';
  defaultSeverity: LintSeverity;
  run(ctx: FileLintContext, severity: Exclude<LintSeverity, 'off'>): LintFinding[];
};

export type ProjectRule = {
  id: LintRuleId;
  scope: 'project';
  defaultSeverity: LintSeverity;
  run(
    ctx: ProjectLintContext,
    severity: Exclude<LintSeverity, 'off'>
  ): LintFinding[];
};

export type Rule = FileRule | ProjectRule;
