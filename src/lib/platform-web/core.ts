// Web shim for @tauri-apps/api/core.
//
// Vite redirects `@tauri-apps/api/core` to this module when VITE_TARGET=web.
// The Tauri build never imports it. The shim implements `invoke` as a switch
// over command names, backed by an in-memory project seeded by
// `bootstrapWebProject`. Refresh resets state — that matches the website's
// "play with it; don't worry about saving" semantics.
//
// Commands the editor surface needs (open/read project, search) are wired
// for parity. Desktop-only features (git/checkpoint history, structural
// diff, native dialogs) return graceful empty responses so their panels
// render an empty state instead of erroring.

import type {
  AppUiState,
  Backlink,
  CheckpointVersion,
  EditorFontId,
  FileContent,
  FileEntry,
  GitVersion,
  HistoryMode,
  OpenFileRequest,
  ProjectManifest,
  ProjectUiState,
  RenamePreview,
  RenameReport,
  SearchHit,
  SearchOptions,
} from "$lib/types";
import type { LineDiffRow } from "$lib/diff/line-diff";
import type { DiffOp } from "$lib/diff/structural-diff";

export type WebProjectFile = {
  /** Project-relative, forward-slash separated. */
  path: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  /**
   * Optional checkpoint history — older drafts of the file the demo
   * surfaces through the history panel (`⌘⇧H`). Listed oldest-first
   * for readability; the shim sorts newest-first when it returns
   * `get_checkpoint_history`. Each entry shows up as a clickable
   * row whose click opens a real side-by-side diff against the live
   * editor content via `compute_line_diff`.
   */
  snapshots?: WebSnapshot[];
};

export type WebSnapshot = {
  /** Body content at the snapshot point (post-frontmatter-strip). */
  content: string;
  /** Optional pin name. `null`/omitted → auto-checkpoint row. */
  name?: string | null;
  /**
   * Unix milliseconds. Defaults to a synthesized time stepped back from
   * `Date.now()` so multiple snapshots without explicit times still
   * sort newest-first sensibly.
   */
  timestampMs?: number;
};

export type WebProjectBootstrap = {
  /** Synthetic project root used in manifests; doesn't have to exist. */
  root?: string;
  files: WebProjectFile[];
};

// =========================== In-memory project state ===========================

const DEFAULT_ROOT = "/skrive-web";

type StoredSnapshot = {
  id: string;
  timestampMs: number;
  kind: "auto" | "manual";
  name: string | null;
  contentHash: string;
  content: string;
};

let projectRoot = DEFAULT_ROOT;
const fileBodies = new Map<string, string>();
const fileFrontmatter = new Map<string, Record<string, unknown>>();
const fileSizes = new Map<string, number>();
const fileSnapshots = new Map<string, StoredSnapshot[]>();

/**
 * Seed the in-memory project the shim serves through `invoke`. Call this
 * once before mounting the editor — typically from the host site's
 * +page.svelte before the project store boots.
 *
 * If a doc's body begins with a `---` YAML frontmatter fence and no
 * explicit `frontmatter` was provided, the fence is parsed and stripped
 * so the body matches what Rust's `read_file` normally returns: the
 * structured fields go into the frontmatter map, the editor shows only
 * the markdown content.
 */
export function bootstrapWebProject(bootstrap: WebProjectBootstrap): void {
  projectRoot = bootstrap.root ?? DEFAULT_ROOT;
  fileBodies.clear();
  fileFrontmatter.clear();
  fileSizes.clear();
  fileSnapshots.clear();
  for (const f of bootstrap.files) {
    let body = f.body;
    let fm: Record<string, unknown> = { ...(f.frontmatter ?? {}) };
    if (Object.keys(fm).length === 0) {
      const parsed = parseAndStripFrontmatter(body);
      fm = parsed.frontmatter;
      body = parsed.body;
    }
    fileBodies.set(f.path, body);
    fileFrontmatter.set(f.path, fm);
    fileSizes.set(f.path, byteLength(body));

    if (f.snapshots && f.snapshots.length > 0) {
      // Step explicit-less timestamps back from now in 1-day chunks so
      // entries without a fixed time still sort newest-first sensibly.
      const baseMs = Date.now();
      const stored: StoredSnapshot[] = f.snapshots.map((snap, idx) => {
        const tsExplicit = typeof snap.timestampMs === "number";
        const ts = tsExplicit
          ? (snap.timestampMs as number)
          : baseMs - (f.snapshots!.length - idx) * 24 * 60 * 60 * 1000;
        return {
          id: `${f.path}::${idx}`,
          timestampMs: ts,
          kind: snap.name ? "manual" : "auto",
          name: snap.name ?? null,
          contentHash: hashContent(snap.content),
          content: snap.content,
        };
      });
      fileSnapshots.set(f.path, stored);
    }
  }
}

/**
 * Lightweight non-cryptographic hash for the `contentHash` field on a
 * checkpoint row. djb2 → hex. The desktop app uses SHA-256; for the
 * demo, collision resistance only matters insofar as the UI uses the
 * value to collapse visible duplicates, and djb2 is plenty for that.
 */
function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  // Pad to 8 hex digits, prefix with a marker so it never collides with
  // a real SHA-256 hex if mixed sources ever appear.
  return "djb2-" + (h >>> 0).toString(16).padStart(8, "0");
}

// =========================== Frontmatter parser ===========================
//
// Tiny YAML subset matching what the demo content uses: scalar values
// (strings, numbers as strings, dates as strings) and `key:\n  - item`
// arrays. Anything more exotic falls through as a plain string. Good
// enough for the website's docs; we don't need a full YAML library here.

function parseAndStripFrontmatter(source: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!source.startsWith("---\n")) {
    return { frontmatter: {}, body: source };
  }
  const closeIdx = source.indexOf("\n---\n", 4);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: source };
  }
  const yaml = source.slice(4, closeIdx);
  const body = source.slice(closeIdx + 5);
  const fm: Record<string, unknown> = {};
  let currentArray: unknown[] | null = null;
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    if (currentArray && line.startsWith("  - ")) {
      currentArray.push(line.slice(4).trim());
      continue;
    }
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (value === "") {
      currentArray = [];
      fm[key] = currentArray;
    } else {
      fm[key] = value;
      currentArray = null;
    }
  }
  return { frontmatter: fm, body };
}

function byteLength(s: string): number {
  // TextEncoder is universally available in browsers; matches what the Rust
  // side reports as `size_bytes`.
  return new TextEncoder().encode(s).length;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function buildManifest(): ProjectManifest {
  const files: FileEntry[] = [];
  for (const [path, body] of fileBodies.entries()) {
    files.push({
      path,
      name: basename(path),
      sizeBytes: fileSizes.get(path) ?? byteLength(body),
      modifiedMs: null,
      frontmatter: fileFrontmatter.get(path) ?? {},
      outgoingLinks: [],
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: projectRoot,
    files,
    schema: buildSchema(files),
  };
}

// Project-wide frontmatter schema, matching Rust's `ProjectSchema`.
// Walks every file's frontmatter, counts presence per field, records
// distinct value types, and surfaces up to 20 distinct scalars per
// field for the autocomplete suggestion list.
function buildSchema(files: FileEntry[]): {
  fileCount: number;
  fields: Record<
    string,
    { presence: number; types: string[]; knownValues: unknown[] }
  >;
} {
  const fields: Record<
    string,
    {
      presence: number;
      typeSet: Set<string>;
      values: unknown[];
      sawNonScalar: boolean;
    }
  > = {};
  const KNOWN_VALUE_CAP = 20;
  for (const file of files) {
    for (const [key, raw] of Object.entries(file.frontmatter)) {
      const slot =
        fields[key] ??
        (fields[key] = {
          presence: 0,
          typeSet: new Set(),
          values: [],
          sawNonScalar: false,
        });
      slot.presence += 1;
      const typeName = scalarTypeOf(raw);
      slot.typeSet.add(typeName);
      if (typeName === "array" || typeName === "object") {
        slot.sawNonScalar = true;
        continue;
      }
      if (slot.values.length >= KNOWN_VALUE_CAP) {
        slot.sawNonScalar = true;
        continue;
      }
      if (!slot.values.some((v) => v === raw)) {
        slot.values.push(raw);
      }
    }
  }
  const out: Record<
    string,
    { presence: number; types: string[]; knownValues: unknown[] }
  > = {};
  for (const [key, slot] of Object.entries(fields)) {
    out[key] = {
      presence: slot.presence,
      types: [...slot.typeSet].sort(),
      knownValues: slot.sawNonScalar ? [] : slot.values,
    };
  }
  return { fileCount: files.length, fields: out };
}

function scalarTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// =========================== Backlinks ===========================
//
// Scan every body for inline `[text](path)` links and reference-style
// `[text]: path` definitions whose target resolves to the queried path.
// External URLs and anchors are skipped. Wiki-link `[[Other]]` support
// would belong here too, but the demo's docs only use inline links so
// the simpler scanner is enough.

function computeBacklinks(targetPath: string): Backlink[] {
  if (!fileBodies.has(targetPath)) return [];
  const out: Backlink[] = [];
  const inlineLink = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const [sourcePath, body] of fileBodies.entries()) {
    if (sourcePath === targetPath) continue;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      inlineLink.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = inlineLink.exec(line)) !== null) {
        const resolved = resolveLinkTarget(match[2], sourcePath);
        if (resolved !== targetPath) continue;
        out.push({
          path: sourcePath,
          line: i + 1,
          column: match.index,
          snippet: line.trim(),
        });
      }
    }
  }
  out.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
  return out;
}

function resolveLinkTarget(target: string, sourcePath: string): string | null {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("//") ||
    target.startsWith("#")
  ) {
    return null;
  }
  // Strip query / hash so `features.md#features` resolves to `features.md`.
  const cleaned = target.split("#")[0].split("?")[0];
  if (!cleaned) return null;
  // Absolute project path.
  if (cleaned.startsWith("/")) return normalizeSegments(cleaned.slice(1));
  // Relative to the source file's directory.
  const sourceDir =
    sourcePath.lastIndexOf("/") >= 0
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)
      : "";
  return normalizeSegments(sourceDir + cleaned);
}

function normalizeSegments(path: string): string {
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  return segments.join("/");
}

// =========================== Line diff ===========================
//
// Classic LCS line diff. Cost is O(n*m) in lines; trivial for the
// website's docs (under ~80 lines each) and the snapshots they're
// compared against. The desktop core uses a more efficient algorithm
// for large files; if a future demo seeds bigger snapshots, swap this
// for an O(n + d*d) Myers diff.

function computeLineDiff(before: string, after: string): LineDiffRow[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const m = beforeLines.length;
  const n = afterLines.length;

  // lcs[i][j] = length of longest common subsequence of
  // beforeLines[0..i] and afterLines[0..j].
  const lcs: number[][] = new Array(m + 1);
  for (let i = 0; i <= m; i++) lcs[i] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] =
        beforeLines[i - 1] === afterLines[j - 1]
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Backtrack from the bottom-right corner. Tie-break on `added` first
  // (j-edge) so the side-by-side renderer's blank cells line up the
  // way the desktop diff feels: deletions appear left, additions
  // appear right, kept rows fill in between.
  const rows: LineDiffRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      rows.push({
        kind: "kept",
        before: beforeLines[i - 1],
        after: afterLines[j - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      rows.push({ kind: "added", before: null, after: afterLines[j - 1] });
      j--;
    } else {
      rows.push({ kind: "deleted", before: beforeLines[i - 1], after: null });
      i--;
    }
  }
  rows.reverse();
  return rows;
}

function defaultAppState(): AppUiState {
  return {
    schemaVersion: 1,
    lastOpenedProject: projectRoot,
    recentProjects: [],
    license: null,
    firstRunMs: Date.now(),
    personalDictionary: [],
    skipDeleteConfirmation: false,
    recentFiles: [],
    editorFont: "editorial" as EditorFontId,
    editorCustomFontFamily: "",
    editorFontSize: 17,
    editorLineHeightX100: 170,
    autoUpdateOnLaunch: false,
  };
}

// =========================== invoke dispatcher ===========================

type InvokeArgs = Record<string, unknown> | undefined;

function readFile(args: InvokeArgs): FileContent {
  const path = String((args as Record<string, unknown>)?.path ?? "");
  const body = fileBodies.get(path);
  if (body === undefined) {
    throw new Error(`File not found in web project: ${path}`);
  }
  return {
    path,
    body,
    frontmatter: fileFrontmatter.get(path) ?? {},
    modifiedMs: null,
  };
}

function writeFile(args: InvokeArgs): void {
  const a = (args ?? {}) as {
    path?: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
  };
  if (!a.path) return;
  if (typeof a.body === "string") {
    fileBodies.set(a.path, a.body);
    fileSizes.set(a.path, byteLength(a.body));
  }
  if (a.frontmatter && typeof a.frontmatter === "object") {
    fileFrontmatter.set(a.path, { ...a.frontmatter });
  }
}

function searchProject(args: InvokeArgs): SearchHit[] {
  const a = (args ?? {}) as { query?: string; options?: SearchOptions };
  const query = a.query ?? "";
  if (!query) return [];
  const caseSensitive = Boolean(a.options?.caseSensitive);
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];
  const sortedPaths = [...fileBodies.keys()].sort((p, q) => p.localeCompare(q));
  for (const path of sortedPaths) {
    const body = fileBodies.get(path) ?? "";
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const haystack = caseSensitive ? line : line.toLowerCase();
      let from = 0;
      while (from <= haystack.length) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        hits.push({
          path,
          lineNumber: i + 1,
          column: idx,
          matchLength: query.length,
          snippet: line,
        });
        from = idx + Math.max(needle.length, 1);
      }
    }
  }
  return hits;
}

function deletePath(args: InvokeArgs): void {
  const path = String((args as Record<string, unknown>)?.path ?? "");
  if (!path) return;
  // Treat as either a file or a directory prefix.
  const prefix = path.endsWith("/") ? path : path + "/";
  for (const key of [...fileBodies.keys()]) {
    if (key === path || key.startsWith(prefix)) {
      fileBodies.delete(key);
      fileFrontmatter.delete(key);
      fileSizes.delete(key);
    }
  }
}

function createFile(args: InvokeArgs): void {
  const path = String((args as Record<string, unknown>)?.path ?? "");
  if (!path) return;
  if (!fileBodies.has(path)) {
    fileBodies.set(path, "");
    fileFrontmatter.set(path, {});
    fileSizes.set(path, 0);
  }
}

function createDirectory(args: InvokeArgs): string {
  const a = (args ?? {}) as { parent?: string; name?: string };
  // Web project has no real directories; return the synthetic path so the
  // store treats the call as successful.
  const parent = a.parent ?? "";
  const name = a.name ?? "untitled";
  return parent ? `${parent}/${name}` : name;
}

function createSubdirectory(args: InvokeArgs): void {
  void args;
  // No-op: directories are implicit in the flat in-memory map.
}

function renameWithReferences(args: InvokeArgs): RenameReport {
  const a = (args ?? {}) as { oldPath?: string; newPath?: string };
  if (!a.oldPath || !a.newPath) {
    return { filesWritten: [], referencesUpdated: 0 };
  }
  const body = fileBodies.get(a.oldPath);
  if (body === undefined) {
    return { filesWritten: [], referencesUpdated: 0 };
  }
  const fm = fileFrontmatter.get(a.oldPath) ?? {};
  const sz = fileSizes.get(a.oldPath) ?? 0;
  fileBodies.delete(a.oldPath);
  fileFrontmatter.delete(a.oldPath);
  fileSizes.delete(a.oldPath);
  fileBodies.set(a.newPath, body);
  fileFrontmatter.set(a.newPath, fm);
  fileSizes.set(a.newPath, sz);
  return { filesWritten: [a.newPath], referencesUpdated: 0 };
}

function previewRename(args: InvokeArgs): RenamePreview {
  const a = (args ?? {}) as { newPath?: string; oldPath?: string };
  const targetExists =
    !!a.newPath && a.newPath !== a.oldPath && fileBodies.has(a.newPath);
  return { targetExists, references: [], definitionUpdates: [] };
}

function copyAttachment(args: InvokeArgs): string {
  // The desktop path copies a dropped file into the project's attachments
  // folder and returns a project-relative path. The web shim has no real
  // FS — drag-drop doesn't fire on web yet — so this returns a placeholder.
  // If/when web drag-drop lands we'll route blob URLs through here.
  void args;
  return "attachments/dropped-image.png";
}

/**
 * `invoke` mirrors the @tauri-apps/api/core export shape. Skrive code paths
 * that go through the desktop IPC bridge land here on web. Unknown commands
 * log a warning and return `undefined` so the caller can fall through its
 * own error handling.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
): Promise<T> {
  switch (cmd) {
    case "load_app_state":
      return defaultAppState() as T;
    case "save_app_state":
      return undefined as T;
    case "open_project":
      return buildManifest() as T;
    case "read_file":
      return readFile(args) as T;
    case "write_file":
      writeFile(args);
      return undefined as T;
    case "watch_project":
      return undefined as T;
    case "load_project_state":
      // null = no persisted state; the project store falls through to defaults.
      return null as T;
    case "save_project_state":
      return undefined as T;
    case "search_project":
      return searchProject(args) as T;
    case "create_file":
      createFile(args);
      return undefined as T;
    case "create_directory":
      return createDirectory(args) as T;
    case "create_subdirectory":
      createSubdirectory(args);
      return undefined as T;
    case "delete_path":
      deletePath(args);
      return undefined as T;
    case "rename_with_references":
      return renameWithReferences(args) as T;
    case "preview_rename":
      return previewRename(args) as T;
    case "copy_attachment":
      return copyAttachment(args) as T;
    case "get_history_mode":
      // "checkpoints" lets the history panel render the seeded snapshots
      // directly. "git" would route through a repo that isn't here.
      return "checkpoints" as HistoryMode as T;
    case "get_git_history":
      return [] as GitVersion[] as T;
    case "get_checkpoint_history": {
      const path = String((args as Record<string, unknown>)?.path ?? "");
      const stored = fileSnapshots.get(path) ?? [];
      // Newest-first per Skrive's contract — the history panel renders
      // top-to-bottom in that order.
      const rows: CheckpointVersion[] = stored
        .map((s) => ({
          id: s.id,
          timestampMs: s.timestampMs,
          kind: s.kind,
          name: s.name,
          contentHash: s.contentHash,
        }))
        .sort((a, b) => b.timestampMs - a.timestampMs);
      return rows as T;
    }
    case "read_git_version":
      return "" as T;
    case "read_checkpoint_version": {
      const id = String((args as Record<string, unknown>)?.id ?? "");
      for (const snaps of fileSnapshots.values()) {
        const found = snaps.find((s) => s.id === id);
        if (found) return found.content as T;
      }
      return "" as T;
    }
    case "compute_diff":
      // Structural diff is desktop-only; line diff is what the demo's
      // diff view actually consumes. Returning [] is harmless.
      return [] as DiffOp[] as T;
    case "compute_line_diff": {
      const a = (args ?? {}) as { before?: string; after?: string };
      return computeLineDiff(a.before ?? "", a.after ?? "") as T;
    }
    case "get_backlinks": {
      const path = String((args as Record<string, unknown>)?.path ?? "");
      return computeBacklinks(path) as T;
    }
    case "try_extract_frontmatter":
      // YAML parsing is nontrivial without a dependency; the shim skips
      // extraction. Visitors who paste `---` blocks will see them stay in
      // the body, which is acceptable for the demo surface.
      return null as T;
    case "take_pending_open_file":
      return null as OpenFileRequest | null as T;
    default:
      console.warn(`[skrive web shim] Unhandled invoke command: ${cmd}`);
      return undefined as T;
  }
}

/**
 * Pass-through for `convertFileSrc`. On desktop this rewrites a filesystem
 * path into an `asset:` URL the webview can fetch; on web we have no
 * filesystem, so the URL is returned unchanged. The image-render path's
 * `isExternalImageUrl` check still routes regular http(s) URLs correctly.
 */
export function convertFileSrc(filePath: string, _protocol?: string): string {
  return filePath;
}

// Re-export common types so call sites that import them through `core` keep
// resolving — matches Tauri's module surface.
export type { InvokeArgs };

// Bootstrap state types are also surfaced here so the host site can import
// `bootstrapWebProject` from `@tauri-apps/api/core` aliased path. (In
// practice the host imports via a more explicit route — see README of
// skrive.md.)
export type { ProjectUiState };
