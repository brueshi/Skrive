// Frontend mirrors of the Rust-side types returned by the Tauri commands.
// Kept in sync by hand for Phase 1/2. Once the surface stabilizes, we can
// generate these from the Rust source (specta, ts-rs) — but hand-written is
// fine for now and keeps the dependency footprint small.

export type ProjectManifest = {
  root: string;
  files: FileEntry[];
};

export type FileEntry = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number | null;
  frontmatter: Record<string, unknown>;
  outgoingLinks: string[];
};

export type FileContent = {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  modifiedMs: number | null;
};

// Frontend-only. Owned by the project store; never travels over the IPC wire.
export type Tab = {
  path: string;
  content: FileContent;
  dirty: boolean;
};
