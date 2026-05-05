import { contextBridge, ipcRenderer } from 'electron';
import type { SkriveIpc, SkrivePlatform } from '@skrive/shared';

const api: SkriveIpc = {
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    platform: () => ipcRenderer.invoke('app:platform') as Promise<SkrivePlatform>
  },
  links: {
    openExternal: (url: string) => ipcRenderer.invoke('links:openExternal', url) as Promise<void>
  }
};

contextBridge.exposeInMainWorld('skrive', api);
