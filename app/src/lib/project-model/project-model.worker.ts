// The project-model Worker. Hosts the ProjectModel (manifest, link
// graph, search, rename planning) off the main thread, mirroring the
// lint worker's shape. All compute lives in model.ts — this file is
// message plumbing only.

import { ProjectModel } from './model';
import type {
  ProjectModelQuery,
  ProjectModelRequest,
  ProjectModelResponse
} from './protocol';

// The app's tsconfig ships the DOM lib (not WebWorker), so `self` is
// typed as a Window. Narrow it to the surface we use, same as the lint
// worker.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ProjectModelRequest>) => void) | null;
  postMessage: (message: ProjectModelResponse) => void;
};

const model = new ProjectModel();

function pushModel(): void {
  ctx.postMessage({
    type: 'model',
    manifest: model.manifest(),
    version: model.currentVersion()
  });
}

function runQuery(query: ProjectModelQuery): unknown {
  switch (query.kind) {
    case 'backlinks':
      return model.backlinks(query.target);
    case 'outgoing':
      return model.outgoing(query.source);
    case 'deadLinks':
      return model.deadLinks();
    case 'orphanedFiles':
      return model.orphanedFiles();
    case 'search':
      return model.search(query.query, query.options);
    case 'previewRename':
      return model.previewRename(query.oldPath, query.newPath);
    case 'renamePlan':
      return model.renamePlan(query.oldPath, query.newPath);
  }
}

ctx.onmessage = (event: MessageEvent<ProjectModelRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'init': {
        model.init(request.snapshot);
        ctx.postMessage({ type: 'result', seq: request.seq, data: null });
        pushModel();
        break;
      }
      case 'upsert': {
        const bumped = model.upsert(request.path, request.body, request.meta);
        ctx.postMessage({ type: 'result', seq: request.seq, data: bumped });
        if (bumped) pushModel();
        break;
      }
      case 'remove': {
        const bumped = model.remove(request.path);
        ctx.postMessage({ type: 'result', seq: request.seq, data: bumped });
        if (bumped) pushModel();
        break;
      }
      case 'query': {
        ctx.postMessage({
          type: 'result',
          seq: request.seq,
          data: runQuery(request.query)
        });
        break;
      }
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      seq: request.seq,
      message: err instanceof Error ? err.message : String(err)
    });
  }
};
