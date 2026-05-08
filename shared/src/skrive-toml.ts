// `.skrive.toml` schema — types only. The parser lives in `shell/`.
//
// Mirrors the Rust shapes from `src-tauri/src/config.rs`:
//   - severity is `'error' | 'warn' | 'off'` to match the on-disk strings.
//   - rule keys are camelCase on the wire even though the TOML uses
//     snake_case; the parser does the rename so the rest of the app sees
//     the JS-conventional shape.
//
// The schema reference lives in `docs/skrive-toml-reference.md`.

export type LintSeverity = 'error' | 'warn' | 'off';

export type LintRuleId =
  | 'broken_internal_links'
  | 'missing_required_frontmatter'
  | 'heading_hierarchy'
  | 'orphaned_files'
  | 'duplicate_headings';

export type RequiredFrontmatterConfig = {
  fields: string[];
};

export type LintConfig = {
  brokenInternalLinks: LintSeverity;
  missingRequiredFrontmatter: LintSeverity;
  headingHierarchy: LintSeverity;
  orphanedFiles: LintSeverity;
  duplicateHeadings: LintSeverity;
  requiredFrontmatter: RequiredFrontmatterConfig;
};

export type DictionaryConfig = {
  /** Project-scoped extra spellcheck words. Additive on top of the
   *  personal dictionary. */
  projectWords: string[];
};

export type ProjectMeta = {
  /** Display name. Falls back to the project directory's basename when
   *  absent or empty. */
  name: string | null;
};

/** Retention caps for the Skrive-managed checkpoint history (Phase 10).
 *  Only consulted when the project is in checkpoint history mode (no
 *  `.git/` at the root). `autoCap` bounds the auto-checkpoint stack
 *  per file; `manualCap == 0` means unbounded — the historical
 *  default for explicit pins. */
export type CheckpointsConfig = {
  autoCap: number;
  manualCap: number;
};

export type SkriveProjectConfig = {
  project: ProjectMeta;
  lint: LintConfig;
  dictionary: DictionaryConfig;
  checkpoints: CheckpointsConfig;
};

export const DEFAULT_CHECKPOINTS_CONFIG: CheckpointsConfig = {
  autoCap: 50,
  manualCap: 0
};

export const DEFAULT_LINT_CONFIG: LintConfig = {
  brokenInternalLinks: 'error',
  missingRequiredFrontmatter: 'warn',
  headingHierarchy: 'warn',
  orphanedFiles: 'off',
  duplicateHeadings: 'warn',
  requiredFrontmatter: { fields: [] }
};

export const DEFAULT_PROJECT_CONFIG: SkriveProjectConfig = {
  project: { name: null },
  lint: DEFAULT_LINT_CONFIG,
  dictionary: { projectWords: [] },
  checkpoints: DEFAULT_CHECKPOINTS_CONFIG
};

/** Mapping between the TOML on-disk key (snake_case) and the JS-side rule id.
 *  Used by the parser, the lint engine, and any UI that surfaces the rule's
 *  configured key name. */
export const LINT_RULE_TOML_KEYS: Record<LintRuleId, keyof Omit<LintConfig, 'requiredFrontmatter'>> = {
  broken_internal_links: 'brokenInternalLinks',
  missing_required_frontmatter: 'missingRequiredFrontmatter',
  heading_hierarchy: 'headingHierarchy',
  orphaned_files: 'orphanedFiles',
  duplicate_headings: 'duplicateHeadings'
};

export const LINT_RULE_IDS: LintRuleId[] = [
  'broken_internal_links',
  'missing_required_frontmatter',
  'heading_hierarchy',
  'orphaned_files',
  'duplicate_headings'
];
