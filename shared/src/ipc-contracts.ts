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
}
