// History IPC: unified read for git + checkpoint backends, plus the
// manual-checkpoint writer. Auto-checkpoint writes are triggered from
// fs:writeFile (see ../ipc/fs.ts) — the user-facing "save" flow stays
// a single round-trip; the auto-checkpoint is a side effect.

import { app, ipcMain } from 'electron';
import type { HistoryEntry, HistoryMode } from '@skrive/shared';
import { projectState } from '../state/project-state';
import {
  createManualCheckpoint,
  listCheckpointsForFile,
  readCheckpointAt
} from '../lib/checkpoint';
import { listGitCommitsForFile, readGitBlobAt } from '../lib/git-history';

export function registerHistoryHandlers(): void {
  ipcMain.handle('history:getMode', async (): Promise<HistoryMode> => {
    return projectState.historyMode;
  });

  ipcMain.handle(
    'history:setGitHistoryEnabled',
    async (_event, enabled: boolean): Promise<HistoryMode> => {
      projectState.gitHistoryEnabled = enabled === true;
      // historyMode is computed from gitDetected && gitHistoryEnabled, so
      // returning it here hands the renderer the now-effective backend.
      return projectState.historyMode;
    }
  );

  ipcMain.handle(
    'history:listForFile',
    async (_event, relPath: string): Promise<HistoryEntry[]> => {
      const root = projectState.root;
      if (!root || typeof relPath !== 'string' || relPath.length === 0) {
        return [];
      }
      if (projectState.historyMode === 'git') {
        const versions = await listGitCommitsForFile(root, relPath);
        return versions.map((v) => ({ source: 'git', ...v }));
      }
      const versions = await listCheckpointsForFile(
        app.getPath('userData'),
        root,
        relPath
      );
      return versions.map((v) => ({ source: 'checkpoint', ...v }));
    }
  );

  ipcMain.handle(
    'history:readGitBlobAt',
    async (_event, relPath: string, sha: string): Promise<string> => {
      const root = projectState.root;
      if (!root) throw new Error('No project is open');
      return readGitBlobAt(root, relPath, sha);
    }
  );

  ipcMain.handle(
    'history:readCheckpointAt',
    async (_event, relPath: string, id: string): Promise<string> => {
      const root = projectState.root;
      if (!root) throw new Error('No project is open');
      return readCheckpointAt(app.getPath('userData'), root, relPath, id);
    }
  );

  ipcMain.handle(
    'history:createManualCheckpoint',
    async (
      _event,
      relPath: string,
      name: string,
      content: string
    ): Promise<void> => {
      const root = projectState.root;
      if (!root) throw new Error('No project is open');
      if (projectState.historyMode !== 'checkpoint') {
        // Git-mode projects use git for pinning (commit + tag).
        // The renderer should hide the action; if it slips through
        // we no-op rather than throw.
        return;
      }
      await createManualCheckpoint(
        app.getPath('userData'),
        root,
        relPath,
        name,
        content,
        projectState.checkpointsConfig.manualCap
      );
    }
  );
}
