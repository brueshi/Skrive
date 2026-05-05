import { contextBridge, ipcRenderer } from 'electron';
import type { SkriveIpc, SkrivePlatform } from '@skrive/shared';

const api: SkriveIpc = {
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    platform: () => ipcRenderer.invoke('app:platform') as Promise<SkrivePlatform>
  }
};

contextBridge.exposeInMainWorld('skrive', api);
