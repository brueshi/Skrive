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
    }
  );

  ipcMain.handle(
    'fs:trash',
    async (_event, projectRoot: string, relPath: string): Promise<void> => {
      const target = resolveSafe(projectRoot, relPath);
      await shell.trashItem(target);
    }
  );
}
