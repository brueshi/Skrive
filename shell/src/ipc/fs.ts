// Filesystem IPC: read, write, create, rename, trash.
//
// Every operation takes `(projectRoot, relPath)` as the input pair. The
// shell joins them and *also* verifies the resolved path is inside the
// project root before touching the filesystem. This is the only place
// disk operations cross the IPC boundary, so containment lives here.

import { ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileContent } from '@skrive/shared';
import { projectState } from '../state/project-state';

const MARKDOWN_EXT = /\.(md|markdown)$/i;

function toForwardSlash(p: string): string {
  return p.split(path.sep).join('/');
}

function resolveSafe(projectRoot: string, relPath: string): string {
  if (typeof projectRoot !== 'string' || typeof relPath !== 'string') {
    throw new Error('fs ops require string projectRoot + relPath');
  }
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relPath);
  // Must stay inside the project root. `path.relative(root, target)`
  // returns "../..." or absolute when escaping.
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${relPath}`);
  }
  return target;
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    'fs:readFile',
    async (_event, projectRoot: string, relPath: string): Promise<FileContent> => {
      const target = resolveSafe(projectRoot, relPath);
      const [body, stat] = await Promise.all([
        fs.readFile(target, 'utf8'),
        fs.stat(target)
      ]);
      return {
        path: relPath,
        body,
        modifiedMs: stat.mtimeMs ?? null
      };
    }
  );

  ipcMain.handle(
    'fs:writeFile',
    async (
      _event,
      projectRoot: string,
      relPath: string,
      content: string
    ): Promise<void> => {
      if (typeof content !== 'string') {
        throw new Error('fs:writeFile requires string content');
      }
      const target = resolveSafe(projectRoot, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      // Update link graph from the body we just persisted. Cheaper
      // than the watcher's disk-read path, and the renderer's
      // immediate follow-up backlinks query sees the new state
      // without waiting for awaitWriteFinish.
      if (MARKDOWN_EXT.test(relPath)) {
        projectState.upsertFile(toForwardSlash(relPath), content);
      }
    }
  );

  ipcMain.handle(
    'fs:newFile',
    async (_event, projectRoot: string, relPath: string): Promise<void> => {
      const target = resolveSafe(projectRoot, relPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // wx flag = exclusive create. Errors if the file exists.
      const handle = await fs.open(target, 'wx');
      await handle.close();
      if (MARKDOWN_EXT.test(relPath)) {
        projectState.addEmpty(toForwardSlash(relPath));
      }
    }
  );

  ipcMain.handle(
    'fs:mkdir',
    async (_event, projectRoot: string, relPath: string): Promise<void> => {
      const target = resolveSafe(projectRoot, relPath);
      await fs.mkdir(target, { recursive: true });
    }
  );

  ipcMain.handle(
    'fs:rename',
    async (
      _event,
      projectRoot: string,
      oldRelPath: string,
      newRelPath: string
    ): Promise<void> => {
      const oldTarget = resolveSafe(projectRoot, oldRelPath);
      const newTarget = resolveSafe(projectRoot, newRelPath);
      await fs.mkdir(path.dirname(newTarget), { recursive: true });
      await fs.rename(oldTarget, newTarget);
      // Drop the old path from the graph; re-extract under the new
      // path. Rename-with-references (phase 6c) handles updating the
      // edges that POINT at the renamed file separately.
      if (MARKDOWN_EXT.test(oldRelPath)) {
        projectState.removeFile(toForwardSlash(oldRelPath));
      }
      if (MARKDOWN_EXT.test(newRelPath)) {
        try {
          const body = await fs.readFile(newTarget, 'utf8');
          projectState.upsertFile(toForwardSlash(newRelPath), body);
        } catch {
          projectState.addEmpty(toForwardSlash(newRelPath));
        }
      }
    }
  );

  ipcMain.handle(
    'fs:trash',
    async (_event, projectRoot: string, relPath: string): Promise<void> => {
      const target = resolveSafe(projectRoot, relPath);
      await shell.trashItem(target);
      if (MARKDOWN_EXT.test(relPath)) {
        projectState.removeFile(toForwardSlash(relPath));
      }
    }
  );
}
