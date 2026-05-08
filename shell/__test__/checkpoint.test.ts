// Phase 10b checkpoint-library tests. Mirrors the Rust unit-test suite
// in src-tauri/src/history.rs so the on-disk filename + retention
// contract stays binary-compatible across the v0.1.6 → v0.2 port.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createManualCheckpointAt,
  maybeWriteAutoCheckpointAt,
  slugify
} from '../src/lib/checkpoint';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'skrive-checkpoint-'));
  tempDirs.push(dir);
  return dir;
}

async function listFilenames(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((n) => n.endsWith('.md')).sort();
}

const FIVE_MIN = 5 * 60 * 1000;

describe('slugify', () => {
  it('lowercases and hyphenates whitespace', () => {
    expect(slugify('End of Draft 1')).toBe('end-of-draft-1');
  });

  it('strips punctuation and collapses hyphens', () => {
    expect(slugify('Hello, world!!!')).toBe('hello-world');
    expect(slugify('  spaced   out  ')).toBe('spaced-out');
    expect(slugify('a--b__c')).toBe('a-b-c');
  });

  it('falls back to "pinned" for empty result', () => {
    expect(slugify('')).toBe('pinned');
    expect(slugify('!!!')).toBe('pinned');
    expect(slugify('   ')).toBe('pinned');
  });

  it('truncates at SLUG_MAX_LEN (40)', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });
});

describe('maybeWriteAutoCheckpointAt', () => {
  it('writes the first checkpoint', async () => {
    const dir = makeTempDir();
    const t0 = 1_000_000_000_000;
    await maybeWriteAutoCheckpointAt(dir, 'hello\n', t0, 50);
    const files = await listFilenames(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${t0}_auto.md`);
  });

  it('skips when interval has not elapsed', async () => {
    const dir = makeTempDir();
    const t0 = 1_000_000_000_000;
    await maybeWriteAutoCheckpointAt(dir, 'one\n', t0, 50);
    const t1 = t0 + 60_000; // 1 min later
    await maybeWriteAutoCheckpointAt(dir, 'two\n', t1, 50);
    const files = await listFilenames(dir);
    expect(files).toHaveLength(1);
  });

  it('dedups against most-recent when content matches', async () => {
    const dir = makeTempDir();
    const t0 = 1_000_000_000_000;
    await maybeWriteAutoCheckpointAt(dir, 'same\n', t0, 50);
    const t1 = t0 + FIVE_MIN + 1000;
    await maybeWriteAutoCheckpointAt(dir, 'same\n', t1, 50);
    const files = await listFilenames(dir);
    expect(files).toHaveLength(1);
  });

  it('succeeds past interval with new content', async () => {
    const dir = makeTempDir();
    const t0 = 1_000_000_000_000;
    await maybeWriteAutoCheckpointAt(dir, 'one\n', t0, 50);
    const t1 = t0 + FIVE_MIN + 1;
    await maybeWriteAutoCheckpointAt(dir, 'two\n', t1, 50);
    const files = await listFilenames(dir);
    expect(files).toHaveLength(2);
  });

  it('keeps the cap newest autos and prunes the rest', async () => {
    const dir = makeTempDir();
    const base = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) {
      const ts = base + i * (FIVE_MIN + 1);
      await maybeWriteAutoCheckpointAt(dir, `body ${i}`, ts, 3);
    }
    const files = await listFilenames(dir);
    expect(files).toHaveLength(3);
    // Newest three timestamps should be present.
    const timestamps = files.map((f) => Number(f.split('_')[0]));
    expect(timestamps).toContain(base + 2 * (FIVE_MIN + 1));
    expect(timestamps).toContain(base + 3 * (FIVE_MIN + 1));
    expect(timestamps).toContain(base + 4 * (FIVE_MIN + 1));
  });
});

describe('createManualCheckpointAt', () => {
  it('writes the checkpoint plus a name sidecar', async () => {
    const dir = makeTempDir();
    await createManualCheckpointAt(dir, 'End of Draft 1', 'body\n', 1_700_000_000_000, 0);
    const files = await fs.readdir(dir);
    const md = files.filter((f) => f.endsWith('.md'));
    const sidecar = files.filter((f) => f.endsWith('.name'));
    expect(md).toHaveLength(1);
    expect(md[0]).toMatch(/_manual_end-of-draft-1\.md$/);
    expect(sidecar).toHaveLength(1);
    const recovered = await fs.readFile(path.join(dir, sidecar[0]!), 'utf8');
    expect(recovered).toBe('End of Draft 1');
  });

  it('renames on filename collision', async () => {
    const dir = makeTempDir();
    const ts = 1_700_000_000_000;
    await createManualCheckpointAt(dir, 'pinned', 'one\n', ts, 0);
    await createManualCheckpointAt(dir, 'pinned', 'two\n', ts, 0);
    const md = (await listFilenames(dir)).filter((f) => f.includes('manual'));
    expect(md).toHaveLength(2);
    // Both manual, both with pinned slug, the second has a `_2` suffix.
    expect(md.some((n) => n.endsWith('_manual_pinned.md'))).toBe(true);
    expect(md.some((n) => n.endsWith('_manual_pinned_2.md'))).toBe(true);
  });

  it('always writes even when content matches an existing pin', async () => {
    const dir = makeTempDir();
    const t0 = 1_700_000_000_000;
    await createManualCheckpointAt(dir, 'first', 'same\n', t0, 0);
    await createManualCheckpointAt(dir, 'second', 'same\n', t0 + 10_000, 0);
    const md = (await listFilenames(dir)).filter((f) => f.includes('manual'));
    expect(md).toHaveLength(2);
  });

  it('prunes manuals past the cap, including their sidecars', async () => {
    const dir = makeTempDir();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 4; i++) {
      await createManualCheckpointAt(dir, `pin-${i}`, 'body\n', base + i * 1000, 2);
    }
    const md = (await listFilenames(dir)).filter((f) => f.includes('manual'));
    expect(md).toHaveLength(2);
    // Sidecars track the surviving pins one-for-one.
    const sidecars = (await fs.readdir(dir)).filter((f) => f.endsWith('.name'));
    expect(sidecars).toHaveLength(2);
  });

  it('does not auto-prune when manualCap is 0', async () => {
    const dir = makeTempDir();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      await createManualCheckpointAt(dir, `pin-${i}`, 'body\n', base + i * 1000, 0);
    }
    const md = (await listFilenames(dir)).filter((f) => f.includes('manual'));
    expect(md).toHaveLength(5);
  });
});
