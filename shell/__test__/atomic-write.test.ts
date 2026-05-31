// Atomic document writes + external-change detection. The durability guarantee
// is part of the projection editor's save model (Stage 1.2): an interrupted
// write must never corrupt the document, and a save must not silently clobber a
// file edited on disk since load.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFile,
  contentHash,
  detectExternalChange,
  type AtomicWriteFs
} from '../src/lib/atomic-write';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skrive-atomic-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('writes the content and leaves no temp file behind', async () => {
    const p = join(dir, 'ok.md');
    await atomicWriteFile(p, 'hello world');
    expect(await readFile(p, 'utf8')).toBe('hello world');
    await expect(readFile(`${p}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('overwrites an existing file', async () => {
    const p = join(dir, 'replace.md');
    await writeFile(p, 'OLD');
    await atomicWriteFile(p, 'NEW');
    expect(await readFile(p, 'utf8')).toBe('NEW');
  });

  it('an interrupted write never corrupts the target (rename only after a durable temp)', async () => {
    const p = join(dir, 'safe.md');
    await writeFile(p, 'ORIGINAL');

    const rename = vi.fn(async () => {});
    const rmTmp = vi.fn(async () => {});
    const fakeFs: AtomicWriteFs = {
      open: (async () => ({
        writeFile: async () => {
          throw new Error('disk full');
        },
        sync: async () => {},
        close: async () => {}
      })) as unknown as AtomicWriteFs['open'],
      rename: rename as unknown as AtomicWriteFs['rename'],
      rm: rmTmp as unknown as AtomicWriteFs['rm']
    };

    await expect(atomicWriteFile(p, 'NEW BYTES', fakeFs)).rejects.toThrow('disk full');
    expect(rename).not.toHaveBeenCalled(); // never swapped in a partial file
    expect(rmTmp).toHaveBeenCalled(); // temp cleaned up
    expect(await readFile(p, 'utf8')).toBe('ORIGINAL'); // target untouched
  });
});

describe('contentHash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });
});

describe('detectExternalChange', () => {
  it('detects an on-disk change since load and ignores a missing file', async () => {
    const p = join(dir, 'conflict.md');
    await writeFile(p, 'A');
    const loaded = contentHash('A');

    expect(await detectExternalChange(p, loaded)).toBe(false);
    await writeFile(p, 'B'); // edited on disk by someone else
    expect(await detectExternalChange(p, loaded)).toBe(true);
    expect(await detectExternalChange(join(dir, 'absent.md'), loaded)).toBe(false);
  });
});
