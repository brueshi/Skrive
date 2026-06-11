// The renderer-side project model (Stage 0.4 of the Zig shell plan).
// Consumes a project snapshot and derives everything the shell used to
// compute in the main process: manifest + frontmatter schema, the link
// graph and its queries, project search, and rename planning. Pure
// compute over in-memory state — hosted in a Worker by
// project-model.worker.ts, but directly testable here.
//
// The manifest-version semantics are ported intact from the shell's
// ProjectState: the version bumps ONLY on structure-relevant changes
// (the set of markdown paths changing, a file's frontmatter changing,
// or `.skrive.toml` changing), never on a content-only edit.

import {
  inferSchema,
  parseFrontmatter,
  parseSkriveToml,
  type Backlink,
  type DeadLink,
  type FileEntry,
  type FrontmatterMap,
  type OutgoingLink,
  type ProjectManifest,
  type ProjectSnapshot,
  type Reference,
  type RenamePreview,
  type SearchHit,
  type SearchOptions,
  type SkriveProjectConfig
} from '@skrive/shared';
import { extract } from './link-graph/extract';
import { LinkGraph } from './link-graph/graph';

export const MARKDOWN_EXT = /\.(md|markdown)$/i;
const SKRIVE_TOML = '.skrive.toml';
const SEARCH_HIT_CAP = 500;
// Snippet cap from the Rust port — long lines truncate with an ellipsis.
const SNIPPET_CAP = 80;

/** Per-file metadata the caller has in hand when upserting. Both fields
 *  are display-grade (sizeBytes has no UI consumer today), so the
 *  fallbacks — now() and the UTF-16 length — are acceptable when a
 *  watcher-driven read doesn't carry a stat. */
export type UpsertMeta = {
  modifiedMs?: number | null;
  sizeBytes?: number;
};

/** The full set of file rewrites a rename requires. The store applies
 *  `writes` via fs:writeFile (self-references write to the OLD path),
 *  then performs the fs:rename, then feeds the results back into the
 *  model — the plan itself mutates nothing. */
export type RenamePlan = {
  /** Post-edit bodies, keyed by their PRE-rename paths. */
  writes: Array<{ path: string; body: string }>;
  referencesUpdated: number;
};

function basenameOf(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

/** Lowercase stem of a project-relative path, or null if it has none. */
function stemOf(relPath: string): string | null {
  const base = basenameOf(relPath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base.toLowerCase() || null;
  return base.slice(0, dot).toLowerCase() || null;
}

function truncate(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_CAP) return trimmed;
  return trimmed.slice(0, SNIPPET_CAP - 1) + '…';
}

function readSnippet(body: string, line: number): string {
  const text = body.split('\n')[line];
  if (text === undefined) return '';
  return truncate(text);
}

/** Project-relative rewrite path from `sourceRelpath`'s directory to
 *  `targetRelpath`. Ported intact from the shell rename module. */
function relativeRewrite(sourceRelpath: string, targetRelpath: string): string {
  const sourceDir = sourceRelpath.split('/').filter(Boolean).slice(0, -1);
  const targetSegs = targetRelpath.split('/').filter(Boolean);

  let common = 0;
  while (
    common < sourceDir.length &&
    common < targetSegs.length &&
    sourceDir[common] === targetSegs[common]
  ) {
    common++;
  }
  const ups = sourceDir.length - common;
  const downs = targetSegs.slice(common);
  const out: string[] = [];
  for (let i = 0; i < ups; i++) out.push('..');
  for (const d of downs) out.push(d);
  if (out.length === 0) {
    return targetSegs[targetSegs.length - 1] ?? '';
  }
  return out.join('/');
}

function edgeMatches(
  edge: {
    target:
      | { kind: 'relative'; path: string }
      | { kind: 'wiki'; name: string };
  },
  oldPath: string,
  oldStem: string | null
): boolean {
  if (edge.target.kind === 'relative') {
    return edge.target.path === oldPath;
  }
  if (oldStem === null) return false;
  return edge.target.name.toLowerCase() === oldStem;
}

/** Structural equality for parsed frontmatter maps (YAML-derived, so
 *  JSON-shaped). Ported from the shell ProjectState. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
    );
  }
  return false;
}

function frontmatterEqual(a: FrontmatterMap, b: FrontmatterMap): boolean {
  return deepEqual(a, b);
}

/** Binary-search insertion index keeping `files` sorted by `path`. */
function sortedInsertIndex(files: FileEntry[], relPath: string): number {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (files[mid]!.path.localeCompare(relPath) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function utf16Length(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.length;
  return n;
}

export class ProjectModel {
  private root = '';
  /** Markdown bodies, keyed by project-relative path. */
  private bodies = new Map<string, string>();
  /** Non-markdown files (LICENSE, images, attachments). Present so
   *  link-target existence checks consider them; no graph entries. */
  private nonMarkdown = new Set<string>();
  private graph = new LinkGraph();
  /** Manifest entries, sorted by path. */
  private entries: FileEntry[] = [];
  private config: SkriveProjectConfig;
  private warnings: string[] = [];
  /** Monotonic, never reset — mirrors the shell's manifestVersion. */
  private version = 0;

  constructor() {
    this.config = parseSkriveToml(null).config;
  }

  init(snapshot: ProjectSnapshot): void {
    this.root = snapshot.root;
    this.bodies = new Map();
    this.nonMarkdown = new Set();
    this.graph = new LinkGraph();
    this.entries = [];

    let tomlSource: string | null = null;
    for (const file of snapshot.files) {
      if (file.path === SKRIVE_TOML) {
        tomlSource = file.body;
        continue;
      }
      if (file.body !== null && MARKDOWN_EXT.test(file.path)) {
        this.bodies.set(file.path, file.body);
        this.graph.setLinks(file.path, extract(file.body, file.path));
        this.entries.push({
          path: file.path,
          name: basenameOf(file.path),
          sizeBytes: file.sizeBytes,
          modifiedMs: file.modifiedMs,
          frontmatter: parseFrontmatter(file.body).frontmatter,
          outgoingLinks: []
        });
      } else {
        this.nonMarkdown.add(file.path);
      }
    }
    this.entries.sort((a, b) => a.path.localeCompare(b.path));

    const parsed = parseSkriveToml(tomlSource);
    this.config = parsed.config;
    this.warnings = parsed.warnings;
    this.version++;
  }

  manifest(): ProjectManifest {
    return {
      root: this.root,
      files: this.entries,
      schema: inferSchema(this.entries),
      config: this.config,
      warnings: this.warnings
    };
  }

  currentVersion(): number {
    return this.version;
  }

  /** Fold one changed file in. Returns true when the change was
   *  structure-relevant (the caller re-ships the manifest). */
  upsert(relPath: string, body: string, meta: UpsertMeta = {}): boolean {
    if (relPath === SKRIVE_TOML) {
      const parsed = parseSkriveToml(body.length === 0 ? null : body);
      this.config = parsed.config;
      this.warnings = parsed.warnings;
      this.version++;
      return true;
    }
    if (!MARKDOWN_EXT.test(relPath)) {
      this.nonMarkdown.add(relPath);
      return false;
    }

    this.bodies.set(relPath, body);
    this.graph.setLinks(relPath, extract(body, relPath));

    const entry: FileEntry = {
      path: relPath,
      name: basenameOf(relPath),
      sizeBytes: meta.sizeBytes ?? body.length,
      modifiedMs: meta.modifiedMs ?? Date.now(),
      frontmatter: parseFrontmatter(body).frontmatter,
      outgoingLinks: []
    };

    const existingIndex = this.entries.findIndex((f) => f.path === relPath);
    if (existingIndex === -1) {
      this.entries.splice(sortedInsertIndex(this.entries, relPath), 0, entry);
      this.version++;
      return true;
    }
    const prior = this.entries[existingIndex]!;
    const changed = !frontmatterEqual(prior.frontmatter, entry.frontmatter);
    this.entries[existingIndex] = entry;
    if (changed) this.version++;
    return changed;
  }

  /** Drop a file. Returns true when the manifest changed. */
  remove(relPath: string): boolean {
    if (relPath === SKRIVE_TOML) {
      const parsed = parseSkriveToml(null);
      this.config = parsed.config;
      this.warnings = parsed.warnings;
      this.version++;
      return true;
    }
    this.nonMarkdown.delete(relPath);
    if (!this.bodies.delete(relPath)) return false;
    this.graph.forget(relPath);
    const index = this.entries.findIndex((f) => f.path === relPath);
    if (index !== -1) this.entries.splice(index, 1);
    this.version++;
    return true;
  }

  private hasFile(relPath: string): boolean {
    return this.bodies.has(relPath) || this.nonMarkdown.has(relPath);
  }

  // ───────────────────────── Queries ─────────────────────────
  // Ported from shell/src/ipc/links.ts, with snippets read from the
  // in-memory bodies instead of disk.

  backlinks(target: string): Backlink[] {
    const out: Backlink[] = [];
    for (const source of this.graph.incoming(target)) {
      const edges = this.graph.outgoing(source);
      if (!edges) continue;
      const body = this.bodies.get(source) ?? '';
      for (const edge of edges) {
        if (edge.target.kind !== 'relative') continue;
        if (edge.target.path !== target) continue;
        out.push({
          source,
          range: edge.range,
          line: edge.line,
          column: edge.column,
          kind: edge.kind,
          snippet: readSnippet(body, edge.line)
        });
      }
    }
    return out;
  }

  outgoing(source: string): OutgoingLink[] {
    const edges = this.graph.outgoing(source);
    if (!edges) return [];
    const out: OutgoingLink[] = [];
    for (const edge of edges) {
      if (edge.target.kind === 'relative') {
        out.push({
          target: edge.target.path,
          targetKind: 'relative',
          range: edge.range,
          line: edge.line,
          column: edge.column,
          kind: edge.kind,
          resolved: this.hasFile(edge.target.path)
        });
      } else {
        out.push({
          target: edge.target.name,
          targetKind: 'wiki',
          range: edge.range,
          line: edge.line,
          column: edge.column,
          kind: edge.kind,
          // Wiki targets aren't path-resolved at extraction; mark as
          // resolved so they don't surface as dead links by accident.
          resolved: true
        });
      }
    }
    return out;
  }

  deadLinks(): DeadLink[] {
    const out: DeadLink[] = [];
    for (const [source, edges] of this.graph.iter()) {
      for (const edge of edges) {
        if (edge.target.kind !== 'relative') continue;
        if (this.hasFile(edge.target.path)) continue;
        out.push({
          source,
          target: edge.target.path,
          range: edge.range,
          line: edge.line,
          column: edge.column,
          kind: edge.kind
        });
      }
    }
    return out;
  }

  orphanedFiles(): string[] {
    return this.graph.orphanedAmong(new Set(this.bodies.keys()));
  }

  // ───────────────────────── Search ─────────────────────────
  // Ported from shell/src/ipc/search.ts: capped hits, 1-indexed lines,
  // UTF-16 columns, CRLF-safe snippets, path/line/column sort.

  search(query: string, options: SearchOptions): SearchHit[] {
    if (query.length === 0) return [];

    const needle = options.caseSensitive ? query : query.toLowerCase();
    const matchLength = utf16Length(needle);
    const hits: SearchHit[] = [];

    const paths = Array.from(this.bodies.keys()).sort((a, b) =>
      a.localeCompare(b)
    );

    outer: for (const rel of paths) {
      const body = this.bodies.get(rel)!;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const original = lines[i] ?? '';
        const line = original.endsWith('\r')
          ? original.slice(0, -1)
          : original;
        const haystack = options.caseSensitive ? line : line.toLowerCase();

        let cursor = 0;
        while (cursor <= haystack.length) {
          const at = haystack.indexOf(needle, cursor);
          if (at < 0) break;
          hits.push({
            path: rel,
            line: i + 1,
            column: haystack.slice(0, at).length,
            matchLength,
            snippet: line
          });
          if (hits.length >= SEARCH_HIT_CAP) break outer;
          cursor = at + Math.max(needle.length, 1);
        }
      }
    }

    hits.sort((a, b) => {
      const byPath = a.path.localeCompare(b.path);
      if (byPath !== 0) return byPath;
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    return hits;
  }

  // ───────────────────────── Rename ─────────────────────────
  // Ported from shell/src/lib/link-graph/rename.ts, planning only: the
  // worker has every body, so preview and plan are pure; the store owns
  // the filesystem side (writes, then the rename).

  previewRename(oldPath: string, newPath: string): RenamePreview {
    const targetExists = newPath === oldPath || this.hasFile(newPath);

    const oldStem = stemOf(oldPath);
    const references: Reference[] = [];
    const definitionUpdates: Reference[] = [];

    for (const [source, edges] of this.graph.iter()) {
      const body = this.bodies.get(source);
      if (body === undefined) continue;
      for (const edge of edges) {
        if (!edgeMatches(edge, oldPath, oldStem)) continue;
        const ref: Reference = {
          path: source,
          // 1-indexed for the UI.
          line: edge.line + 1,
          column: edge.column + 1,
          snippet: readSnippet(body, edge.line),
          kind: edge.kind
        };
        if (source === oldPath) {
          definitionUpdates.push(ref);
        } else {
          references.push(ref);
        }
      }
    }

    references.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column
    );
    definitionUpdates.sort((a, b) => a.line - b.line || a.column - b.column);

    return { targetExists, references, definitionUpdates };
  }

  renamePlan(oldPath: string, newPath: string): RenamePlan {
    if (oldPath === newPath) {
      throw new Error('rename target must differ from the current path');
    }
    if (!MARKDOWN_EXT.test(oldPath) || !MARKDOWN_EXT.test(newPath)) {
      throw new Error('rename only operates on markdown files');
    }
    for (const seg of newPath.split('/')) {
      if (seg === '..' || seg === '') {
        throw new Error(`Path escapes project root: ${newPath}`);
      }
    }
    if (!this.bodies.has(oldPath)) {
      throw new Error(`Source does not exist: ${oldPath}`);
    }
    if (this.hasFile(newPath)) {
      throw new Error(`${newPath} already exists`);
    }

    const oldStem = stemOf(oldPath);
    const writes: RenamePlan['writes'] = [];
    let totalEdits = 0;

    for (const [source, edges] of this.graph.iter()) {
      const perFile: Array<{ start: number; end: number; replacement: string }> =
        [];
      for (const edge of edges) {
        if (edge.kind === 'referenceUse') continue; // label-anchored
        if (!edgeMatches(edge, oldPath, oldStem)) continue;

        let replacement: string;
        if (edge.kind === 'inline' || edge.kind === 'referenceDefinition') {
          replacement = relativeRewrite(source, newPath);
        } else if (edge.kind === 'wiki') {
          const newStem = stemOf(newPath);
          if (!newStem) continue;
          // Preserve the original case of the new stem for the rewrite.
          const baseName = basenameOf(newPath);
          const dot = baseName.lastIndexOf('.');
          replacement = dot > 0 ? baseName.slice(0, dot) : baseName;
        } else {
          continue;
        }
        perFile.push({ ...edge.range, replacement });
        totalEdits++;
      }
      if (perFile.length === 0) continue;

      let body = this.bodies.get(source);
      if (body === undefined) continue;
      // Back-to-front so earlier ranges don't shift under later edits.
      const sorted = [...perFile].sort((a, b) => b.start - a.start);
      for (const e of sorted) {
        body = body.slice(0, e.start) + e.replacement + body.slice(e.end);
      }
      writes.push({ path: source, body });
    }

    return { writes, referencesUpdated: totalEdits };
  }
}
