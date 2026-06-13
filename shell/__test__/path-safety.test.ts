// Symlink-safe path containment (Stage 0.5). Builds a real fixture tree
// with on-disk symlinks and asserts the five attack shapes from the Zig
// shell plan are rejected with PATH_ESCAPE while ordinary nested paths
// pass. This fixture tree is reused verbatim by the Zig core in Stage 2,
// so it is the cross-implementation oracle for the algorithm — keep the
// shapes stable.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSafe } from '../src/lib/path-safety';

// Layout (sandbox is the realpath'd temp parent so comparisons are
// canonical on macOS where /var -> /private/var):
//   sandbox/
//     outside/                 <- OUTSIDE the project root
//       secret.md
//       subdir/
//     root/                    <- the project root
//       inside.md
//       notes/a.md
//       linkDir   -> sandbox/outside/subdir   (in-root symlink to out dir)
//       linkFile.md -> sandbox/outside/secret.md (in-root symlink to out file)
let sandbox: string;
let root: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'skrive-pathsafe-')));
  const outside = path.join(sandbox, 'outside');
  root = path.join(sandbox, 'root');
  mkdirSync(path.join(outside, 'subdir'), { recursive: true });
  writeFileSync(path.join(outside, 'secret.md'), 'TOP SECRET');
  mkdirSync(path.join(root, 'notes'), { recursive: true });
  writeFileSync(path.join(root, 'inside.md'), 'inside');
  writeFileSync(path.join(root, 'notes', 'a.md'), '# A');
  symlinkSync(path.join(outside, 'subdir'), path.join(root, 'linkDir'));
  symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linkFile.md'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

async function expectEscape(relPath: string): Promise<void> {
  await expect(resolveSafe(root, relPath)).rejects.toMatchObject({
    code: 'PATH_ESCAPE'
  });
}

describe('resolveSafe — the five attack shapes', () => {
  it('1. rejects an in-root symlink to an out-of-root directory', async () => {
    // Reading through it AND creating under it both escape.
    await expectEscape('linkDir/leak.md');
    await expectEscape('linkDir/new-file.md');
  });

  it('2. rejects an in-root symlink to an out-of-root file', async () => {
    await expectEscape('linkFile.md');
  });

  it('3. rejects `..` traversal', async () => {
    await expectEscape('../outside/secret.md');
    await expectEscape('notes/../../outside/secret.md');
  });

  it('4. rejects absolute paths', async () => {
    await expectEscape('/etc/passwd');
    await expectEscape(path.join(sandbox, 'outside', 'secret.md'));
  });

  it('5. rejects NUL bytes', async () => {
    await expectEscape('a\0b.md');
    await expectEscape('notes/\0.md');
  });
});

describe('resolveSafe — legitimate paths still resolve', () => {
  it('resolves a root-level file', async () => {
    const target = await resolveSafe(root, 'inside.md');
    expect(target).toBe(path.join(root, 'inside.md'));
  });

  it('resolves an existing nested file', async () => {
    const target = await resolveSafe(root, 'notes/a.md');
    expect(target).toBe(path.join(root, 'notes', 'a.md'));
  });

  it('resolves a not-yet-created file under an existing dir (create path)', async () => {
    const target = await resolveSafe(root, 'notes/new.md');
    expect(target).toBe(path.join(root, 'notes', 'new.md'));
  });

  it('resolves a file under a not-yet-created subtree (recursive create)', async () => {
    const target = await resolveSafe(root, 'deep/dir/new.md');
    expect(target).toBe(path.join(root, 'deep', 'dir', 'new.md'));
  });

  it('treats the root path itself (empty relPath) as contained', async () => {
    const target = await resolveSafe(root, '');
    expect(target).toBe(root);
  });
});

describe('resolveSafe — root canonicalization', () => {
  it('rejects a non-existent project root', async () => {
    await expect(
      resolveSafe(path.join(sandbox, 'no-such-root'), 'a.md')
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  it('canonicalizes a symlinked root so normal paths still pass', async () => {
    // A symlink whose target IS the real root must behave like the root.
    const linkedRoot = path.join(sandbox, 'root-link');
    symlinkSync(root, linkedRoot);
    const target = await resolveSafe(linkedRoot, 'notes/a.md');
    expect(target).toBe(path.join(root, 'notes', 'a.md'));
  });
});
