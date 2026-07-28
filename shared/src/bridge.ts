// Transport abstraction (Stage 0.2 of the Zig shell plan). A transport
// is the smallest thing a host must provide — a request/response call
// and an event subscription — and `createSkriveBridge` builds the full
// typed `SkriveIpc` surface on top of it. Electron IPC, a native
// webview bridge, and an in-memory web shim are all just transports
// under this one tested mapping.
//
// This module is imported by sandboxed preloads: it must keep zero
// runtime imports outside this package's dependency-free contract
// modules (see the preload's note on `require` in sandboxed contexts).

import type { AppUiState, ProjectUiState } from './persistence';
import type {
  DiffOp,
  FileContent,
  HistoryEntry,
  HistoryMode,
  LineDiffRow,
  ProjectChange,
  ProjectSnapshot,
  SkriveIpc,
  SkrivePlatform,
  SpellCheckRequest,
  SpellCheckResult,
  UpdaterStatus
} from './ipc-contracts';

export interface SkriveTransport {
  /** Send one command and resolve with its result object. Rejects with
   *  an Error carrying the shell's error message when the response is
   *  an error envelope. Envelope framing (ids, serialization, the
   *  delivery mechanism) is the transport's concern, not the bridge's. */
  invoke(cmd: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a shell event by name. Returns an unsubscribe
   *  function. The handler receives the event's payload object. */
  on(
    event: string,
    handler: (payload: Record<string, unknown>) => void
  ): () => void;
}

/** Build the typed `SkriveIpc` surface over a transport. Owns the full
 *  command-name / payload-shape / result-unwrap mapping, so transports
 *  stay dumb pipes and the mapping is tested once for all of them. */
export function createSkriveBridge(transport: SkriveTransport): SkriveIpc {
  const invoke = <T>(
    cmd: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> => transport.invoke(cmd, payload) as Promise<T>;

  return {
    app: {
      version: async () =>
        (await invoke<{ version: string }>('app:version')).version,
      platform: async () =>
        (await invoke<{ platform: SkrivePlatform }>('app:platform')).platform,
      onFlushBeforeQuit: (handler: () => void) =>
        transport.on('app:flush-before-quit', () => handler()),
      // The flush ack is fire-and-forget by contract (the app may be
      // tearing down before the response lands), so the promise is
      // deliberately dropped. Renderer-to-shell traffic is requests-only
      // in the envelope model; there is no event lane in this direction.
      flushComplete: () => {
        void invoke('app:flushComplete');
      }
    },
    links: {
      openExternal: async (url: string) => {
        await invoke('links:openExternal', { url });
      }
    },
    clipboard: {
      writeRich: async (html: string, text: string) => {
        await invoke('clipboard:writeRich', { html, text });
      },
      writeText: async (text: string) => {
        await invoke('clipboard:writeText', { text });
      },
      readText: async () =>
        (await invoke<{ text: string }>('clipboard:readText')).text
    },
    project: {
      openDialog: async () =>
        (await invoke<{ path: string | null }>('project:openDialog')).path,
      snapshot: (root: string) =>
        invoke<ProjectSnapshot>('project:snapshot', { root }),
      watch: async (root: string) => {
        await invoke('project:watch', { root });
      },
      unwatch: async () => {
        await invoke('project:unwatch');
      },
      onChange: (handler: (event: ProjectChange) => void) =>
        transport.on('project:change', (payload) =>
          handler(payload as unknown as ProjectChange)
        ),
      create: async (
        parent: string,
        name: string,
        options: { gitInit: boolean }
      ) =>
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
      writeFile: async (
        projectRoot: string,
        relPath: string,
        content: string
      ) =>
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
    updater: {
      current: () => invoke<UpdaterStatus>('updater:current'),
      check: async () => {
        await invoke('updater:check');
      },
      downloadAndInstall: async () => {
        await invoke('updater:downloadAndInstall');
      },
      onStatus: (handler: (status: UpdaterStatus) => void) =>
        transport.on('updater:status', (payload) =>
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
    },
    log: {
      append: async (line: string) => {
        await invoke('log:append', { line });
      },
      reveal: async () => {
        await invoke('log:reveal');
      }
    },
    spell: {
      // The one call that must never reject: a host without a checker answers
      // nothing for it (unknown command), and "no checker" is a normal state,
      // not an error. Every other call in this namespace is only ever made
      // after this one has resolved true.
      available: async () => {
        try {
          return (
            (await invoke<{ available?: boolean }>('spell:available'))
              .available === true
          );
        } catch {
          return false;
        }
      },
      check: async (requests: SpellCheckRequest[]) =>
        (
          await invoke<{ results: SpellCheckResult[] }>('spell:check', {
            requests
          })
        ).results,
      suggest: async (word: string) =>
        (await invoke<{ suggestions: string[] }>('spell:suggest', { word }))
          .suggestions,
      learn: async (word: string) => {
        await invoke('spell:learn', { word });
      },
      ignore: async (word: string) => {
        await invoke('spell:ignore', { word });
      }
    }
  };
}
