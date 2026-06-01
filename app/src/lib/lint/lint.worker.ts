// The lint Worker. Runs the project-wide lint engine off the main thread so
// typing is never blocked by a pass — the engine is ~37ms on a large project
// with periodic GC spikes, and even debounced that micro-stutters the editor
// when it lands on the typing thread (Stage 2.75).
//
// The worker is the authoritative owner of the file-body map across passes.
// The main thread sends only what changed since the last run (`delta` +
// `removed`); the worker folds that into `bodyMap` and runs the engine over
// the whole project. The engine's path-keyed AST memo lives in this bundle
// too, so an unchanged file is never re-parsed across passes.
//
// `runProjectLint` is imported unchanged — it is output-pure, with no IPC,
// React, or Node dependency, which is exactly what makes it safe to host here.

import type { ProjectManifest } from '@skrive/shared';

import { runProjectLint } from './engine';
import type {
  LintWorkerRequest,
  LintWorkerResponse
} from './lint-worker-protocol';

// The app's tsconfig ships the DOM lib (not WebWorker), so `self` is typed as
// a Window. Narrow it to just the surface we use rather than pulling in the
// WebWorker lib, which would clash with DOM's duplicate global declarations.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<LintWorkerRequest>) => void) | null;
  postMessage: (message: LintWorkerResponse) => void;
};

// Full project body map, keyed by project-relative path. Survives across
// passes; mutated only by the deltas the main thread sends.
const bodyMap = new Map<string, string>();

// Last manifest the main thread sent, cached across passes exactly like
// `bodyMap` caches bodies. A `run` with `manifest: null` means "unchanged —
// reuse this", which lets the main thread skip structured-cloning the whole
// manifest on every prose keystroke.
let lastManifest: ProjectManifest | null = null;

ctx.onmessage = (event) => {
  const msg = event.data;
  if (msg.type !== 'run') return;

  // Resolve the effective manifest: a non-null send refreshes the cache, a
  // null send reuses it.
  if (msg.manifest !== null) lastManifest = msg.manifest;
  const manifest = lastManifest;

  for (const path of msg.removed) bodyMap.delete(path);
  for (const [path, body] of msg.delta) bodyMap.set(path, body);

  const startedAt = performance.now();

  // Should be unreachable — the first run always carries a manifest, so the
  // cache is primed before any null send. If it ever isn't, post an empty
  // report rather than dropping the message: the main thread runs lint behind
  // a single-flight latch keyed on `seq`, and a dropped result would wedge it
  // (no future run could start). An empty findings report releases the latch
  // cleanly.
  if (manifest === null) {
    const report = { findings: [], ranAt: 0 };
    const workerMs = performance.now() - startedAt;
    ctx.postMessage({ type: 'result', seq: msg.seq, report, workerMs });
    return;
  }

  const report = runProjectLint({
    manifest,
    bodies: bodyMap,
    deadLinks: msg.deadLinks,
    orphanedFiles: msg.orphanedFiles
  });
  const workerMs = performance.now() - startedAt;

  ctx.postMessage({ type: 'result', seq: msg.seq, report, workerMs });
};
