// Filesystem commands: read, write, create, rename, trash.
//
// Every operation takes `{ projectRoot, relPath }` in its payload. The
// shell joins them and *also* verifies the resolved path is inside the
// project root before touching the filesystem. This is the only place
// disk operations cross the IPC boundary, so containment lives here.

import { app, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectState } from '../state/project-state';
import { maybeWriteAutoCheckpoint } from '../lib/checkpoint';
import { atomicWriteFile, contentHash, detectExternalChange } from '../lib/atomic-write';
import { IpcError, registerCommand } from '../main/dispatch';

const MARKDOWN_EXT = /\.(md|markdown)$/i;

function toForwardSlash(p: string): string {
  return p.split(path.sep).join('/');
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new IpcError('INVALID_PAYLOAD', `${field} must be a string`);
  }
  return value;
}

function resolveSafe(projectRoot: string, relPath: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relPath);
  // Must stay inside the project root. `path.relative(root, target)`
  // returns "../..." or absolute when escaping.
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new IpcError('PATH_ESCAPE', `Path escapes project root: ${relPath}`);
  }
  return target;
}

/** Pull the `{ projectRoot, relPath }` pair every fs command carries and
 *  resolve it safely. */
function resolveFromPayload(payload: Record<string, unknown>): {
  relPath: string;
  target: string;
} {
  const projectRoot = requireString(payload, 'projectRoot');
  const relPath = requireString(payload, 'relPath');
  return { relPath, target: resolveSafe(projectRoot, relPath) };
}

export function registerFsHandlers(): void {
  registerCommand('fs:readFile', async (payload) => {
    const { relPath, target } = resolveFromPayload(payload);
    const [body, stat] = await Promise.all([
      fs.readFile(target, 'utf8'),
      fs.stat(target)
    ]);
    return {
      path: relPath,
      body,
      modifiedMs: stat.mtimeMs ?? null,
      hash: contentHash(body)
    };
  });

  registerCommand('fs:detectExternalChange', async (payload) => {
    const { target } = resolveFromPayload(payload);
    const knownHash = requireString(payload, 'knownHash');
    return { changed: await detectExternalChange(target, knownHash) };
  });

  registerCommand('fs:writeFile', async (payload) => {
    const { relPath, target } = resolveFromPayload(payload);
    const content = requireString(payload, 'content');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteFile(target, content);
    // Phase 10. In checkpoint history mode, every successful save is
    // a candidate for an auto-checkpoint. The writer enforces its own
    // 5-min interval + content-hash dedup, so calling it on every
    // save is cheap when the user is editing fast. Best-effort:
    // checkpoint failures don't propagate.
    if (
      MARKDOWN_EXT.test(relPath) &&
      projectState.historyMode === 'checkpoint' &&
      projectState.root
    ) {
      await maybeWriteAutoCheckpoint(
        app.getPath('userData'),
        projectState.root,
        toForwardSlash(relPath),
        content,
        projectState.checkpointsConfig.autoCap
      );
    }
    return { hash: contentHash(content) };
  });

  registerCommand('fs:writeBinaryFile', async (payload) => {
    const { target } = resolveFromPayload(payload);
    const base64 = requireString(payload, 'base64');
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Binary assets (pasted images) are not markdown, so they bypass the
    // link-graph and checkpoint bookkeeping that fs:writeFile performs.
    await fs.writeFile(target, Buffer.from(base64, 'base64'));
    return {};
  });

  registerCommand('fs:newFile', async (payload) => {
    const { relPath, target } = resolveFromPayload(payload);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // wx flag = exclusive create. Errors if the file exists.
    let handle;
    try {
      handle = await fs.open(target, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new IpcError(
          'ALREADY_EXISTS',
          `A file already exists at ${relPath}`
        );
      }
      throw err;
    }
    await handle.close();
    return {};
  });

  registerCommand('fs:mkdir', async (payload) => {
    const { target } = resolveFromPayload(payload);
    await fs.mkdir(target, { recursive: true });
    return {};
  });

  registerCommand('fs:rename', async (payload) => {
    const projectRoot = requireString(payload, 'projectRoot');
    const oldRelPath = requireString(payload, 'oldRelPath');
    const newRelPath = requireString(payload, 'newRelPath');
    const oldTarget = resolveSafe(projectRoot, oldRelPath);
    const newTarget = resolveSafe(projectRoot, newRelPath);
    await fs.mkdir(path.dirname(newTarget), { recursive: true });
    await fs.rename(oldTarget, newTarget);
    return {};
  });

  registerCommand('fs:trash', async (payload) => {
    const { relPath, target } = resolveFromPayload(payload);
    await shell.trashItem(target);
    return {};
  });
}
