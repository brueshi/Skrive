// Project commands: folder picker, batched snapshot, create, watcher.
// Since Stage 0.4 the renderer's project-model worker derives manifest,
// schema, and link graph from the snapshot — the shell never parses
// Markdown.
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
import { parseSkriveToml, type ProjectChange } from '@skrive/shared';
import { projectState } from '../state/project-state';
import { MARKDOWN_EXT, NOISE_DIRS, scanSnapshot, toForwardSlash } from '../lib/snapshot';
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
    return snapshot as unknown as Record<string, unknown>;
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
      // A `.skrive.toml` edit changes config. The renderer's
      // project-model worker owns config derivation now (Stage 0.4), so
      // the event is forwarded like any other change; the shell only
      // refreshes its own slice — the checkpoint caps the auto-
      // checkpoint writer reads.
      if (
        (e.kind === 'add' || e.kind === 'change' || e.kind === 'unlink') &&
        e.path === '.skrive.toml' &&
        projectState.root
      ) {
        const projectRoot = projectState.root;
        void (async () => {
          try {
            const tomlSource = await readSkriveToml(projectRoot);
            projectState.checkpointsConfig =
              parseSkriveToml(tomlSource).config.checkpoints;
          } catch {
            // Unreadable config: keep the prior caps.
          }
        })();
        emitEvent('project:change', e);
        return;
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
