import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppUiState,
  Backlink,
  DeadLink,
  DiffOp,
  FileContent,
  HistoryEntry,
  HistoryMode,
  LineDiffRow,
  OutgoingLink,
  ProjectChange,
  ProjectManifest,
  ProjectUiState,
  RenamePreview,
  RenameReport,
  SearchHit,
  SearchOptions,
  SkriveIpc,
  SkrivePlatform
} from '@skrive/shared';

const api: SkriveIpc = {
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    platform: () =>
      ipcRenderer.invoke('app:platform') as Promise<SkrivePlatform>
  },
  links: {
    openExternal: (url: string) =>
      ipcRenderer.invoke('links:openExternal', url) as Promise<void>
  },
  project: {
    openDialog: () =>
      ipcRenderer.invoke('project:openDialog') as Promise<string | null>,
    open: (root: string) =>
      ipcRenderer.invoke('project:open', root) as Promise<ProjectManifest>,
    watch: (root: string) =>
      ipcRenderer.invoke('project:watch', root) as Promise<void>,
    unwatch: () => ipcRenderer.invoke('project:unwatch') as Promise<void>,
    onChange: (handler: (event: ProjectChange) => void) => {
      const wrapped = (_event: unknown, payload: ProjectChange) =>
        handler(payload);
      ipcRenderer.on('project:change', wrapped);
      return () => {
        ipcRenderer.removeListener('project:change', wrapped);
      };
    }
  },
  fs: {
    readFile: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('fs:readFile', projectRoot, relPath) as Promise<FileContent>,
    writeFile: (projectRoot: string, relPath: string, content: string) =>
      ipcRenderer.invoke(
        'fs:writeFile',
        projectRoot,
        relPath,
        content
      ) as Promise<void>,
    newFile: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('fs:newFile', projectRoot, relPath) as Promise<void>,
    mkdir: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('fs:mkdir', projectRoot, relPath) as Promise<void>,
    rename: (projectRoot: string, oldRelPath: string, newRelPath: string) =>
      ipcRenderer.invoke(
        'fs:rename',
        projectRoot,
        oldRelPath,
        newRelPath
      ) as Promise<void>,
    trash: (projectRoot: string, relPath: string) =>
      ipcRenderer.invoke('fs:trash', projectRoot, relPath) as Promise<void>
  },
  diff: {
    computeDiff: (before: string, after: string) =>
      ipcRenderer.invoke('diff:computeDiff', before, after) as Promise<DiffOp[]>,
    computeLineDiff: (before: string, after: string) =>
      ipcRenderer.invoke(
        'diff:computeLineDiff',
        before,
        after
      ) as Promise<LineDiffRow[]>
  },
  search: {
    searchProject: (query: string, options: SearchOptions) =>
      ipcRenderer.invoke(
        'search:searchProject',
        query,
        options
      ) as Promise<SearchHit[]>
  },
  history: {
    getMode: () => ipcRenderer.invoke('history:getMode') as Promise<HistoryMode>,
    listForFile: (relPath: string) =>
      ipcRenderer.invoke(
        'history:listForFile',
        relPath
      ) as Promise<HistoryEntry[]>,
    readGitBlobAt: (relPath: string, sha: string) =>
      ipcRenderer.invoke(
        'history:readGitBlobAt',
        relPath,
        sha
      ) as Promise<string>,
    readCheckpointAt: (relPath: string, id: string) =>
      ipcRenderer.invoke(
        'history:readCheckpointAt',
        relPath,
        id
      ) as Promise<string>,
    createManualCheckpoint: (
      relPath: string,
      name: string,
      content: string
    ) =>
      ipcRenderer.invoke(
        'history:createManualCheckpoint',
        relPath,
        name,
        content
      ) as Promise<void>
  },
  linkGraph: {
    getBacklinks: (target: string) =>
      ipcRenderer.invoke('linkGraph:getBacklinks', target) as Promise<Backlink[]>,
    getOutgoing: (source: string) =>
      ipcRenderer.invoke('linkGraph:getOutgoing', source) as Promise<
        OutgoingLink[]
      >,
    getDeadLinks: () =>
      ipcRenderer.invoke('linkGraph:getDeadLinks') as Promise<DeadLink[]>,
    getOrphanedFiles: () =>
      ipcRenderer.invoke('linkGraph:getOrphanedFiles') as Promise<string[]>,
    previewRename: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke(
        'linkGraph:previewRename',
        oldPath,
        newPath
      ) as Promise<RenamePreview>,
    renameWithReferences: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke(
        'linkGraph:renameWithReferences',
        oldPath,
        newPath
      ) as Promise<RenameReport>
  },
  persistence: {
    loadAppState: () =>
      ipcRenderer.invoke('appState:load') as Promise<AppUiState>,
    saveAppState: (state: AppUiState) =>
      ipcRenderer.invoke('appState:save', state) as Promise<void>,
    loadProjectState: (projectRoot: string) =>
      ipcRenderer.invoke(
        'projectState:load',
        projectRoot
      ) as Promise<ProjectUiState | null>,
    saveProjectState: (projectRoot: string, state: ProjectUiState) =>
      ipcRenderer.invoke(
        'projectState:save',
        projectRoot,
        state
      ) as Promise<void>,
    revealUserData: () =>
      ipcRenderer.invoke('appState:revealUserData') as Promise<void>
  }
};

contextBridge.exposeInMainWorld('skrive', api);
