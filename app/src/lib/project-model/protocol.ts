// Wire contract between the renderer (project store / panels) and the
// project-model Worker. Type-only — both sides import it without
// pulling the worker bundle into the main chunk.

import type {
  ProjectManifest,
  ProjectSnapshot,
  SearchOptions
} from '@skrive/shared';
import type { UpsertMeta } from './model';

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

/** Worker → main thread. `result` answers a request by seq. `model` is
 *  pushed (unsolicited) whenever a structure-relevant change bumped the
 *  manifest version — the same trigger semantics the shell's
 *  manifestVersion had. */
export type ProjectModelResponse =
  | { type: 'result'; seq: number; data: unknown }
  | { type: 'error'; seq: number; message: string }
  | { type: 'model'; manifest: ProjectManifest; version: number };
