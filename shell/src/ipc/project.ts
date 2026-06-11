// Project IPC: folder picker, recursive scan, filesystem watcher.
//
// Phase 7 scope: scan emits a manifest with parsed frontmatter per file
// plus a project-wide schema (presence + types + known-values per field)
// for the renderer's frontmatter-panel autocomplete.
//
// Watcher: a single chokidar instance per renderer. Re-entering `watch`
// closes the previous watcher first. Events are forwarded to the
// renderer as `project:change` event envelopes via the dispatcher's
// event sink.

import { BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  inferSchema,
  parseFrontmatter,
  type FileEntry,
  type ProjectChange,
  type ProjectManifest
} from '@skrive/shared';
import { projectState } from '../state/project-state';
import { parseSkriveToml } from '@skrive/shared';
import {
  MARKDOWN_EXT,
  NOISE_DIRS,
  scanSnapshot,
  toForwardSlash,
  walk
} from '../lib/snapshot';
import { IpcError, emitEvent, registerCommand } from '../main/dispatch';

let activeWatcher: FSWatcher | null = null;

async function readSkriveToml(root: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(root, '.skrive.toml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function detectGitRepo(root: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(root, '.git'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Build the manifest FileEntry for a single project-relative markdown
// file by reading it from disk. The single source of truth for a
// FileEntry's shape: scanProject's full walk and the watcher's
// incremental patch both go through here, so the two paths can never
// diverge. Returns null if the file vanished (stat failed) — the caller
// drops it rather than synthesizing an entry. A file that stats but
// can't be read (rare) still gets an entry with empty frontmatter, the
// same lenient behavior the original full scan had. The body is returned
// alongside the entry so callers can populate the link graph from the
// same read (null when the read failed but the stat succeeded).
export async function buildFileEntry(
  root: string,
  relPath: string
): Promise<{ entry: FileEntry; body: string | null } | null> {
  const fullPath = path.join(root, relPath);

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return null;
  }

  let body: string | null = null;
  try {
    body = await fs.readFile(fullPath, 'utf8');
  } catch {
    // Stat succeeded but the read didn't — keep the entry, no frontmatter.
  }

  const fm = body === null ? {} : parseFrontmatter(body).frontmatter;
  const entry: FileEntry = {
    path: relPath,
    name: path.basename(fullPath),
    sizeBytes: stat.size,
    modifiedMs: stat.mtimeMs ?? null,
    frontmatter: fm,
    outgoingLinks: []
  };
  return { entry, body };
}

// Build a FileEntry from disk and hand it to the cached manifest +
// graph patch. Fire-and-forget from the watcher (the renderer debounces
// ~750ms, so the patch lands before any follow-up read). If the file
// vanished between the watcher event and the read, drop it from both
// the manifest and the graph instead.
async function patchManifestFromDisk(relPath: string): Promise<void> {
  const root = projectState.root;
  if (!root) return;
  const built = await buildFileEntry(root, relPath);
  if (built === null) {
    projectState.removeManifestFile(relPath);
    return;
  }
  projectState.patchManifestFile(relPath, built.body ?? '', built.entry);
}

/** Reset per-project shell state for a (re)opened root: link graph,
 *  git detection, and the checkpoint caps from `.skrive.toml`. Both
 *  the legacy full scan and `project:snapshot` go through here, so the
 *  fs/history handlers see primed state regardless of which open path
 *  the renderer uses. */
async function primeProjectState(
  canonicalRoot: string
): Promise<{ config: ReturnType<typeof parseSkriveToml>['config']; warnings: string[] }> {
  projectState.reset(canonicalRoot);
  projectState.gitDetected = await detectGitRepo(canonicalRoot);

  // `.skrive.toml` lives at the project root; absent -> defaults.
  const tomlSource = await readSkriveToml(canonicalRoot);
  const { config, warnings } = parseSkriveToml(tomlSource);
  projectState.checkpointsConfig = config.checkpoints;
  return { config, warnings };
}

export async function scanProject(root: string): Promise<ProjectManifest> {
  const canonicalRoot = path.resolve(root);
  const files: FileEntry[] = [];

  // Reset link-graph state for the new project. Files get added to
  // the graph as we walk, with their edges extracted from disk.
  const { config, warnings } = await primeProjectState(canonicalRoot);

  for await (const { fullPath, isMarkdown } of walk(
    canonicalRoot,
    canonicalRoot
  )) {
    const rel = toForwardSlash(path.relative(canonicalRoot, fullPath));

    if (!isMarkdown) {
      // Track non-markdown files as "exists" so link-target checks
      // don't flag prose-adjacent assets (LICENSE, attachments,
      // images) as broken. They aren't part of the manifest's `files`
      // — the renderer's tab/sidebar surfaces stay markdown-only.
      projectState.addNonMarkdown(rel);
      continue;
    }

    const built = await buildFileEntry(canonicalRoot, rel);
    if (built === null) continue;

    // Feed the graph from the same read buildFileEntry used.
    if (built.body === null) {
      projectState.addEmpty(rel);
    } else {
      projectState.upsertFile(rel, built.body);
    }

    files.push(built.entry);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest: ProjectManifest = {
    root: canonicalRoot,
    files,
    schema: inferSchema(files),
    config,
    warnings
  };
  projectState.setManifest(manifest);
  return manifest;
}

function relPath(root: string, abs: string): string {
  return toForwardSlash(path.relative(root, abs));
}

function startWatcher(
  root: string,
  onChange: (event: ProjectChange) => void
): FSWatcher {
  const watcher = chokidar.watch(root, {
    ignored: (target, stats) => {
      // Reject any segment in NOISE_DIRS; reject hidden directories;
      // accept markdown files, plus `.skrive.toml` at the root so config
      // edits can trigger a rescan (the callback handles it specially and
      // never forwards it to the renderer as a file change).
      const base = path.basename(target);
      if (NOISE_DIRS.has(base)) return true;
      if (base.startsWith('.') && stats?.isDirectory()) return true;
      if (
        stats?.isFile() &&
        !MARKDOWN_EXT.test(base) &&
        path.resolve(target) !== path.resolve(root, '.skrive.toml')
      ) {
        return true;
      }
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    persistent: true
  });

  watcher.on('add', (p) => onChange({ kind: 'add', path: relPath(root, p) }));
  watcher.on('change', (p) =>
    onChange({ kind: 'change', path: relPath(root, p) })
  );
  watcher.on('unlink', (p) =>
    onChange({ kind: 'unlink', path: relPath(root, p) })
  );
  watcher.on('addDir', (p) => {
    if (p === root) return;
    onChange({ kind: 'addDir', path: relPath(root, p) });
  });
  watcher.on('unlinkDir', (p) =>
    onChange({ kind: 'unlinkDir', path: relPath(root, p) })
  );
  watcher.on('ready', () => onChange({ kind: 'ready' }));
  watcher.on('error', (err) => {
    console.error('[skrive watcher]', err);
  });

  return watcher;
}

export function registerProjectHandlers(): void {
  registerCommand('project:openDialog', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open project',
      buttonLabel: 'Open'
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0] ?? null };
  });

  registerCommand('project:snapshot', async (payload) => {
    const root = payload.root;
    if (typeof root !== 'string' || root.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'project:snapshot requires a non-empty root path'
      );
    }
    const canonicalRoot = path.resolve(root);
    await primeProjectState(canonicalRoot);
    const snapshot = await scanSnapshot(canonicalRoot);
    // The shell-side graph still backs the legacy linkGraph commands and
    // the auto-checkpoint path during the 0.4 transition; populate it
    // from the snapshot bodies so a snapshot-opened project behaves
    // identically. Dies with the handlers in the 0.4 deletion step.
    for (const file of snapshot.files) {
      if (file.body === null) {
        projectState.addNonMarkdown(file.path);
      } else if (MARKDOWN_EXT.test(file.path)) {
        projectState.upsertFile(file.path, file.body);
      }
    }
    return snapshot as unknown as Record<string, unknown>;
  });

  registerCommand('project:open', async (payload) => {
    const root = payload.root;
    if (typeof root !== 'string' || root.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'project:open requires a non-empty root path'
      );
    }
    const manifest = await scanProject(root);
    return manifest as unknown as Record<string, unknown>;
  });

  registerCommand('project:getManifest', async () => {
    // O(1): hand back the cached manifest kept fresh by the watcher.
    // No rescan. Null when no project is open / nothing cached yet.
    const manifest = projectState.manifest;
    if (!manifest) return { current: null };
    return { current: { manifest, version: projectState.manifestVersion } };
  });

  registerCommand('project:watch', async (payload) => {
    const root = payload.root;
    if (typeof root !== 'string' || root.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'project:watch requires a non-empty root path'
      );
    }
    if (activeWatcher) {
      await activeWatcher.close();
      activeWatcher = null;
    }
    activeWatcher = startWatcher(root, (e) => {
      // A `.skrive.toml` edit changes config (and therefore lint
      // behavior) without being a markdown file change. It's rare, so the
      // simplest correct response is a full rescan — that re-reads the
      // toml, rebuilds the manifest, and bumps the version. We don't
      // forward it to the renderer as a file change: it isn't one.
      if (
        (e.kind === 'add' || e.kind === 'change' || e.kind === 'unlink') &&
        e.path === '.skrive.toml' &&
        projectState.root
      ) {
        void scanProject(projectState.root);
        return;
      }

      // Keep the link graph AND the cached manifest in sync with disk
      // before the renderer hears about the change — that way the
      // renderer's follow-up backlinks query and getManifest read both
      // see up-to-date state. patchManifestFile handles both the graph
      // upsert and the manifest patch so they can't drift apart.
      if (e.kind === 'add' || e.kind === 'change') {
        void patchManifestFromDisk(e.path);
      } else if (e.kind === 'unlink') {
        projectState.removeManifestFile(e.path);
      }

      emitEvent('project:change', e);
    });
    return {};
  });

  registerCommand('project:unwatch', async () => {
    if (activeWatcher) {
      await activeWatcher.close();
      activeWatcher = null;
    }
    return {};
  });

  registerCommand('project:create', async (payload) => {
    const parent = payload.parent;
    if (typeof parent !== 'string' || parent.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'project:create requires a parent directory'
      );
    }
    const trimmed = (typeof payload.name === 'string' ? payload.name : '').trim();
    if (trimmed.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'project:create requires a non-empty name'
      );
    }
    // Reject path separators in the name — the user picked a parent;
    // they shouldn't be able to nest the new project arbitrarily.
    if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'Project name cannot contain path separators'
      );
    }
    const target = path.resolve(parent, trimmed);
    try {
      await fs.mkdir(target, { recursive: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new IpcError(
          'ALREADY_EXISTS',
          `A directory already exists at ${target}`
        );
      }
      throw err;
    }
    // Starter README so the project has at least one file the
    // sidebar / linter / search has something to chew on.
    const readme = `# ${trimmed}\n\nWritten with Skrive.\n`;
    await fs.writeFile(path.join(target, 'README.md'), readme, 'utf8');
    if (payload.gitInit === true) {
      await new Promise<void>((resolve) => {
        const child = spawn('git', ['init', '--quiet'], {
          cwd: target,
          windowsHide: true
        });
        child.on('error', () => resolve()); // git missing -> ignore
        child.on('close', () => resolve());
      });
    }
    return { path: target };
  });
}
