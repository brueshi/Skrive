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
