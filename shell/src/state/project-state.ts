// Singleton state for the active project. Holds the link graph and the
// canonical set of project-relative .md paths so backlinks / outgoing /
// dead-links queries don't repeatedly walk the disk. Mutated by:
//
//   - project:open  → bulk populate (reads every .md from disk)
//   - fs:writeFile  → re-extract from the in-memory body and update
//   - fs:newFile    → add empty body's edges (none) + path
//   - fs:rename     → drop old path, re-extract under new path
//   - fs:trash      → drop path
//   - watcher add/change → re-extract from disk
//   - watcher unlink     → drop path
//
// The double-update on save (shell-side fs:writeFile + watcher 'change')
// is idempotent: the second extract produces the same edges. No
// debouncing needed at this layer.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CHECKPOINTS_CONFIG,
  inferSchema,
  type CheckpointsConfig,
  type FileEntry,
  type FrontmatterMap,
  type HistoryMode,
  type ProjectManifest
} from '@skrive/shared';
import { extract } from '../lib/link-graph/extract';
import { LinkGraph } from '../lib/link-graph/graph';

/** Structural equality for parsed frontmatter maps. Both sides are
 *  YAML-derived (so JSON-shaped: objects, arrays, scalars, null), which
 *  lets us recurse without worrying about functions / symbols / Dates.
 *  Used to decide whether a content-only edit (body changed, frontmatter
 *  identical) should bump the manifest version — it must not. */
function frontmatterEqual(a: FrontmatterMap, b: FrontmatterMap): boolean {
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
    );
  }
  return false;
}

/** Binary-search insertion index keeping `files` sorted by `path`. */
function sortedInsertIndex(files: FileEntry[], relPath: string): number {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid]!.path.localeCompare(relPath) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class ProjectState {
  root: string | null = null;
  linkGraph = new LinkGraph();
  /** Markdown files in the project. These have entries in the link
   *  graph; orphan detection runs against this set. */
  filePaths = new Set<string>();
  /** Non-markdown files in the project (LICENSE, attachments, images,
   *  etc.). Tracked purely so link-target existence checks consider
   *  them present — they aren't markdown sources, so they have no
   *  graph entry and can't be "orphaned." */
  nonMarkdownPaths = new Set<string>();
  /** Phase 10. Whether a `.git/` directory sits at the project root.
   *  Decided at project:open and stable for the session — the raw
   *  capability, independent of the user's preference. */
  gitDetected = false;
  /** Global user preference (mirrors AppUiState.gitHistoryEnabled). The
   *  renderer pushes the stored value through `history:setGitHistoryEnabled`
   *  at project open and on every toggle. Survives project switches —
   *  `reset()` deliberately leaves it untouched. */
  gitHistoryEnabled = true;
  /** Retention caps from `[checkpoints]` in `.skrive.toml`. Only
   *  meaningful in checkpoint mode; threaded through to the writer so
   *  the cap moves when the user retunes the config. */
  checkpointsConfig: CheckpointsConfig = { ...DEFAULT_CHECKPOINTS_CONFIG };
  /** Cached manifest from the last full scan, kept incrementally fresh by
   *  the watcher. The renderer reads it via `project:getManifest` instead
   *  of re-running a full scan on every file change. Null until a project
   *  is opened. */
  manifest: ProjectManifest | null = null;
  /** Monotonic counter the renderer/worker compare against their own
   *  last-seen value to decide whether to re-ship the manifest. Bumped
   *  ONLY on lint/structure-relevant changes: the set of markdown paths
   *  changing, or an existing file's frontmatter changing. Never bumped on
   *  a content-only edit. Never reset — a project switch just keeps
   *  counting up, which is enough since the renderer compares to its own
   *  prior value. */
  manifestVersion = 0;

  /** Effective history backend for the open project. Git only when the
   *  repo is present AND the user hasn't disabled git history; otherwise
   *  Skrive's own checkpoint store. Every consumer (the history IPC, the
   *  auto-checkpoint-on-write in fs:writeFile) reads through here, so the
   *  preference takes effect everywhere without per-caller branching. */
  get historyMode(): HistoryMode {
    return this.gitDetected && this.gitHistoryEnabled ? 'git' : 'checkpoint';
  }

  reset(root: string | null): void {
    this.root = root;
    this.linkGraph = new LinkGraph();
    this.filePaths = new Set();
    this.nonMarkdownPaths = new Set();
    // gitHistoryEnabled is a global preference — preserved across project
    // switches. Only the per-project capability resets here.
    this.gitDetected = false;
    this.checkpointsConfig = { ...DEFAULT_CHECKPOINTS_CONFIG };
    // Drop the cached manifest; scanProject rebuilds it and bumps the
    // version so the renderer sees a fresh value after a project switch.
    this.manifest = null;
  }

  /** Add a file to the canonical path set and re-extract its edges. */
  upsertFile(relPath: string, body: string): void {
    this.filePaths.add(relPath);
    this.linkGraph.setLinks(relPath, extract(body, relPath));
  }

  /** Add a file path with no edges (empty body / first create). */
  addEmpty(relPath: string): void {
    this.filePaths.add(relPath);
    this.linkGraph.setLinks(relPath, []);
  }

  /** Register a non-markdown file as present. Used by the project
   *  scan so links to LICENSE / attachments / images don't surface
   *  as dead. */
  addNonMarkdown(relPath: string): void {
    this.nonMarkdownPaths.add(relPath);
  }

  /** Drop a file from the path set and the graph. */
  removeFile(relPath: string): void {
    this.filePaths.delete(relPath);
    this.nonMarkdownPaths.delete(relPath);
    this.linkGraph.forget(relPath);
  }

  /** Read a file from disk and refresh its edges in the graph. Used on
   *  watcher events where the body isn't already in hand. */
  async refreshFromDisk(relPath: string): Promise<void> {
    if (!this.root) return;
    try {
      const body = await fsp.readFile(
        path.join(this.root, relPath),
        'utf8'
      );
      this.upsertFile(relPath, body);
    } catch {
      // Vanished between event + read — drop instead.
      this.removeFile(relPath);
    }
  }

  hasFile(relPath: string): boolean {
    return (
      this.filePaths.has(relPath) || this.nonMarkdownPaths.has(relPath)
    );
  }

  /** Install the manifest produced by a full scan and bump the version so
   *  the renderer's first post-open read differs from any default it
   *  holds. The link graph is populated separately during the scan. */
  setManifest(manifest: ProjectManifest): void {
    this.manifest = manifest;
    this.manifestVersion++;
  }

  /** Incrementally patch the cached manifest + link graph for a single
   *  markdown file the watcher saw added or changed. `body` updates the
   *  graph edges; `entry` (already built from disk by the caller) is
   *  inserted in sorted position if new, or replaced in place. The version
   *  bumps only when this is a new path OR the file's frontmatter changed
   *  versus the prior entry — a content-only edit leaves it untouched.
   *  Schema is re-inferred whenever a version-relevant change lands. */
  patchManifestFile(relPath: string, body: string, entry: FileEntry): void {
    // Keep the graph in lockstep with the manifest patch.
    this.upsertFile(relPath, body);

    const manifest = this.manifest;
    if (!manifest) return;

    const existingIndex = manifest.files.findIndex((f) => f.path === relPath);
    if (existingIndex === -1) {
      manifest.files.splice(sortedInsertIndex(manifest.files, relPath), 0, entry);
      manifest.schema = inferSchema(manifest.files);
      this.manifestVersion++;
      return;
    }

    const prior = manifest.files[existingIndex]!;
    const frontmatterChanged = !frontmatterEqual(
      prior.frontmatter,
      entry.frontmatter
    );
    manifest.files[existingIndex] = entry;
    if (frontmatterChanged) {
      manifest.schema = inferSchema(manifest.files);
      this.manifestVersion++;
    }
  }

  /** Remove a markdown file from the cached manifest + link graph after an
   *  unlink. Bumps the version (the set of paths changed) and re-infers
   *  schema when an entry was actually removed. No-op for paths that were
   *  never in the manifest (non-markdown, or already gone). */
  removeManifestFile(relPath: string): void {
    // Forget from the graph regardless of manifest membership.
    this.removeFile(relPath);

    const manifest = this.manifest;
    if (!manifest) return;

    const index = manifest.files.findIndex((f) => f.path === relPath);
    if (index === -1) return;

    manifest.files.splice(index, 1);
    manifest.schema = inferSchema(manifest.files);
    this.manifestVersion++;
  }
}

export const projectState = new ProjectState();
