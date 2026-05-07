// Shapes for lint findings. The engine itself lives in `app/src/lib/lint/`.

import type { LintRuleId, LintSeverity } from './skrive-toml';

export type LintFinding = {
  rule: LintRuleId;
  severity: Exclude<LintSeverity, 'off'>;
  /** Project-relative, forward-slash separated. */
  path: string;
  /** 1-indexed for display. */
  line: number;
  /** 1-indexed UTF-16 column for display. */
  column: number;
  /** UTF-16 code-unit range in the file body. Null for findings that
   *  don't have a meaningful inline span (e.g., missing frontmatter, an
   *  orphaned file) — the gutter falls back to the entire `line`. */
  range: { start: number; end: number } | null;
  /** Short human-readable description rendered in the panel and the
   *  CM6 diagnostic tooltip. */
  message: string;
};

export type ProjectLintReport = {
  findings: LintFinding[];
  /** Wall-clock time the engine finished, milliseconds since epoch. */
  ranAt: number;
};
