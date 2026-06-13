// Minimal `electron` stand-in for running the real shell handlers
// outside an Electron runtime (parity-corpus tooling only). It provides
// exactly the surface the fs / project / persistence handlers touch:
// `app.getPath`, `shell.trashItem` / `openPath`, and the windowing/dialog
// symbols those modules import at top even though the corpus never
// exercises the dialog/watch paths. Injected via scripts/parity/preload.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userDataDir: string | null = null;
function userData(): string {
  if (!userDataDir) {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'skrive-parity-userdata-'));
  }
  return userDataDir;
}

export const app = {
  getVersion: () => '0.0.0-parity',
  getPath: (name: string) => (name === 'userData' ? userData() : tmpdir()),
  isPackaged: false,
  getName: () => 'Skrive',
  dock: undefined as undefined,
  whenReady: async () => {},
  on: () => {},
  quit: () => {}
};

export const shell = {
  trashItem: async (target: string) => {
    rmSync(target, { recursive: true, force: true });
  },
  openPath: async () => '',
  openExternal: async () => {}
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] })
};

export const BrowserWindow = {
  getAllWindows: () => [] as unknown[],
  getFocusedWindow: () => null,
  fromWebContents: () => null
};

export const clipboard = {
  write: () => {},
  writeText: () => {},
  readText: () => ''
};

export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {}
};

export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
export const ipcMain = { handle: () => {}, on: () => {}, once: () => {} };
export const contextBridge = { exposeInMainWorld: () => {} };
export const ipcRenderer = { invoke: async () => {}, on: () => {}, send: () => {} };
export const nativeImage = { createFromPath: () => ({}) };
