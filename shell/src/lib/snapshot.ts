// The project walk and the batched snapshot scan (Zig shell plan,
// Stage 0.4). Pure node — no Electron imports — so the scan rules are
// unit-testable and the walk is shared between the legacy full scan in
// ipc/project.ts and the snapshot command that replaces it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectSnapshot, SnapshotFile } from '@skrive/shared';
import { contentHash } from './atomic-write';

// Hardcoded skip list per `planning/open-questions.md` P3. Phase 3.4
// will layer `.gitignore` and `.skrive.toml` `[project].exclude` on top
// of this — for v0.2 the hardcoded list covers the 95% case.
export const NOISE_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '__pycache__',
  'venv',
  '.git',
  '.svelte-kit',
  '.next',
  'out',
  '.DS_Store'
]);

export const MARKDOWN_EXT = /\.(md|markdown)$/i;

export function toForwardSlash(p: string): string {
  return p.split(path.sep).join('/');
}

export type WalkEntry = { fullPath: string; isMarkdown: boolean };

export async function* walk(
  root: string,
  current: string
): AsyncGenerator<WalkEntry> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (NOISE_DIRS.has(entry.name)) continue;
      // Skip hidden directories (dot-prefixed) too — they're rarely
      // prose-bearing and a writer with a `.archive/` of drafts can
      // override later via `.skrive.toml` [project].exclude.
      if (entry.name.startsWith('.')) continue;
      yield* walk(root, full);
    } else if (entry.isFile()) {
      // Skip dot-files (.DS_Store, .gitignore, etc.) and noise files
      // by name; everything else gets yielded so link-target checks
      // can see non-markdown siblings (LICENSE, images, attachments).
      if (entry.name.startsWith('.')) continue;
      yield { fullPath: full, isMarkdown: MARKDOWN_EXT.test(entry.name) };
    }
  }
}

/** Build one SnapshotFile from disk. Markdown gets its body + hash; an
 *  unreadable-but-statable markdown file degrades to an empty body
 *  (same lenient posture as the legacy scan). Non-markdown is listed
 *  with `body: null`. Returns null when the file vanished. */
async function snapshotFile(
  root: string,
  relPath: string,
  withBody: boolean
): Promise<SnapshotFile | null> {
  const fullPath = path.join(root, relPath);

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return null;
  }

  if (!withBody) {
    return {
      path: relPath,
      body: null,
      modifiedMs: stat.mtimeMs ?? null,
      hash: null,
      sizeBytes: stat.size
    };
  }

  let body = '';
  try {
    body = await fs.readFile(fullPath, 'utf8');
  } catch {
    // Stat succeeded but the read didn't — keep the entry, empty body.
  }
  return {
    path: relPath,
    body,
    modifiedMs: stat.mtimeMs ?? null,
    hash: contentHash(body),
    sizeBytes: stat.size
  };
}

/** Scan a project into one batched snapshot. Includes every file the
 *  walk yields (markdown with bodies, assets with `body: null`), plus
 *  `.skrive.toml` at the root when present — the walk's dot-file skip
 *  is a noise rule, and the renderer needs the config source to derive
 *  the manifest. Files are sorted by path for determinism. */
export async function scanSnapshot(root: string): Promise<ProjectSnapshot> {
  const canonicalRoot = path.resolve(root);
  const files: SnapshotFile[] = [];

  for await (const { fullPath, isMarkdown } of walk(
    canonicalRoot,
    canonicalRoot
  )) {
    const rel = toForwardSlash(path.relative(canonicalRoot, fullPath));
    const file = await snapshotFile(canonicalRoot, rel, isMarkdown);
    if (file) files.push(file);
  }

  const toml = await snapshotFile(canonicalRoot, '.skrive.toml', true);
  if (toml) files.push(toml);

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: canonicalRoot, files };
}
