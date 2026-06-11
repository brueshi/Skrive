// The Electron transport for the envelope contract (Stage 0.1 of the
// Zig shell plan). Requests are JSON-string envelopes on one channel,
// events arrive as JSON-string envelopes on another; this file maps
// the typed `SkriveIpc` surface onto that transport. The renderer is
// unchanged and unaware — it sees the same `window.skrive` as before.

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
  SkriveEvent,
  SkriveIpc,
  SkrivePlatform,
  SkriveRequest,
  SkriveResponse,
  UpdaterStatus
} from '@skrive/shared';
// Value imports come from the contract module directly, NOT the
// `@skrive/shared` barrel. The barrel re-exports frontmatter helpers
// whose `yaml` import survives bundling as an external require — and a
// sandboxed preload can require nothing but `electron`, so that single
// line kills the preload before `window.skrive` is exposed.
// `ipc-contracts.ts` has zero runtime imports by design; keep it that way.
import {
  ENVELOPE_VERSION,
  SKRIVE_EVENT_CHANNEL,
  SKRIVE_INVOKE_CHANNEL
} from '../../../shared/src/ipc-contracts';

let nextRequestId = 1;

async function invoke<T>(
  cmd: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const request: SkriveRequest = {
    v: ENVELOPE_VERSION,
    id: nextRequestId++,
    cmd,
    payload
  };
  const raw = (await ipcRenderer.invoke(
    SKRIVE_INVOKE_CHANNEL,
    JSON.stringify(request)
  )) as string;
  const response = JSON.parse(raw) as SkriveResponse;
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.result as T;
}

// One listener demuxes every shell event to its subscribers. Handlers
// are registered per event name; unsubscribe removes from the set.
type EventHandler = (payload: Record<string, unknown>) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

ipcRenderer.on(SKRIVE_EVENT_CHANNEL, (_event, raw: string) => {
  let envelope: SkriveEvent;
  try {
    envelope = JSON.parse(raw) as SkriveEvent;
  } catch {
    return;
  }
  const handlers = eventHandlers.get(envelope.event);
  if (!handlers) return;
  for (const handler of handlers) handler(envelope.payload);
});

function onEvent(event: string, handler: EventHandler): () => void {
  let handlers = eventHandlers.get(event);
  if (!handlers) {
    handlers = new Set();
    eventHandlers.set(event, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

const api: SkriveIpc = {
  app: {
    version: async () =>
      (await invoke<{ version: string }>('app:version')).version,
    platform: async () =>
      (await invoke<{ platform: SkrivePlatform }>('app:platform')).platform,
    onFlushBeforeQuit: (handler: () => void) =>
      onEvent('app:flush-before-quit', () => handler()),
    flushComplete: () => ipcRenderer.send('app:flush-complete')
  },
  links: {
    openExternal: async (url: string) => {
      await invoke('links:openExternal', { url });
    }
  },
  project: {
    openDialog: async () =>
      (await invoke<{ path: string | null }>('project:openDialog')).path,
    open: (root: string) => invoke<ProjectManifest>('project:open', { root }),
    getManifest: async () =>
      (
        await invoke<{
          current: { manifest: ProjectManifest; version: number } | null;
        }>('project:getManifest')
      ).current,
    watch: async (root: string) => {
      await invoke('project:watch', { root });
    },
    unwatch: async () => {
      await invoke('project:unwatch');
    },
    onChange: (handler: (event: ProjectChange) => void) =>
      onEvent('project:change', (payload) =>
        handler(payload as unknown as ProjectChange)
      ),
    create: async (parent: string, name: string, options: { gitInit: boolean }) =>
      (
        await invoke<{ path: string }>('project:create', {
          parent,
          name,
          gitInit: options?.gitInit === true
        })
      ).path
  },
  fs: {
    readFile: (projectRoot: string, relPath: string) =>
      invoke<FileContent>('fs:readFile', { projectRoot, relPath }),
    writeFile: async (projectRoot: string, relPath: string, content: string) =>
      (
        await invoke<{ hash: string }>('fs:writeFile', {
          projectRoot,
          relPath,
          content
        })
      ).hash,
    detectExternalChange: async (
      projectRoot: string,
      relPath: string,
      knownHash: string
    ) =>
      (
        await invoke<{ changed: boolean }>('fs:detectExternalChange', {
          projectRoot,
          relPath,
          knownHash
        })
      ).changed,
    writeBinaryFile: async (
      projectRoot: string,
      relPath: string,
      base64: string
    ) => {
      await invoke('fs:writeBinaryFile', { projectRoot, relPath, base64 });
    },
    newFile: async (projectRoot: string, relPath: string) => {
      await invoke('fs:newFile', { projectRoot, relPath });
    },
    mkdir: async (projectRoot: string, relPath: string) => {
      await invoke('fs:mkdir', { projectRoot, relPath });
    },
    rename: async (
      projectRoot: string,
      oldRelPath: string,
      newRelPath: string
    ) => {
      await invoke('fs:rename', { projectRoot, oldRelPath, newRelPath });
    },
    trash: async (projectRoot: string, relPath: string) => {
      await invoke('fs:trash', { projectRoot, relPath });
    }
  },
  diff: {
    computeDiff: async (before: string, after: string) =>
      (await invoke<{ ops: DiffOp[] }>('diff:computeDiff', { before, after }))
        .ops,
    computeLineDiff: async (before: string, after: string) =>
      (
        await invoke<{ rows: LineDiffRow[] }>('diff:computeLineDiff', {
          before,
          after
        })
      ).rows
  },
  search: {
    searchProject: async (query: string, options: SearchOptions) =>
      (
        await invoke<{ hits: SearchHit[] }>('search:searchProject', {
          query,
          options
        })
      ).hits
  },
  history: {
    getMode: async () =>
      (await invoke<{ mode: HistoryMode }>('history:getMode')).mode,
    listForFile: async (relPath: string) =>
      (
        await invoke<{ entries: HistoryEntry[] }>('history:listForFile', {
          relPath
        })
      ).entries,
    readGitBlobAt: async (relPath: string, sha: string) =>
      (
        await invoke<{ content: string }>('history:readGitBlobAt', {
          relPath,
          sha
        })
      ).content,
    readCheckpointAt: async (relPath: string, id: string) =>
      (
        await invoke<{ content: string }>('history:readCheckpointAt', {
          relPath,
          id
        })
      ).content,
    createManualCheckpoint: async (
      relPath: string,
      name: string,
      content: string
    ) => {
      await invoke('history:createManualCheckpoint', {
        relPath,
        name,
        content
      });
    },
    setGitHistoryEnabled: async (enabled: boolean) =>
      (
        await invoke<{ mode: HistoryMode }>('history:setGitHistoryEnabled', {
          enabled
        })
      ).mode
  },
  linkGraph: {
    getBacklinks: async (target: string) =>
      (
        await invoke<{ backlinks: Backlink[] }>('linkGraph:getBacklinks', {
          target
        })
      ).backlinks,
    getOutgoing: async (source: string) =>
      (
        await invoke<{ outgoing: OutgoingLink[] }>('linkGraph:getOutgoing', {
          source
        })
      ).outgoing,
    getDeadLinks: async () =>
      (await invoke<{ deadLinks: DeadLink[] }>('linkGraph:getDeadLinks'))
        .deadLinks,
    getOrphanedFiles: async () =>
      (await invoke<{ paths: string[] }>('linkGraph:getOrphanedFiles')).paths,
    previewRename: (oldPath: string, newPath: string) =>
      invoke<RenamePreview>('linkGraph:previewRename', { oldPath, newPath }),
    renameWithReferences: (oldPath: string, newPath: string) =>
      invoke<RenameReport>('linkGraph:renameWithReferences', {
        oldPath,
        newPath
      })
  },
  updater: {
    current: () => invoke<UpdaterStatus>('updater:current'),
    check: async () => {
      await invoke('updater:check');
    },
    downloadAndInstall: async () => {
      await invoke('updater:downloadAndInstall');
    },
    onStatus: (handler: (status: UpdaterStatus) => void) =>
      onEvent('updater:status', (payload) =>
        handler(payload as unknown as UpdaterStatus)
      )
  },
  persistence: {
    loadAppState: () => invoke<AppUiState>('persistence:loadAppState'),
    saveAppState: async (state: AppUiState) => {
      await invoke('persistence:saveAppState', { state });
    },
    loadProjectState: async (projectRoot: string) =>
      (
        await invoke<{ state: ProjectUiState | null }>(
          'persistence:loadProjectState',
          { projectRoot }
        )
      ).state,
    saveProjectState: async (projectRoot: string, state: ProjectUiState) => {
      await invoke('persistence:saveProjectState', { projectRoot, state });
    },
    revealUserData: async () => {
      await invoke('persistence:revealUserData');
    }
  }
};

contextBridge.exposeInMainWorld('skrive', api);
