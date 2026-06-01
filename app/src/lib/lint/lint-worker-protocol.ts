// Wire contract between the renderer (project store) and the lint Worker.
// Type-only — nothing here is emitted, so both sides import it without
// pulling the worker bundle into the main chunk. Keeping the messages in
// one place means the two ends can't silently drift.

import type {
  DeadLink,
  ProjectLintReport,
  ProjectManifest
} from '@skrive/shared';

/** Main thread → worker. The worker owns the full body map across passes;
 *  the main thread sends only the bodies that changed since the last run
 *  (`delta`) plus the paths that left the project (`removed`). `seq` is an
 *  echoed monotonic id used to drop reports the main thread no longer wants. */
export type LintWorkerRequest = {
  type: 'run';
  seq: number;
  /** The full project manifest, or `null` to mean "unchanged since the
   *  previous run — reuse the one you cached." The main thread sends the
   *  whole manifest only when its lint-relevant identity changed; during
   *  prose typing (bodies change, manifest doesn't) it sends `null` so we
   *  skip structured-cloning all ~95 entries on every pass. The worker
   *  caches the last non-null manifest across passes. */
  manifest: ProjectManifest | null;
  deadLinks: DeadLink[];
  orphanedFiles: string[];
  /** New or changed `[path, body]` pairs since the worker's last pass. */
  delta: Array<[string, string]>;
  /** Paths the worker should forget (file deleted / left the project). */
  removed: string[];
};

/** Worker → main thread. Carries the report and the `seq` it was computed
 *  for, so a result that a project switch has obsoleted can be discarded. */
export type LintWorkerResponse = {
  type: 'result';
  seq: number;
  report: ProjectLintReport;
  /** Wall-clock ms the worker spent inside runProjectLint, so the main thread
   *  can separate engine compute from postMessage/IPC overhead in perf logs. */
  workerMs: number;
};
