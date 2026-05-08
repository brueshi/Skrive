// Git history reader. Shells out to the system `git` rather than
// pulling in libgit2 / nodegit / isomorphic-git — the read surface is
// two commands (`git log`, `git show`) and the binary is a hard
// dependency for git mode anyway. Spawning git also keeps the build
// smaller; the renderer's chrome doesn't pay for it in checkpoint
// projects.
//
// `--follow` is intentionally NOT used: rename detection on a renamed
// file gives a different history depending on the rename's similarity
// score, which makes the panel surprisingly inconsistent. v0.1.6 took
// the same posture ("path matching is exact") and a follow-up can add
// renames once dogfooding tells us it matters.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { GitVersion } from '@skrive/shared';

/** Subject\x1f and body delimiters chosen because they don't appear in
 *  any commit message we'd want to preserve. The pretty format emits
 *  one record per commit terminated by NUL so multi-line bodies don't
 *  confuse the parser. */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x00';
const PRETTY_FORMAT = [
  '%H', // sha
  '%P', // parent shas (space-separated)
  '%an',
  '%ae',
  '%at', // author timestamp, unix seconds
  '%s', // subject
  '%b' // body
].join(FIELD_SEP);

type SpawnResult = { code: number; stdout: string; stderr: string };

function runGit(root: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** True when the project root has a usable git repo. We check both for
 *  the `.git/` directory and for `git` actually working — a corrupted
 *  repo that fails `git rev-parse` should fall back to checkpoint mode
 *  rather than throw a panel-load error. */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path.join(root, '.git'));
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    const result = await runGit(root, ['rev-parse', '--git-dir']);
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Every commit that touches `relPath`, newest-first. An unborn HEAD
 *  (brand-new repo, zero commits) returns []. Other git failures
 *  surface as an empty list with a warning so the panel doesn't crash
 *  on a degraded repo state. */
export async function listGitCommitsForFile(
  root: string,
  relPath: string
): Promise<GitVersion[]> {
  // Quick guard: if HEAD doesn't exist (unborn), the log returns
  // non-zero. We special-case that vs. real failures by checking
  // rev-parse first.
  const headProbe = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (headProbe.code !== 0) return [];

  const result = await runGit(root, [
    'log',
    `--format=${PRETTY_FORMAT}%x00`,
    '--',
    relPath
  ]);
  if (result.code !== 0) {
    console.warn(
      `[skrive git] log failed for ${relPath}: ${result.stderr.trim()}`
    );
    return [];
  }

  const versions: GitVersion[] = [];
  // Records are NUL-separated. The trailing NUL leaves an empty final
  // record; filter it out.
  for (const record of result.stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n/, '');
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(FIELD_SEP);
    if (fields.length < 7) continue;
    const [sha, parents, authorName, authorEmail, atSec, subject, ...rest] =
      fields;
    const body = rest.join(FIELD_SEP);
    const parentSha =
      typeof parents === 'string' && parents.trim().length > 0
        ? (parents.trim().split(/\s+/)[0] ?? null)
        : null;
    const seconds = Number(atSec);
    if (!sha || !Number.isFinite(seconds)) continue;
    versions.push({
      sha,
      shortSha: sha.slice(0, 8),
      parentSha,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      timestampMs: seconds * 1000,
      subject: subject ?? '',
      body: (body ?? '').replace(/\n+$/, '')
    });
  }
  return versions;
}

/** Read the file's contents at `sha`. Returns the blob as a UTF-8
 *  string. Errors when the commit doesn't exist, the file isn't in
 *  that commit's tree, or the bytes aren't valid UTF-8 — the panel
 *  surfaces all three as "can't show this version". */
export async function readGitBlobAt(
  root: string,
  relPath: string,
  sha: string
): Promise<string> {
  if (!/^[0-9a-fA-F]+$/.test(sha) || sha.length < 4) {
    throw new Error(`invalid git sha: ${sha}`);
  }
  const result = await runGit(root, ['show', `${sha}:${relPath}`]);
  if (result.code !== 0) {
    throw new Error(`git show failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
