// History commands: unified read for git + checkpoint backends, plus the
// manual-checkpoint writer. Auto-checkpoint writes are triggered from
// fs:writeFile (see ../ipc/fs.ts) — the user-facing "save" flow stays
// a single round-trip; the auto-checkpoint is a side effect.

import { app } from 'electron';
import type { HistoryEntry } from '@skrive/shared';
import { projectState } from '../state/project-state';
import {
  createManualCheckpoint,
  listCheckpointsForFile,
  readCheckpointAt
} from '../lib/checkpoint';
import { listGitCommitsForFile, readGitBlobAt } from '../lib/git-history';
import { IpcError, registerCommand } from '../main/dispatch';

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new IpcError('INVALID_PAYLOAD', `${field} must be a string`);
  }
  return value;
}

function requireRoot(): string {
  const root = projectState.root;
  if (!root) throw new IpcError('NO_PROJECT', 'No project is open');
  return root;
}

export function registerHistoryHandlers(): void {
  registerCommand('history:getMode', async () => {
    return { mode: projectState.historyMode };
  });

  registerCommand('history:setGitHistoryEnabled', async (payload) => {
    projectState.gitHistoryEnabled = payload.enabled === true;
    // historyMode is computed from gitDetected && gitHistoryEnabled, so
    // returning it here hands the renderer the now-effective backend.
    return { mode: projectState.historyMode };
  });

  registerCommand('history:listForFile', async (payload) => {
    const root = projectState.root;
    const relPath = payload.relPath;
    if (!root || typeof relPath !== 'string' || relPath.length === 0) {
      return { entries: [] as HistoryEntry[] };
    }
    if (projectState.historyMode === 'git') {
      const versions = await listGitCommitsForFile(root, relPath);
      return { entries: versions.map((v) => ({ source: 'git', ...v })) };
    }
    const versions = await listCheckpointsForFile(
      app.getPath('userData'),
      root,
      relPath
    );
    return { entries: versions.map((v) => ({ source: 'checkpoint', ...v })) };
  });

  registerCommand('history:readGitBlobAt', async (payload) => {
    const root = requireRoot();
    const relPath = requireString(payload, 'relPath');
    const sha = requireString(payload, 'sha');
    return { content: await readGitBlobAt(root, relPath, sha) };
  });

  registerCommand('history:readCheckpointAt', async (payload) => {
    const root = requireRoot();
    const relPath = requireString(payload, 'relPath');
    const id = requireString(payload, 'id');
    return {
      content: await readCheckpointAt(app.getPath('userData'), root, relPath, id)
    };
  });

  registerCommand('history:createManualCheckpoint', async (payload) => {
    const root = requireRoot();
    const relPath = requireString(payload, 'relPath');
    const name = requireString(payload, 'name');
    const content = requireString(payload, 'content');
    if (projectState.historyMode !== 'checkpoint') {
      // Git-mode projects use git for pinning (commit + tag).
      // The renderer should hide the action; if it slips through
      // we no-op rather than throw.
      return {};
    }
    await createManualCheckpoint(
      app.getPath('userData'),
      root,
      relPath,
      name,
      content,
      projectState.checkpointsConfig.manualCap
    );
    return {};
  });
}
