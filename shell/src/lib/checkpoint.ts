// Skrive-managed checkpoint history.
//
// Mirrors the on-disk contract from `docs/checkpoint-storage.md` and
// the algorithm in `src-tauri/src/history.rs` exactly: filenames stay
// portable across v0.1.6 (Tauri) and v0.2 (Electron), so an existing
// user who upgrades sees their pinned drafts survive the port.
//
// Filenames:
//   {timestampMs:13}_auto.md
//   {timestampMs:13}_manual_{slug}.md
//   {timestampMs:13}_manual_{slug}_{disambiguator}.md  (collision rename)
//
// Plus a per-manual `.name` sidecar that preserves the user's original
// typing (case + punctuation). The reader prefers the sidecar over the
// slug for display.

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  type CheckpointKind,
  type CheckpointVersion
} from '@skrive/shared';

/** Auto-checkpoint cadence in ms. The writer skips a new auto when the
 *  most recent auto for the same file is younger than this. Mirrors
 *  the Rust constant. */
const AUTO_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

/** Cap on the slug portion before truncation. Keeps the on-disk
 *  filename well under any platform's per-component limit. */
const SLUG_MAX_LEN = 40;

type CheckpointFile = {
  fullPath: string;
  /** Filename stem (everything before `.md`). The opaque public id. */
  id: string;
  timestampMs: number;
  kind: CheckpointKind;
  /** Slug portion of a manual filename; empty for auto. */
  slug: string;
};

// ============================ Path helpers ============================

/** First 16 hex chars of SHA-256 of the canonical project path. Same
 *  algorithm the persistence layer uses so the project's checkpoint
 *  directory is co-located with its `projects/{hash}.json`. */
function hashProjectPath(canonicalProjectPath: string): string {
  return createHash('sha256')
    .update(canonicalProjectPath)
    .digest('hex')
    .slice(0, 16);
}

/** First 16 hex chars of SHA-256 of a project-relative file path,
 *  normalized to forward slashes. Windows and Unix produce the same
 *  hash for the same logical file. A relpath change (rename) orphans
 *  the old file's checkpoint history — see `docs/checkpoint-storage.md`. */
function hashFileRelPath(relPath: string): string {
  return createHash('sha256')
    .update(relPath.replace(/\\/g, '/'))
    .digest('hex')
    .slice(0, 16);
}

export function checkpointDirFor(
  userDataDir: string,
  canonicalProjectPath: string,
  relPath: string
): string {
  return path.join(
    userDataDir,
    'projects',
    hashProjectPath(canonicalProjectPath),
    'checkpoints',
    hashFileRelPath(relPath)
  );
}

// ============================ Filename parsing ============================

function parseCheckpointFilename(
  name: string
): { timestampMs: number; kind: CheckpointKind; slug: string } | null {
  if (!name.endsWith('.md')) return null;
  const stem = name.slice(0, -3);
  const firstUnderscore = stem.indexOf('_');
  if (firstUnderscore !== 13) return null;
  const tsPart = stem.slice(0, 13);
  if (!/^\d{13}$/.test(tsPart)) return null;
  const timestampMs = Number(tsPart);
  if (!Number.isFinite(timestampMs)) return null;
  const rest = stem.slice(14);
  let kindToken: string;
  let slug: string;
  const sepIdx = rest.indexOf('_');
  if (sepIdx < 0) {
    kindToken = rest;
    slug = '';
  } else {
    kindToken = rest.slice(0, sepIdx);
    slug = rest.slice(sepIdx + 1);
  }
  let kind: CheckpointKind;
  if (kindToken === 'auto') kind = 'auto';
  else if (kindToken === 'manual') kind = 'manual';
  else return null;
  return { timestampMs, kind, slug };
}

function formatManualFilename(
  timestampMs: number,
  slug: string,
  disambiguator: number
): string {
  const suffix = disambiguator === 0 ? '' : `_${disambiguator}`;
  const ts = String(timestampMs).padStart(13, '0');
  return `${ts}_manual_${slug}${suffix}.md`;
}

function formatAutoFilename(timestampMs: number): string {
  const ts = String(timestampMs).padStart(13, '0');
  return `${ts}_auto.md`;
}

// ============================ Slugify ============================

/** Lowercase, whitespace runs collapse to `-`, non-alphanumeric stripped,
 *  hyphens collapsed, leading/trailing trimmed, capped at SLUG_MAX_LEN
 *  characters. Empty result falls back to "pinned" so the filename
 *  still parses. Mirrors the Rust impl. */
export function slugify(name: string): string {
  const lowered = name.trim().toLowerCase();
  let out = '';
  let lastWasDash = false;
  for (const ch of lowered) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      lastWasDash = false;
    } else if (/\s|-|_/.test(ch)) {
      if (!lastWasDash && out.length > 0) {
        out += '-';
        lastWasDash = true;
      }
    }
  }
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out.length > SLUG_MAX_LEN) {
    out = out.slice(0, SLUG_MAX_LEN);
    while (out.endsWith('-')) out = out.slice(0, -1);
  }
  return out.length === 0 ? 'pinned' : out;
}

// ============================ Hash + sidecar helpers ============================

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function nameSidecarPath(checkpointFullPath: string): string {
  return checkpointFullPath.replace(/\.md$/, '.name');
}

async function readNameSidecar(
  checkpointFullPath: string
): Promise<string | null> {
  try {
    return await fsp.readFile(nameSidecarPath(checkpointFullPath), 'utf8');
  } catch {
    return null;
  }
}

async function writeNameSidecar(
  checkpointFullPath: string,
  name: string
): Promise<void> {
  await fsp.writeFile(nameSidecarPath(checkpointFullPath), name, 'utf8');
}

// ============================ Listing ============================

async function listCheckpointFiles(dir: string): Promise<CheckpointFile[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: CheckpointFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseCheckpointFilename(entry.name);
    if (!parsed) continue;
    out.push({
      fullPath: path.join(dir, entry.name),
      id: entry.name.slice(0, -3),
      timestampMs: parsed.timestampMs,
      kind: parsed.kind,
      slug: parsed.slug
    });
  }
  return out;
}

/** Every checkpoint on disk for a file, newest-first. Reads each file's
 *  content to compute `contentHash`. The files are small (markdown);
 *  the reader only runs when the panel opens, so per-call cost is
 *  negligible against the readability win of a ready-to-use hash. */
export async function listCheckpointsForFile(
  userDataDir: string,
  canonicalProjectPath: string,
  relPath: string
): Promise<CheckpointVersion[]> {
  const dir = checkpointDirFor(userDataDir, canonicalProjectPath, relPath);
  const files = await listCheckpointFiles(dir);
  files.sort((a, b) => b.timestampMs - a.timestampMs);
  const out: CheckpointVersion[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = await fsp.readFile(f.fullPath, 'utf8');
    } catch {
      continue;
    }
    const name = f.kind === 'manual' ? await readNameSidecar(f.fullPath) : null;
    out.push({
      id: f.id,
      timestampMs: f.timestampMs,
      kind: f.kind,
      name,
      contentHash: hashContent(content)
    });
  }
  return out;
}

/** Read a checkpoint by its opaque id. Validates the id against the
 *  filename shape so a malicious or malformed id (`../../escape`)
 *  cannot read outside the checkpoint directory. */
export async function readCheckpointAt(
  userDataDir: string,
  canonicalProjectPath: string,
  relPath: string,
  id: string
): Promise<string> {
  if (parseCheckpointFilename(`${id}.md`) === null) {
    throw new Error(`invalid checkpoint id: ${id}`);
  }
  const dir = checkpointDirFor(userDataDir, canonicalProjectPath, relPath);
  return fsp.readFile(path.join(dir, `${id}.md`), 'utf8');
}

// ============================ Writers ============================

/** Auto-checkpoint writer. Called from the fs:writeFile handler after
 *  a successful on-disk write; silent no-op when the project is in
 *  git mode. Honors the 5-minute interval and content-hash dedup from
 *  the design doc:
 *
 *   - If the most-recent auto is newer than AUTO_CHECKPOINT_INTERVAL_MS,
 *     skip.
 *   - If the most-recent checkpoint (any kind) shares the new content
 *     hash, skip.
 *   - Otherwise write `{nowMs}_auto.md` and prune old autos beyond
 *     `autoCap`.
 *
 *  All filesystem failures degrade to a logged warning rather than
 *  bubbling out — an unreachable userData dir, a full disk, or a lock
 *  contention from another process shouldn't make the editor fail
 *  mid-save. */
export async function maybeWriteAutoCheckpoint(
  userDataDir: string,
  canonicalProjectPath: string,
  relPath: string,
  content: string,
  autoCap: number
): Promise<void> {
  const dir = checkpointDirFor(userDataDir, canonicalProjectPath, relPath);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await maybeWriteAutoCheckpointAt(dir, content, Date.now(), autoCap);
  } catch (err) {
    console.warn(
      `[skrive] auto-checkpoint write failed for ${relPath}:`,
      err
    );
  }
}

/** Core of the auto-checkpoint write, factored to take the resolved
 *  directory and a caller-supplied `nowMs` so tests can drive every
 *  branch from a temp dir without standing up Electron. */
export async function maybeWriteAutoCheckpointAt(
  dir: string,
  content: string,
  nowMs: number,
  autoCap: number
): Promise<void> {
  const existing = await listCheckpointFiles(dir);

  let lastAuto: CheckpointFile | null = null;
  for (const f of existing) {
    if (f.kind !== 'auto') continue;
    if (!lastAuto || f.timestampMs > lastAuto.timestampMs) lastAuto = f;
  }
  if (lastAuto && nowMs - lastAuto.timestampMs < AUTO_CHECKPOINT_INTERVAL_MS) {
    return;
  }

  const newHash = hashContent(content);
  let mostRecent: CheckpointFile | null = null;
  for (const f of existing) {
    if (!mostRecent || f.timestampMs > mostRecent.timestampMs) mostRecent = f;
  }
  if (mostRecent) {
    try {
      const prev = await fsp.readFile(mostRecent.fullPath, 'utf8');
      if (hashContent(prev) === newHash) return;
    } catch {
      // Couldn't read the most-recent file — write the new one anyway
      // rather than blocking on a transient read error.
    }
  }

  const target = path.join(dir, formatAutoFilename(nowMs));
  await fsp.writeFile(target, content, 'utf8');
  await pruneAutoCheckpoints(dir, autoCap);
}

/** Manual ("pinned") checkpoint writer. Never dedups — pinning is an
 *  explicit user act even when content hasn't changed. Filename
 *  collisions (same timestamp + same slug, possible on rapid pins or
 *  clock skew) get a `_2`, `_3`, ... disambiguator. After write,
 *  prunes manuals beyond `manualCap`; `manualCap == 0` means
 *  unbounded (the default). */
export async function createManualCheckpoint(
  userDataDir: string,
  canonicalProjectPath: string,
  relPath: string,
  name: string,
  content: string,
  manualCap: number
): Promise<void> {
  const dir = checkpointDirFor(userDataDir, canonicalProjectPath, relPath);
  await fsp.mkdir(dir, { recursive: true });
  await createManualCheckpointAt(dir, name, content, Date.now(), manualCap);
}

export async function createManualCheckpointAt(
  dir: string,
  name: string,
  content: string,
  nowMs: number,
  manualCap: number
): Promise<void> {
  const slug = slugify(name);
  let target = path.join(dir, formatManualFilename(nowMs, slug, 0));
  let disambiguator = 2;
  while (await pathExists(target)) {
    target = path.join(dir, formatManualFilename(nowMs, slug, disambiguator));
    disambiguator += 1;
  }
  await fsp.writeFile(target, content, 'utf8');
  // Sidecar write is best-effort — a failed sidecar doesn't undo a
  // successful checkpoint, just means the reader falls back to the
  // slug-derived name.
  try {
    await writeNameSidecar(target, name);
  } catch (err) {
    console.warn(
      `[skrive] checkpoint name sidecar write failed for ${target}:`,
      err
    );
  }
  await pruneManualCheckpoints(dir, manualCap);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ============================ Retention ============================

async function pruneAutoCheckpoints(dir: string, cap: number): Promise<void> {
  const files = (await listCheckpointFiles(dir)).filter(
    (f) => f.kind === 'auto'
  );
  if (files.length <= cap) return;
  files.sort((a, b) => b.timestampMs - a.timestampMs);
  for (const stale of files.slice(cap)) {
    try {
      await fsp.unlink(stale.fullPath);
    } catch (err) {
      console.warn(
        `[skrive] auto-checkpoint prune failed for ${stale.fullPath}:`,
        err
      );
    }
  }
}

async function pruneManualCheckpoints(
  dir: string,
  cap: number
): Promise<void> {
  if (cap === 0) return;
  const files = (await listCheckpointFiles(dir)).filter(
    (f) => f.kind === 'manual'
  );
  if (files.length <= cap) return;
  files.sort((a, b) => b.timestampMs - a.timestampMs);
  for (const stale of files.slice(cap)) {
    // Sidecar delete is best-effort — a leftover `.name` file next to
    // a deleted checkpoint is harmless; the reader ignores it.
    try {
      await fsp.unlink(nameSidecarPath(stale.fullPath));
    } catch {
      // Sidecar may not exist (legacy / failed write earlier).
    }
    try {
      await fsp.unlink(stale.fullPath);
    } catch (err) {
      console.warn(
        `[skrive] manual-checkpoint prune failed for ${stale.fullPath}:`,
        err
      );
    }
  }
}
