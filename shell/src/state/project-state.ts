// Singleton state for the active project. Since Stage 0.4 the renderer's
// project-model worker owns the manifest, link graph, and search; the
// shell keeps only what its own commands need — the project root, git
// detection, the user's git-history preference, and the checkpoint caps
// from `.skrive.toml`. Set by `project:snapshot` (via primeProjectState)
// and read by the fs auto-checkpoint path and the history commands.

import {
  DEFAULT_CHECKPOINTS_CONFIG,
  type CheckpointsConfig,
  type HistoryMode
} from '@skrive/shared';

class ProjectState {
  root: string | null = null;
  /** Phase 10. Whether a `.git/` directory sits at the project root.
   *  Decided at project open and stable for the session — the raw
   *  capability, independent of the user's preference. */
  gitDetected = false;
  /** Global user preference (mirrors AppUiState.gitHistoryEnabled). The
   *  renderer pushes the stored value through `history:setGitHistoryEnabled`
   *  at project open and on every toggle. Survives project switches —
   *  `reset()` deliberately leaves it untouched. */
  gitHistoryEnabled = true;
  /** Retention caps from `[checkpoints]` in `.skrive.toml`. Only
   *  meaningful in checkpoint mode; threaded through to the writer so
   *  the cap moves when the user retunes the config. */
  checkpointsConfig: CheckpointsConfig = { ...DEFAULT_CHECKPOINTS_CONFIG };

  /** Effective history backend for the open project. Git only when the
   *  repo is present AND the user hasn't disabled git history; otherwise
   *  Skrive's own checkpoint store. Every consumer (the history IPC, the
   *  auto-checkpoint-on-write in fs:writeFile) reads through here, so the
   *  preference takes effect everywhere without per-caller branching. */
  get historyMode(): HistoryMode {
    return this.gitDetected && this.gitHistoryEnabled ? 'git' : 'checkpoint';
  }

  reset(root: string | null): void {
    this.root = root;
    // gitHistoryEnabled is a global preference — preserved across project
    // switches. Only the per-project capability resets here.
    this.gitDetected = false;
    this.checkpointsConfig = { ...DEFAULT_CHECKPOINTS_CONFIG };
  }
}

export const projectState = new ProjectState();
