// IPC handlers for the Phase 9 persistence layer. The main process is
// the only place we touch `node:fs` for state files — the renderer
// goes through `window.skrive.persistence.*`.

import { app, ipcMain, shell } from 'electron';
import type { AppUiState, ProjectUiState } from '@skrive/shared';
import {
  loadAppState,
  loadProjectState,
  saveAppState,
  saveProjectState
} from '../lib/persistence';

export function registerPersistenceHandlers(): void {
  ipcMain.handle('appState:load', async (): Promise<AppUiState> => {
    return loadAppState(app.getPath('userData'));
  });

  ipcMain.handle(
    'appState:save',
    async (_event, state: AppUiState): Promise<void> => {
      await saveAppState(app.getPath('userData'), state);
    }
  );

  ipcMain.handle(
    'projectState:load',
    async (_event, projectRoot: string): Promise<ProjectUiState | null> => {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
        return null;
      }
      return loadProjectState(app.getPath('userData'), projectRoot);
    }
  );

  ipcMain.handle(
    'projectState:save',
    async (
      _event,
      projectRoot: string,
      state: ProjectUiState
    ): Promise<void> => {
      if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
        throw new Error('projectState:save requires a non-empty project root');
      }
      await saveProjectState(app.getPath('userData'), projectRoot, state);
    }
  );

  ipcMain.handle('appState:revealUserData', async (): Promise<void> => {
    await shell.openPath(app.getPath('userData'));
  });
}
