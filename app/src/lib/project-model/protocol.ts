// Wire contract between the renderer (project store / panels) and the
// project-model Worker. Type-only — both sides import it without
// pulling the worker bundle into the main chunk.
//
// Every model change is store-initiated (init / upsert / remove), so
// the updated manifest rides in the mutation's RESULT rather than an
// unsolicited push. That makes ordering deterministic: when an upsert
// resolves, the caller is guaranteed the new manifest has already been
// delivered — no race between `await upsert()` and a separate push
// event (createFile → openDoc depends on exactly this).

import type {
  ProjectManifest,
  ProjectSnapshot,
  SearchOptions
} from '@skrive/shared';
import type { UpsertMeta } from './model';

export type ModelUpdate = {
  manifest: ProjectManifest;
  /** Monotonic; bumps only on structure-relevant changes, mirroring
   *  the shell's manifestVersion semantics. */
  version: number;
};

/** Result of an upsert/remove. `model` is null when the change was
 *  content-only (no version bump — the manifest identity is unchanged
 *  and consumers must not re-render). */
export type MutationResult = {
  changed: boolean;
  model: ModelUpdate | null;
};

export type ProjectModelQuery =
  | { kind: 'backlinks'; target: string }
  | { kind: 'outgoing'; source: string }
  | { kind: 'deadLinks' }
  | { kind: 'orphanedFiles' }
  | { kind: 'search'; query: string; options: SearchOptions }
  | { kind: 'previewRename'; oldPath: string; newPath: string }
  | { kind: 'renamePlan'; oldPath: string; newPath: string };

/** Main thread → worker. Every message carries a `seq` the worker
 *  echoes, so the client can resolve the matching promise. */
export type ProjectModelRequest =
  | { type: 'init'; seq: number; snapshot: ProjectSnapshot }
  | { type: 'upsert'; seq: number; path: string; body: string; meta?: UpsertMeta }
  | { type: 'remove'; seq: number; path: string }
  | { type: 'query'; seq: number; query: ProjectModelQuery };

/** Worker → main thread. `init` answers with a ModelUpdate, mutations
 *  with a MutationResult, queries with their query-specific data. */
export type ProjectModelResponse =
  | { type: 'result'; seq: number; data: unknown }
  | { type: 'error'; seq: number; message: string };
