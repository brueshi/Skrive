// Rename-with-references — read the link graph, decide what gets
// rewritten, do the rewrites + the file rename atomically (best-effort:
// the rename happens before the rewrites; a crash mid-rewrite leaves
// the renamed file in place and the rewrites partial. Same shape as
// the Rust port — see src-tauri/src/project.rs::rename_with_references).
//
// Three edge kinds drive different rewrite rules:
//
//   - `inline`              → relative path from source dir to new path
//   - `referenceDefinition` → relative path from source dir to new path
//   - `wiki`                → new file's stem (filename without ext);
//                             matches how the reader resolves wiki links
//   - `referenceUse`        → not rewritten. Uses reference the label,
//                             not the path; the definition's rewrite
//                             re-points the use transparently.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Reference, RenamePreview, RenameReport } from '@skrive/shared';
import { extract } from './extract';
import type { LinkGraph } from './graph';

// Snippet cap from the Rust port — long lines truncate with an ellipsis.
const SNIPPET_CAP = 80;

export type RenameContext = {
  /** Absolute project root. */
  root: string;
  graph: LinkGraph;
  filePaths: Set<string>;
};

/** Lowercase stem of a project-relative path, or null if it has none. */
function stemOf(relPath: string): string | null {
  const base = relPath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base.toLowerCase() || null;
  return base.slice(0, dot).toLowerCase() || null;
}

/** Trim + truncate a line for snippet display. Multi-byte safe — JS
 *  strings already operate on code units, so .slice is correct. */
function truncate(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_CAP) return trimmed;
  return trimmed.slice(0, SNIPPET_CAP - 1) + '…';
}

/** Read the line at index `line` from `body`, returning a UI-ready
 *  snippet. Returns the empty string when the line is past the doc. */
function readSnippet(body: string, line: number): string {
  const lines = body.split('\n');
  const text = lines[line];
  if (text === undefined) return '';
  return truncate(text);
}

/** Compute the project-relative path the rewriter should emit at
 *  `sourceRelpath` to point at `targetRelpath`. Sibling becomes a bare
 *  filename; same-subtree drops the prefix; elsewhere prefixes with
 *  `..` segments back to the common ancestor. Mirrors the Rust port's
 *  `relative_path`. */
function relativeRewrite(
  sourceRelpath: string,
  targetRelpath: string
): string {
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
    // Source and target collapse to the same file — shouldn't happen,
    // since rename validates old !== new, but emit the bare filename
    // as the safest fallback.
    return targetSegs[targetSegs.length - 1] ?? '';
  }
  return out.join('/');
}

export async function previewRename(
  ctx: RenameContext,
  oldPath: string,
  newPath: string
): Promise<RenamePreview> {
  const targetExists =
    newPath === oldPath ||
    ctx.filePaths.has(newPath) ||
    (await pathExists(path.join(ctx.root, newPath)));

  const oldStem = stemOf(oldPath);
  const references: Reference[] = [];
  const definitionUpdates: Reference[] = [];

  for (const [source, edges] of ctx.graph.iter()) {
    let body: string | null = null;
    for (const edge of edges) {
      const matches = edgeMatches(edge, oldPath, oldStem);
      if (!matches) continue;

      if (body === null) {
        body = await readSourceBody(ctx.root, source);
      }
      if (body === null) continue;

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
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column
  );
  definitionUpdates.sort((a, b) => a.line - b.line || a.column - b.column);

  return { targetExists, references, definitionUpdates };
}

export async function renameWithReferences(
  ctx: RenameContext,
  oldPath: string,
  newPath: string
): Promise<RenameReport> {
  if (oldPath === newPath) {
    throw new Error('rename target must differ from the current path');
  }
  if (!isMarkdown(oldPath) || !isMarkdown(newPath)) {
    throw new Error('rename only operates on markdown files');
  }
  // Reject parent traversal in the new path; the fs:rename equivalent
  // would too, but the early check produces a cleaner error.
  for (const seg of newPath.split('/')) {
    if (seg === '..' || seg === '') {
      throw new Error(`Path escapes project root: ${newPath}`);
    }
  }

  const oldAbs = path.join(ctx.root, oldPath);
  const newAbs = path.join(ctx.root, newPath);

  if (!(await pathExists(oldAbs))) {
    throw new Error(`Source does not exist: ${oldPath}`);
  }
  if (await pathExists(newAbs)) {
    throw new Error(`${newPath} already exists`);
  }

  const oldStem = stemOf(oldPath);

  // Build the edit plan over the pre-rename graph. SourceEdit's path
  // is the pre-rename source path; for the renamed file itself we
  // remap to newPath when writing.
  type SourceEdit = {
    sourcePath: string;
    edits: Array<{ start: number; end: number; replacement: string }>;
  };
  const plans: SourceEdit[] = [];
  let totalEdits = 0;

  for (const [source, edges] of ctx.graph.iter()) {
    const perFile: SourceEdit['edits'] = [];
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
        const baseName = newPath.split('/').pop() ?? '';
        const dot = baseName.lastIndexOf('.');
        replacement = dot > 0 ? baseName.slice(0, dot) : baseName;
      } else {
        continue;
      }
      perFile.push({ ...edge.range, replacement });
      totalEdits++;
    }
    if (perFile.length > 0) plans.push({ sourcePath: source, edits: perFile });
  }

  // Move the file before rewriting. After this point any failure is a
  // partial application — same posture as the Rust port.
  await fsp.mkdir(path.dirname(newAbs), { recursive: true });
  await fsp.rename(oldAbs, newAbs);

  const filesWritten: string[] = [];

  for (const plan of plans) {
    const effective = plan.sourcePath === oldPath ? newPath : plan.sourcePath;
    const absolute = path.join(ctx.root, effective);
    let body = await fsp.readFile(absolute, 'utf8');

    // Back-to-front so earlier ranges don't shift under later edits.
    const sorted = [...plan.edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      body = body.slice(0, e.start) + e.replacement + body.slice(e.end);
    }
    await fsp.writeFile(absolute, body, 'utf8');
    filesWritten.push(effective);
  }

  // Move the renamed file's graph entry from oldPath to newPath. This
  // happens regardless of whether the renamed file had self-edits —
  // backlinks / dead-links / a follow-up rename all key off newPath.
  ctx.filePaths.delete(oldPath);
  ctx.graph.forget(oldPath);
  ctx.filePaths.add(newPath);
  const newBody = await fsp.readFile(newAbs, 'utf8');
  ctx.graph.setLinks(newPath, extract(newBody, newPath));

  // Plus refresh every other rewritten source so its edges reflect
  // the new target paths.
  for (const written of filesWritten) {
    if (written === newPath) continue;
    const body = await fsp.readFile(path.join(ctx.root, written), 'utf8');
    ctx.graph.setLinks(written, extract(body, written));
  }

  return { filesWritten, referencesUpdated: totalEdits };
}

// ─────────────────────────── Helpers ───────────────────────────

function isMarkdown(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function readSourceBody(
  root: string,
  source: string
): Promise<string | null> {
  try {
    return await fsp.readFile(path.join(root, source), 'utf8');
  } catch {
    return null;
  }
}

function edgeMatches(
  edge: { target: { kind: 'relative'; path: string } | { kind: 'wiki'; name: string } },
  oldPath: string,
  oldStem: string | null
): boolean {
  if (edge.target.kind === 'relative') {
    return edge.target.path === oldPath;
  }
  if (oldStem === null) return false;
  return edge.target.name.toLowerCase() === oldStem;
}
