// Persistence commands for the Phase 9 persistence layer. The main
// process is the only place we touch `node:fs` for state files — the
// renderer goes through `window.skrive.persistence.*`.

import { app, shell } from 'electron';
import type { AppUiState, ProjectUiState } from '@skrive/shared';
import {
  loadAppState,
  loadProjectState,
  saveAppState,
  saveProjectState
} from '../lib/persistence';
import { IpcError, registerCommand } from '../main/dispatch';

export function registerPersistenceHandlers(): void {
  registerCommand('persistence:loadAppState', async () => {
    const state = await loadAppState(app.getPath('userData'));
    return state as unknown as Record<string, unknown>;
  });

  registerCommand('persistence:saveAppState', async (payload) => {
    await saveAppState(app.getPath('userData'), payload.state as AppUiState);
    return {};
  });

  registerCommand('persistence:loadProjectState', async (payload) => {
    const projectRoot = payload.projectRoot;
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return { state: null };
    }
    return {
      state: await loadProjectState(app.getPath('userData'), projectRoot)
    };
  });

  registerCommand('persistence:saveProjectState', async (payload) => {
    const projectRoot = payload.projectRoot;
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'persistence:saveProjectState requires a non-empty project root'
      );
    }
    await saveProjectState(
      app.getPath('userData'),
      projectRoot,
      payload.state as ProjectUiState
    );
    return {};
  });

  registerCommand('persistence:revealUserData', async () => {
    await shell.openPath(app.getPath('userData'));
    return {};
  });
}
