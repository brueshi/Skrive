// Link-graph IPC: backlinks, outgoing links, dead links. Reads from
// the singleton projectState; the graph is kept fresh by project:open
// and the watcher / fs:* handlers.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { projectState } from '../state/project-state';
import { previewRename, renameWithReferences } from '../lib/link-graph';
import type { Backlink, DeadLink, OutgoingLink } from '@skrive/shared';
import { IpcError, registerCommand } from '../main/dispatch';

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new IpcError('INVALID_PAYLOAD', `${field} must be a string`);
  }
  return value;
}

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
  registerCommand('linkGraph:getBacklinks', async (payload) => {
    const target = requireString(payload, 'target');
    const root = projectState.root;
    if (!root) return { backlinks: [] as Backlink[] };
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
    return { backlinks: out };
  });

  registerCommand('linkGraph:getOutgoing', async (payload) => {
    const source = requireString(payload, 'source');
    const edges = projectState.linkGraph.outgoing(source);
    if (!edges) return { outgoing: [] as OutgoingLink[] };
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
    return { outgoing: out };
  });

  registerCommand('linkGraph:previewRename', async (payload) => {
    const oldPath = requireString(payload, 'oldPath');
    const newPath = requireString(payload, 'newPath');
    const root = projectState.root;
    if (!root) {
      return {
        targetExists: false,
        references: [],
        definitionUpdates: []
      };
    }
    const preview = previewRename(
      {
        root,
        graph: projectState.linkGraph,
        filePaths: projectState.filePaths
      },
      oldPath,
      newPath
    );
    return preview as unknown as Record<string, unknown>;
  });

  registerCommand('linkGraph:renameWithReferences', async (payload) => {
    const oldPath = requireString(payload, 'oldPath');
    const newPath = requireString(payload, 'newPath');
    const root = projectState.root;
    if (!root) {
      throw new IpcError('NO_PROJECT', 'No project is open');
    }
    const report = await renameWithReferences(
      {
        root,
        graph: projectState.linkGraph,
        filePaths: projectState.filePaths
      },
      oldPath,
      newPath
    );
    return report as unknown as Record<string, unknown>;
  });

  registerCommand('linkGraph:getOrphanedFiles', async () => {
    return {
      paths: projectState.linkGraph.orphanedAmong(projectState.filePaths)
    };
  });

  registerCommand('linkGraph:getDeadLinks', async () => {
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
    return { deadLinks: out };
  });
}
