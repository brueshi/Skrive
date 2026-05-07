// Link-graph IPC: backlinks, outgoing links, dead links. Reads from
// the singleton projectState; the graph is kept fresh by project:open
// and the watcher / fs:* handlers.

import { ipcMain } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { projectState } from '../state/project-state';
import { previewRename, renameWithReferences } from '../lib/link-graph';
import type {
  Backlink,
  DeadLink,
  OutgoingLink,
  RenamePreview,
  RenameReport
} from '@skrive/shared';

/** Read one line of a source file for snippet display. Failures
 *  collapse to an empty snippet — backlinks UI tolerates it. */
async function readSnippetLine(
  root: string,
  relPath: string,
  line: number
): Promise<string> {
  try {
    const body = await fsp.readFile(path.join(root, relPath), 'utf8');
    const lines = body.split('\n');
    return (lines[line] ?? '').trim();
  } catch {
    return '';
  }
}

export function registerLinksHandlers(): void {
  ipcMain.handle(
    'linkGraph:getBacklinks',
    async (_event, target: string): Promise<Backlink[]> => {
      const root = projectState.root;
      if (!root) return [];
      const sources = projectState.linkGraph.incoming(target);
      const out: Backlink[] = [];
      for (const source of sources) {
        const edges = projectState.linkGraph.outgoing(source);
        if (!edges) continue;
        for (const edge of edges) {
          if (edge.target.kind !== 'relative') continue;
          if (edge.target.path !== target) continue;
          out.push({
            source,
            range: edge.range,
            line: edge.line,
            column: edge.column,
            kind: edge.kind,
            snippet: await readSnippetLine(root, source, edge.line)
          });
        }
      }
      return out;
    }
  );

  ipcMain.handle(
    'linkGraph:getOutgoing',
    async (_event, source: string): Promise<OutgoingLink[]> => {
      const edges = projectState.linkGraph.outgoing(source);
      if (!edges) return [];
      const out: OutgoingLink[] = [];
      for (const edge of edges) {
        if (edge.target.kind === 'relative') {
          out.push({
            target: edge.target.path,
            targetKind: 'relative',
            range: edge.range,
            line: edge.line,
            column: edge.column,
            kind: edge.kind,
            resolved: projectState.hasFile(edge.target.path)
          });
        } else {
          out.push({
            target: edge.target.name,
            targetKind: 'wiki',
            range: edge.range,
            line: edge.line,
            column: edge.column,
            kind: edge.kind,
            // Wiki targets aren't path-resolved at extraction; the UI
            // can decide what "resolved" means later (case-insensitive
            // basename match, etc.). For now, mark as resolved so wiki
            // edges don't surface as dead links by accident.
            resolved: true
          });
        }
      }
      return out;
    }
  );

  ipcMain.handle(
    'linkGraph:previewRename',
    async (
      _event,
      oldPath: string,
      newPath: string
    ): Promise<RenamePreview> => {
      const root = projectState.root;
      if (!root) {
        return {
          targetExists: false,
          references: [],
          definitionUpdates: []
        };
      }
      return previewRename(
        {
          root,
          graph: projectState.linkGraph,
          filePaths: projectState.filePaths
        },
        oldPath,
        newPath
      );
    }
  );

  ipcMain.handle(
    'linkGraph:renameWithReferences',
    async (
      _event,
      oldPath: string,
      newPath: string
    ): Promise<RenameReport> => {
      const root = projectState.root;
      if (!root) {
        throw new Error('No project is open');
      }
      return renameWithReferences(
        {
          root,
          graph: projectState.linkGraph,
          filePaths: projectState.filePaths
        },
        oldPath,
        newPath
      );
    }
  );

  ipcMain.handle(
    'linkGraph:getOrphanedFiles',
    async (): Promise<string[]> => {
      return projectState.linkGraph.orphanedAmong(projectState.filePaths);
    }
  );

  ipcMain.handle('linkGraph:getDeadLinks', async (): Promise<DeadLink[]> => {
    const out: DeadLink[] = [];
    for (const [source, edges] of projectState.linkGraph.iter()) {
      for (const edge of edges) {
        if (edge.target.kind !== 'relative') continue;
        if (projectState.hasFile(edge.target.path)) continue;
        out.push({
          source,
          target: edge.target.path,
          range: edge.range,
          line: edge.line,
          column: edge.column,
          kind: edge.kind
        });
      }
    }
    return out;
  });
}
