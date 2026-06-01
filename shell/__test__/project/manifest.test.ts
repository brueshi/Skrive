// Incremental manifest cache + version semantics. The renderer reads
// the cached manifest via project:getManifest and compares its version
// against the prior one to decide whether to re-ship the manifest to the
// lint worker. The contract under test:
//
//   - scanProject builds + caches the manifest and bumps the version.
//   - buildFileEntry produces exactly the shape scanProject puts in
//     `files`, so the incremental path can't drift from the full scan.
//   - patchManifestFile / removeManifestFile keep the cache fresh and
//     bump the version ONLY on structure-relevant changes: a path added
//     or removed, or an existing file's frontmatter changing. A
//     content-only edit (body changed, frontmatter identical) must not.
//
// We exercise ProjectState directly with temp files rather than wiring a
// real chokidar watcher — the watcher only forwards events into these
// methods, so the methods are where the semantics live.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFileEntry, scanProject } from '../../src/ipc/project';
import { projectState } from '../../src/state/project-state';

let root: string;

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

function rel(...parts: string[]): string {
  return parts.join('/');
}

// Mirror the watcher's add/change path: build the entry from disk, then
// patch the cache + graph through ProjectState.
async function patch(relPath: string): Promise<void> {
  const built = await buildFileEntry(root, relPath);
  if (built === null) {
    projectState.removeManifestFile(relPath);
    return;
  }
  projectState.patchManifestFile(relPath, built.body ?? '', built.entry);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'skrive-manifest-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  projectState.reset(null);
});

describe('scanProject manifest cache', () => {
  it('caches the manifest and bumps the version', async () => {
    write('a.md', '# A\n');
    write('b.md', '# B\n');

    const before = projectState.manifestVersion;
    const manifest = await scanProject(root);

    expect(projectState.manifest).toBe(manifest);
    expect(projectState.manifestVersion).toBeGreaterThan(before);
    expect(manifest.files.map((f) => f.path)).toEqual(['a.md', 'b.md']);
  });

  it('reset clears the cached manifest', async () => {
    write('a.md', '# A\n');
    await scanProject(root);
    projectState.reset(null);
    expect(projectState.manifest).toBeNull();
  });
});

describe('buildFileEntry parity with scanProject', () => {
  it('produces the same entry shape the full scan puts in files', async () => {
    write('note.md', '---\ntitle: Note\n---\n# Note\n[x](note.md)\n');
    const manifest = await scanProject(root);
    const scanned = manifest.files.find((f) => f.path === 'note.md');

    const built = await buildFileEntry(root, 'note.md');
    expect(built).not.toBeNull();
    expect(built!.entry).toEqual(scanned);
  });

  it('returns null when the file does not exist', async () => {
    const built = await buildFileEntry(root, 'ghost.md');
    expect(built).toBeNull();
  });
});

describe('patchManifestFile / removeManifestFile version semantics', () => {
  it('an add bumps the version and inserts a sorted entry', async () => {
    write('b.md', '# B\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    write('a.md', '# A\n');
    await patch('a.md');

    expect(projectState.manifestVersion).toBe(before + 1);
    expect(projectState.manifest!.files.map((f) => f.path)).toEqual([
      'a.md',
      'b.md'
    ]);
  });

  it('an unlink bumps the version and removes the entry', async () => {
    write('a.md', '# A\n');
    write('b.md', '# B\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    rmSync(path.join(root, 'a.md'));
    projectState.removeManifestFile('a.md');

    expect(projectState.manifestVersion).toBe(before + 1);
    expect(projectState.manifest!.files.map((f) => f.path)).toEqual(['b.md']);
  });

  it('a frontmatter change bumps the version', async () => {
    write('a.md', '---\ntitle: Old\n---\n# A\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    write('a.md', '---\ntitle: New\n---\n# A\n');
    await patch('a.md');

    expect(projectState.manifestVersion).toBe(before + 1);
    expect(projectState.manifest!.files[0]!.frontmatter).toEqual({
      title: 'New'
    });
  });

  it('a content-only change does NOT bump the version', async () => {
    write('a.md', '---\ntitle: Same\n---\n# A\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    // Body changes, frontmatter is byte-for-byte identical.
    write('a.md', '---\ntitle: Same\n---\n# A\n\nMore prose, longer body.\n');
    await patch('a.md');

    expect(projectState.manifestVersion).toBe(before);
    // The entry is still replaced (size reflects the new body)...
    expect(projectState.manifest!.files[0]!.frontmatter).toEqual({
      title: 'Same'
    });
  });

  it('frontmatter equality is structural, not key-order sensitive', async () => {
    write('a.md', '---\na: 1\nb: 2\n---\nbody\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    // Same map, keys re-ordered — must read as unchanged.
    write('a.md', '---\nb: 2\na: 1\n---\ndifferent body\n');
    await patch('a.md');

    expect(projectState.manifestVersion).toBe(before);
  });

  it('removeManifestFile is a no-op (no bump) for unknown paths', async () => {
    write('a.md', '# A\n');
    await scanProject(root);
    const before = projectState.manifestVersion;

    projectState.removeManifestFile('never-existed.md');
    expect(projectState.manifestVersion).toBe(before);
  });
});

describe('nested paths sort correctly on insert', () => {
  it('inserts a nested path in the right sorted slot', async () => {
    write('a.md', '# A\n');
    write('z.md', '# Z\n');
    await scanProject(root);

    write(rel('sub', 'm.md'), '# M\n');
    await patch('sub/m.md');

    expect(projectState.manifest!.files.map((f) => f.path)).toEqual([
      'a.md',
      'sub/m.md',
      'z.md'
    ]);
  });
});
