// The project store — zustand, single source of truth for the open
// project, the active file's body, and sidebar visibility/width.
//
// Phase 3 ships a single-active-file model. Phase 4 swaps it for the
// tabs layer; the store's external surface stays small enough that the
// swap is contained to `setActiveFile` / `closeFile` / etc.

import { create } from 'zustand';
import type {
  FileContent,
  FileEntry,
  ProjectChange,
  ProjectManifest
} from '@skrive/shared';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const DEFAULT_BODY = '';

type State = {
  manifest: ProjectManifest | null;
  activeFile: FileEntry | null;
  activeBody: string;
  activeDirty: boolean;
  loading: boolean;

  sidebarVisible: boolean;
  sidebarWidth: number;

  /**
   * Detach function for the watcher subscription. Set when the project
   * is opened, called when closing or replacing the project.
   */
  unsubscribeWatch: (() => void) | null;
};

type Actions = {
  openProjectFromDialog(): Promise<void>;
  openProject(path: string): Promise<void>;
  closeProject(): Promise<void>;
  refreshManifest(): Promise<void>;

  openFile(path: string): Promise<void>;
  setBody(next: string): void;
  saveActive(): Promise<void>;

  createFile(relPath: string): Promise<void>;
  createDirectory(relPath: string): Promise<void>;

  setSidebarVisible(v: boolean): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
};

function clampSidebarWidth(w: number): number {
  if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, w));
}

function findEntry(manifest: ProjectManifest | null, path: string): FileEntry | null {
  if (!manifest) return null;
  return manifest.files.find((f) => f.path === path) ?? null;
}

export const useProjectStore = create<State & Actions>((set, get) => ({
  manifest: null,
  activeFile: null,
  activeBody: DEFAULT_BODY,
  activeDirty: false,
  loading: false,

  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,

  unsubscribeWatch: null,

  async openProjectFromDialog() {
    const path = await window.skrive.project.openDialog();
    if (!path) return;
    await get().openProject(path);
  },

  async openProject(path: string) {
    set({ loading: true });
    try {
      const prev = get().unsubscribeWatch;
      if (prev) {
        prev();
      }
      await window.skrive.project.unwatch();

      const manifest = await window.skrive.project.open(path);

      const unsubscribe = window.skrive.project.onChange((event) => {
        // Watcher events: refresh the manifest. We're conservative —
        // any add/change/unlink at the file level triggers a full
        // re-scan. With Phase 3's hardcoded skip list and markdown-only
        // filter, the scan is cheap enough that incremental updates
        // aren't worth the bookkeeping.
        if (event.kind === 'ready') return;
        void get().refreshManifest();
      });
      await window.skrive.project.watch(manifest.root);

      set({
        manifest,
        activeFile: null,
        activeBody: DEFAULT_BODY,
        activeDirty: false,
        unsubscribeWatch: unsubscribe,
        loading: false
      });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  async closeProject() {
    const prev = get().unsubscribeWatch;
    if (prev) prev();
    await window.skrive.project.unwatch();
    set({
      manifest: null,
      activeFile: null,
      activeBody: DEFAULT_BODY,
      activeDirty: false,
      unsubscribeWatch: null
    });
  },

  async refreshManifest() {
    const manifest = get().manifest;
    if (!manifest) return;
    const next = await window.skrive.project.open(manifest.root);
    set({ manifest: next });
    // If the active file vanished from disk, drop it. If it still exists,
    // keep the live editor body — the user may have unsaved edits, and
    // the watcher fired because *we* wrote it via `saveActive`.
    const active = get().activeFile;
    if (active && !next.files.find((f) => f.path === active.path)) {
      set({ activeFile: null, activeBody: DEFAULT_BODY, activeDirty: false });
    } else if (active) {
      // Refresh the active FileEntry reference (mtime/size may have changed).
      const updated = next.files.find((f) => f.path === active.path);
      if (updated) set({ activeFile: updated });
    }
  },

  async openFile(path: string) {
    const manifest = get().manifest;
    if (!manifest) return;
    const entry = findEntry(manifest, path);
    if (!entry) return;
    const content: FileContent = await window.skrive.fs.readFile(
      manifest.root,
      path
    );
    set({
      activeFile: entry,
      activeBody: content.body,
      activeDirty: false
    });
  },

  setBody(next: string) {
    const { activeFile, activeBody } = get();
    if (!activeFile) {
      // No active file → ignore edit (the editor shouldn't be mounted in
      // this case, but defend against the race).
      return;
    }
    if (next === activeBody) return;
    set({ activeBody: next, activeDirty: true });
  },

  async saveActive() {
    const { manifest, activeFile, activeBody, activeDirty } = get();
    if (!manifest || !activeFile || !activeDirty) return;
    await window.skrive.fs.writeFile(
      manifest.root,
      activeFile.path,
      activeBody
    );
    set({ activeDirty: false });
  },

  async createFile(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    const normalized = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
    await window.skrive.fs.newFile(manifest.root, normalized);
    await get().refreshManifest();
    await get().openFile(normalized);
  },

  async createDirectory(relPath: string) {
    const { manifest } = get();
    if (!manifest) return;
    await window.skrive.fs.mkdir(manifest.root, relPath);
    // Empty directories don't appear in the manifest (it's a flat file
    // list) — no refresh needed. The watcher's addDir event also fires
    // and refreshes on the next file added inside.
  },

  setSidebarVisible(v: boolean) {
    set({ sidebarVisible: v });
  },

  toggleSidebar() {
    set({ sidebarVisible: !get().sidebarVisible });
  },

  setSidebarWidth(width: number) {
    set({ sidebarWidth: clampSidebarWidth(width) });
  }
}));

// Phase 9 hooks watcher events into project-state persistence; Phase 3
// surfaces the unhandled-rejection log for now so failures aren't silent.
export function logProjectError(label: string, err: unknown) {
  console.error(`[skrive project] ${label}`, err);
}
