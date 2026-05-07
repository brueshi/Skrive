export type {
  Backlink,
  Block,
  BlockKind,
  DeadLink,
  DiffOp,
  Edge,
  FileContent,
  FileEntry,
  LineDiffRow,
  LineKind,
  LinkKind,
  LinkTarget,
  OutgoingLink,
  ProjectChange,
  ProjectManifest,
  Reference,
  RenamePreview,
  RenameReport,
  SkriveIpc,
  SkrivePlatform,
  WordOp
} from './ipc-contracts';

export type {
  FieldInfo,
  FrontmatterMap,
  ParsedDocument,
  ProjectSchema
} from './frontmatter';

export {
  inferSchema,
  mightHaveLeadingFrontmatter,
  parse as parseFrontmatter,
  serialize as serializeFrontmatter,
  valueTypeName
} from './frontmatter';

export type {
  DictionaryConfig,
  LintConfig,
  LintRuleId,
  LintSeverity,
  ProjectMeta,
  RequiredFrontmatterConfig,
  SkriveProjectConfig
} from './skrive-toml';

export {
  DEFAULT_LINT_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  LINT_RULE_IDS,
  LINT_RULE_TOML_KEYS
} from './skrive-toml';

export type { LintFinding, ProjectLintReport } from './lint';

export type {
  AppUiState,
  CursorPosition,
  EditorFontId,
  LayoutMode,
  ProjectUiState,
  RecentFile,
  RecentProject,
  SidebarState,
  TabState
} from './persistence';

export {
  DEFAULT_APP_UI_STATE,
  DEFAULT_RECENT_PROJECTS_CAP,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_SPLIT_DIVIDER_RATIO,
  defaultProjectUiState
} from './persistence';
