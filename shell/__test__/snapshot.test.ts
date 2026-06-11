// Snapshot scan tests (Stage 0.4): the batched project read that the
// renderer's project-model worker consumes. The same fixture shapes
// gate the Zig core's project:snapshot in Stage 2.3.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from '../src/lib/atomic-write';
import { scanSnapshot } from '../src/lib/snapshot';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skrive-snapshot-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
}

describe('scanSnapshot', () => {
  it('returns every file in one response, bodies for markdown only', async () => {
    await seed({
      'a.md': '# A',
      'notes/b.markdown': 'B body',
      'assets/img.png': 'PNGBYTES',
      LICENSE: 'MIT'
    });
    const snapshot = await scanSnapshot(root);

    expect(snapshot.root).toBe(root);
    // localeCompare order, matching the manifest sort.
    expect(snapshot.files.map((f) => f.path)).toEqual([
      'a.md',
      'assets/img.png',
      'LICENSE',
      'notes/b.markdown'
    ]);

    const md = snapshot.files.find((f) => f.path === 'a.md')!;
    expect(md.body).toBe('# A');
    expect(md.hash).toBe(contentHash('# A'));
    expect(md.sizeBytes).toBe(3);
    expect(md.modifiedMs).toBeGreaterThan(0);

    const asset = snapshot.files.find((f) => f.path === 'assets/img.png')!;
    expect(asset.body).toBeNull();
    expect(asset.hash).toBeNull();
    expect(asset.sizeBytes).toBe(8);
  });

  it('skips noise directories, hidden directories, and dot-files', async () => {
    await seed({
      'real.md': 'x',
      'node_modules/dep/readme.md': 'noise',
      '.git/config.md': 'noise',
      '.archive/draft.md': 'noise',
      '.gitignore': 'noise',
      'sub/.DS_Store': 'noise'
    });
    const snapshot = await scanSnapshot(root);
    expect(snapshot.files.map((f) => f.path)).toEqual(['real.md']);
  });

  it('includes .skrive.toml with its body despite the dot-file rule', async () => {
    await seed({
      'a.md': 'x',
      '.skrive.toml': '[project]\nname = "Test"\n'
    });
    const snapshot = await scanSnapshot(root);
    const toml = snapshot.files.find((f) => f.path === '.skrive.toml')!;
    expect(toml.body).toBe('[project]\nname = "Test"\n');
    expect(toml.hash).toBe(contentHash(toml.body!));
  });

  it('omits .skrive.toml when absent and handles an empty project', async () => {
    const snapshot = await scanSnapshot(root);
    expect(snapshot.files).toEqual([]);
  });
});
