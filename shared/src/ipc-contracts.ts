/**
 * The typed surface exposed by `shell/preload.ts` to `app/`.
 * Both sides import this; tsc catches drift.
 *
 * Surfaces grow per migration phase. Phase 1 = `app`. Phase 2 = `links`.
 * Phase 3 = `project` + `fs` + watcher subscriptions.
 */

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
  /**
   * Empty in Phase 3. Phase 7 wires frontmatter parsing into the project
   * scan; Phase 6 wires outgoing-link extraction.
   */
  frontmatter: Record<string, unknown>;
  outgoingLinks: string[];
};

export type ProjectManifest = {
  /** Canonical absolute path of the project root. */
  root: string;
  files: FileEntry[];
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

export type RenamePreview = {
  /** Total edges that would be rewritten across all sources. */
  edgeCount: number;
  /** Per-source breakdown of edges to rewrite. */
  sources: Array<{
    source: string;
    edges: Array<{
      range: { start: number; end: number };
      line: number;
      column: number;
      kind: LinkKind;
    }>;
  }>;
};

export type RenameReport = {
  /** Final relative path of the renamed file. */
  newPath: string;
  /** Sources whose bodies were rewritten. */
  rewrittenSources: string[];
  /** Total edges rewritten. */
  edgeCount: number;
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
  };
}
