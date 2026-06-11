export type {
  SkriveError,
  SkriveErrorCode,
  SkriveEvent,
  SkriveRequest,
  SkriveResponse,
  SkriveResponseError,
  SkriveResponseOk
} from './ipc-contracts';

export {
  ENVELOPE_VERSION,
  MAX_REQUEST_BYTES,
  SKRIVE_CONTRACT_VERSION,
  SKRIVE_ERROR_CODES,
  SKRIVE_EVENT_CHANNEL,
  SKRIVE_INVOKE_CHANNEL
} from './ipc-contracts';

export type { SkriveTransport } from './bridge';
export { createSkriveBridge } from './bridge';

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
  ProjectSnapshot,
  SnapshotFile,
  CheckpointKind,
  CheckpointVersion,
  GitVersion,
  HistoryEntry,
  HistoryMode,
  Reference,
  RenamePreview,
  SearchHit,
  SearchOptions,
  SkriveIpc,
  SkrivePlatform,
  UpdaterStatus,
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
  CheckpointsConfig,
  DictionaryConfig,
  LintConfig,
  LintRuleId,
  LintSeverity,
  ProjectMeta,
  RequiredFrontmatterConfig,
  SkriveProjectConfig
} from './skrive-toml';

export {
  DEFAULT_CHECKPOINTS_CONFIG,
  DEFAULT_LINT_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  LINT_RULE_IDS,
  LINT_RULE_TOML_KEYS
} from './skrive-toml';

export { parseSkriveToml } from './skrive-toml-parse';

export type { LintFinding, ProjectLintReport } from './lint';

export type {
  AppUiState,
  CursorPosition,
  EditorFontId,
  LayoutMode,
  LineMeasure,
  MarkerMode,
  NewFileLocation,
  NewFileNaming,
  ProjectUiState,
  RecentFile,
  RecentProject,
  SidebarState,
  SlugFormat,
  SurfaceId,
  TabState,
  ThemeId
} from './persistence';

export {
  DEFAULT_APP_UI_STATE,
  DEFAULT_RECENT_PROJECTS_CAP,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_SPLIT_DIVIDER_RATIO,
  defaultProjectUiState
} from './persistence';
