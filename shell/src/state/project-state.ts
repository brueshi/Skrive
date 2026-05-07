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
import { extract } from '../lib/link-graph/extract';
import { LinkGraph } from '../lib/link-graph/graph';

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

  reset(root: string | null): void {
    this.root = root;
    this.linkGraph = new LinkGraph();
    this.filePaths = new Set();
    this.nonMarkdownPaths = new Set();
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
}

export const projectState = new ProjectState();
