/**
 * The typed surface exposed by `shell/preload.ts` to `app/`.
 * Both sides import this; tsc catches drift.
 *
 * Surfaces grow per migration phase. Phase 1 = `app`. Phase 2 = `links`.
 * Phase 3 = `project` + `fs` + watcher subscriptions.
 */

import type { FrontmatterMap, ProjectSchema } from './frontmatter';
import type { AppUiState, ProjectUiState } from './persistence';
import type { SkriveProjectConfig } from './skrive-toml';

export type SkrivePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

// ============================ Project / file types ============================

export type FileEntry = {
  /** Project-relative, forward-slash separated. */
  path: string;
  /** Leaf filename (e.g., "chapter-3.md"). */
  name: string;
  sizeBytes: number;
  modifiedMs: number | null;
  /** Parsed YAML frontmatter map (Phase 7). Empty for files without a
   *  leading frontmatter block, or when parsing falls back leniently. */
  frontmatter: FrontmatterMap;
  outgoingLinks: string[];
};

export type ProjectManifest = {
  /** Canonical absolute path of the project root. */
  root: string;
  files: FileEntry[];
  /** Project-wide frontmatter schema, derived from every file's
   *  `frontmatter` map at scan time. Drives the panel's autocomplete. */
  schema: ProjectSchema;
  /** Parsed `.skrive.toml`, or defaults if the file is absent or
   *  unparseable. Phase 8 (lint) is the first real consumer; the
   *  schema is documented in `docs/skrive-toml-reference.md`. */
  config: SkriveProjectConfig;
  /** Human-readable warnings produced while parsing `.skrive.toml`.
   *  Empty when the file is absent, parses cleanly, or has no
   *  unrecognized fields. The renderer surfaces each as a sonner toast
   *  on open. Per `docs/skrive-toml-reference.md` § Parse behavior:
   *  parsing is warn-and-continue, never blocking. */
  warnings: string[];
};

export type FileContent = {
  path: string;
  body: string;
  modifiedMs: number | null;
};

/**
 * Watcher event emitted by the shell when chokidar reports a change.
 * The renderer listens via `project.onChange` and refreshes its
 * manifest/file caches accordingly.
 */
export type ProjectChange =
  | { kind: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'addDir' | 'unlinkDir'; path: string }
  | { kind: 'ready' };

// ============================ Diff types ============================
// Shapes mirror what `@skrive/diff` (native/diff) emits via serde —
// `BlockKind` and `DiffOp` are internally tagged on `kind`, with
// camelCase fields. The TS types here are the source of truth on the
// JS side; native/diff/__test__/fixtures.test.ts gates the boundary
// against the algorithm's Rust unit tests.

export type LineKind = 'kept' | 'added' | 'deleted';

export type LineDiffRow = {
  kind: LineKind;
  before: string | null;
  after: string | null;
};

export type BlockKind =
  | { kind: 'heading'; level: number }
  | { kind: 'paragraph' }
  | { kind: 'list' }
  | { kind: 'codeFence' }
  | { kind: 'blockquote' }
  | { kind: 'thematicBreak' }
  | { kind: 'table' };

export type Block = {
  kind: BlockKind;
  source: string;
};

export type WordOp =
  | { kind: 'kept'; text: string }
  | { kind: 'added'; text: string }
  | { kind: 'deleted'; text: string };

export type DiffOp =
  | { kind: 'kept'; beforeIndex: number; afterIndex: number; block: Block }
  | { kind: 'added'; afterIndex: number; block: Block }
  | { kind: 'deleted'; beforeIndex: number; block: Block }
  | { kind: 'moved'; from: number; to: number; block: Block }
  | {
      kind: 'reworded';
      beforeIndex: number;
      afterIndex: number;
      before: Block;
      after: Block;
      score: number;
      wordDiff: WordOp[];
    };

// ============================ Link graph types ============================
// Mirrors `src-tauri/src/link_graph.rs` with one principled difference:
// offsets are UTF-16 code units (what JS strings, CodeMirror, and DOM
// selections all natively use), not bytes. The renderer feeds these
// straight to the editor for cursor positioning; rename-with-references
// uses them to slice + rewrite source bodies. Surrogate pairs are
// vanishingly rare in prose; if they ever show up, code-unit semantics
// match what every other layer expects.

export type LinkKind =
  | 'inline'
  | 'wiki'
  | 'referenceUse'
  | 'referenceDefinition';

export type LinkTarget =
  | {
      kind: 'relative';
      /** Project-relative, forward-slash separated. */
      path: string;
    }
  | {
      kind: 'wiki';
      /** Inner name, verbatim. Filename resolution happens at lookup. */
      name: string;
    };

export type Edge = {
  target: LinkTarget;
  /** UTF-16 code-unit range in the source body. Meaning depends on
   *  `kind`:
   *   - `inline`: the URL portion inside `[text](url)`.
   *   - `wiki`: the inner name inside `[[Name]]`.
   *   - `referenceUse`: the full `[text][label]` / `[label]` span;
   *     not rewritten on rename (it references the label, not the path).
   *   - `referenceDefinition`: the target URL inside `[label]: target`.
   */
  range: { start: number; end: number };
  /** 0-indexed line number. */
  line: number;
  /** 0-indexed UTF-16 column in `line`. */
  column: number;
  kind: LinkKind;
};

export type Backlink = {
  /** The file that links to the active target. */
  source: string;
  range: { start: number; end: number };
  line: number;
  column: number;
  kind: LinkKind;
  /** Source-file line containing the link, trimmed for display. */
  snippet: string;
};

export type OutgoingLink = {
  /** Project-relative target path, or the wiki name. */
  target: string;
  targetKind: 'relative' | 'wiki';
  range: { start: number; end: number };
  line: number;
  column: number;
  kind: LinkKind;
  /** Whether the relative target resolves to a file in the project.
   *  Always `true` for wiki edges (resolution happens at lookup). */
  resolved: boolean;
};

export type DeadLink = {
  source: string;
  /** Resolved relative target that doesn't correspond to any project file. */
  target: string;
  range: { start: number; end: number };
  line: number;
  column: number;
  kind: LinkKind;
};

/** One reference that would be rewritten by a rename. UI-facing
 *  shape — `line` / `column` are 1-indexed for display. */
export type Reference = {
  path: string;
  line: number;
  column: number;
  snippet: string;
  kind: LinkKind;
};

export type RenamePreview = {
  /** True when the target path already exists (in the graph or on
   *  disk) — the UI uses this to disable the commit. */
  targetExists: boolean;
  /** Cross-file references to the renamed file. */
  references: Reference[];
  /** Self-references (the renamed file's own outgoing edges that
   *  point at itself). Phase 3.1 split these from `references` so
   *  the UI could group them under the renamed file. */
  definitionUpdates: Reference[];
};

export type RenameReport = {
  /** Source files whose bodies were rewritten. */
  filesWritten: string[];
  /** Total references rewritten across all files. */
  referencesUpdated: number;
};

// ============================ The IPC surface ============================

export interface SkriveIpc {
  app: {
    version(): Promise<string>;
    platform(): Promise<SkrivePlatform>;
  };
  links: {
    /**
     * Open an external URL in the OS default handler.
     * Used by the Preview pane when the user clicks an http:// / mailto: link.
     */
    openExternal(url: string): Promise<void>;
  };
  project: {
    /**
     * Show a folder-picker dialog. Returns the chosen path, or null if
     * the user cancelled.
     */
    openDialog(): Promise<string | null>;
    /**
     * Scan a directory recursively, returning a manifest of every
     * markdown file found. Skips a hardcoded set of noise directories
     * (node_modules, target, dist, build, __pycache__, venv, .git, .svelte-kit).
     */
    open(path: string): Promise<ProjectManifest>;
    /**
     * Start watching the project root for changes. Subsequent calls
     * replace the previous watcher.
     */
    watch(path: string): Promise<void>;
    /**
     * Stop the active watcher, if any. Safe to call when nothing is watching.
     */
    unwatch(): Promise<void>;
    /**
     * Subscribe to watcher events. Returns an unsubscribe function.
     */
    onChange(handler: (event: ProjectChange) => void): () => void;
  };
  fs: {
    /** Read a project-relative file. Path is resolved against the active project root. */
    readFile(projectRoot: string, relPath: string): Promise<FileContent>;
    /** Write a project-relative file. Creates parents as needed. */
    writeFile(projectRoot: string, relPath: string, content: string): Promise<void>;
    /**
     * Create a new empty markdown file at the given relative path. Fails
     * if a file already exists at that path.
     */
    newFile(projectRoot: string, relPath: string): Promise<void>;
    /** Create a new directory (no-op if it already exists). */
    mkdir(projectRoot: string, relPath: string): Promise<void>;
    /** Move (or rename) a path. Both args are project-relative. */
    rename(
      projectRoot: string,
      oldRelPath: string,
      newRelPath: string
    ): Promise<void>;
    /**
     * Move a path to the OS trash. Reversible from the user's
     * perspective via Finder/Explorer.
     */
    trash(projectRoot: string, relPath: string): Promise<void>;
  };
  diff: {
    /**
     * Structural diff (Phase 3.3b). Block-hash matching with 2-opt
     * assignment; emits Kept/Added/Deleted/Moved/Reworded ops. Pure
     * computation in the main process via @skrive/diff.
     */
    computeDiff(before: string, after: string): Promise<DiffOp[]>;
    /**
     * Line-level side-by-side rows. The baseline that drives raw-mode
     * rendering and feeds the preview-segment coalescer.
     */
    computeLineDiff(before: string, after: string): Promise<LineDiffRow[]>;
  };
  linkGraph: {
    /** Sources that link to `target` (project-relative path). Wiki
     *  edges aren't included — the backward index is keyed on resolved
     *  relative paths only. */
    getBacklinks(target: string): Promise<Backlink[]>;
    /** Outgoing edges from `source`. Carries a `resolved` flag the UI
     *  uses to surface dead links inline. */
    getOutgoing(source: string): Promise<OutgoingLink[]>;
    /** Every relative-target edge in the project whose target doesn't
     *  resolve to a file in the current manifest. */
    getDeadLinks(): Promise<DeadLink[]>;
    /** Project-relative paths of every file with zero inbound edges.
     *  Drives the `orphaned_files` lint rule (Phase 8). Sorted
     *  alphabetically. */
    getOrphanedFiles(): Promise<string[]>;
    /** Read-only preview of a rename: which files have references to
     *  `oldPath` and would be rewritten if it became `newPath`. */
    previewRename(oldPath: string, newPath: string): Promise<RenamePreview>;
    /** Commit a rename. Renames the file, rewrites every reference,
     *  refreshes the in-memory graph. The renderer's chrome refreshes
     *  the manifest from the watcher event afterwards. */
    renameWithReferences(
      oldPath: string,
      newPath: string
    ): Promise<RenameReport>;
  };
  persistence: {
    /** Load `{userData}/app.json`. Returns defaults on missing /
     *  unparseable / unknown-future-version files (with a console
     *  warning in the latter case). */
    loadAppState(): Promise<AppUiState>;
    /** Atomic write of `{userData}/app.json`. */
    saveAppState(state: AppUiState): Promise<void>;
    /** Load `{userData}/projects/{hash}.json` for the given canonical
     *  project root path. Null when the file doesn't exist (first time
     *  this project is opened). */
    loadProjectState(projectRoot: string): Promise<ProjectUiState | null>;
    /** Atomic write of `{userData}/projects/{hash}.json`. Creates the
     *  `projects/` directory on first call. */
    saveProjectState(
      projectRoot: string,
      state: ProjectUiState
    ): Promise<void>;
    /** Open the userData directory in the OS file browser ("Reveal
     *  preferences" in Settings → About). */
    revealUserData(): Promise<void>;
  };
}
