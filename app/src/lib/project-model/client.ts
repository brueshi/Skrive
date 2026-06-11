// Promise-based client for the project-model Worker, plus the
// module-level singleton the store and panels share. The store owns the
// lifecycle (spawn on project open, terminate on close); panels and
// modals call the query methods and never touch the worker directly.
//
// Mutations resolve AFTER any resulting model update has been delivered
// to onModelUpdate subscribers — callers can rely on the store's
// manifest being current when an `await upsert()` returns.

import type {
  Backlink,
  DeadLink,
  OutgoingLink,
  ProjectSnapshot,
  RenamePreview,
  SearchHit,
  SearchOptions
} from '@skrive/shared';
import type { RenamePlan, UpsertMeta } from './model';
import type {
  ModelUpdate,
  MutationResult,
  ProjectModelQuery,
  ProjectModelRequest,
  ProjectModelResponse
} from './protocol';

export type ModelUpdateHandler = (update: ModelUpdate) => void;

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
};

/** Distributive Omit — plain Omit collapses a discriminated union. */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

function hasModelUpdate(data: unknown): data is { model: ModelUpdate } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'model' in data &&
    (data as { model: unknown }).model !== null
  );
}

function isModelUpdate(data: unknown): data is ModelUpdate {
  return (
    typeof data === 'object' &&
    data !== null &&
    'manifest' in data &&
    'version' in data
  );
}

export class ProjectModelClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private updateHandlers = new Set<ModelUpdateHandler>();

  constructor() {
    this.worker = new Worker(
      new URL('./project-model.worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (event: MessageEvent<ProjectModelResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.seq);
      if (!entry) return;
      this.pending.delete(message.seq);
      if (message.type === 'error') {
        entry.reject(new Error(message.message));
        return;
      }
      // Deliver the model update to subscribers BEFORE resolving the
      // caller — the ordering guarantee documented above.
      if (hasModelUpdate(message.data)) {
        this.deliver(message.data.model);
      } else if (isModelUpdate(message.data)) {
        this.deliver(message.data);
      }
      entry.resolve(message.data);
    };
    this.worker.onerror = (event) => {
      // A worker crash strands every in-flight promise; fail them loudly
      // rather than hanging their callers.
      const error = new Error(event.message || 'project-model worker error');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  private deliver(update: ModelUpdate): void {
    for (const handler of this.updateHandlers) handler(update);
  }

  /** Subscribe to manifest updates (fired on structure-relevant changes
   *  only). Returns an unsubscribe function. */
  onModelUpdate(handler: ModelUpdateHandler): () => void {
    this.updateHandlers.add(handler);
    return () => {
      this.updateHandlers.delete(handler);
    };
  }

  terminate(): void {
    this.worker.terminate();
    const error = new Error('project-model worker terminated');
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.updateHandlers.clear();
  }

  private post(request: WithoutSeq<ProjectModelRequest>): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ ...request, seq });
    });
  }

  init(snapshot: ProjectSnapshot): Promise<ModelUpdate> {
    return this.post({ type: 'init', snapshot }) as Promise<ModelUpdate>;
  }

  upsert(
    path: string,
    body: string,
    meta?: UpsertMeta
  ): Promise<MutationResult> {
    return this.post({
      type: 'upsert',
      path,
      body,
      meta
    }) as Promise<MutationResult>;
  }

  remove(path: string): Promise<MutationResult> {
    return this.post({ type: 'remove', path }) as Promise<MutationResult>;
  }

  private query<T>(query: ProjectModelQuery): Promise<T> {
    return this.post({ type: 'query', query }) as Promise<T>;
  }

  getBacklinks(target: string): Promise<Backlink[]> {
    return this.query({ kind: 'backlinks', target });
  }

  getOutgoing(source: string): Promise<OutgoingLink[]> {
    return this.query({ kind: 'outgoing', source });
  }

  getDeadLinks(): Promise<DeadLink[]> {
    return this.query({ kind: 'deadLinks' });
  }

  getOrphanedFiles(): Promise<string[]> {
    return this.query({ kind: 'orphanedFiles' });
  }

  searchProject(query: string, options: SearchOptions): Promise<SearchHit[]> {
    return this.query({ kind: 'search', query, options });
  }

  previewRename(oldPath: string, newPath: string): Promise<RenamePreview> {
    return this.query({ kind: 'previewRename', oldPath, newPath });
  }

  renamePlan(oldPath: string, newPath: string): Promise<RenamePlan> {
    return this.query({ kind: 'renamePlan', oldPath, newPath });
  }
}

// ───────────────────── Shared singleton ─────────────────────
// The store replaces the instance on project open; consumers read
// through `projectModel()` at call time so they never hold a stale
// reference across a project switch.

let active: ProjectModelClient | null = null;

export function spawnProjectModel(): ProjectModelClient {
  active?.terminate();
  active = new ProjectModelClient();
  return active;
}

export function projectModel(): ProjectModelClient | null {
  return active;
}

export function terminateProjectModel(): void {
  active?.terminate();
  active = null;
}
