// Atomic, durable writes for user documents.
//
// Document saves must never leave a half-written file: a crash or power loss
// mid-write should leave either the complete old document or the complete new
// one. We write to a temp sibling, fsync it durable, then rename over the
// target — rename is atomic on POSIX, and on modern Windows fs.rename overwrites
// in place. On any failure before the rename the original target is untouched
// and the temp is cleaned up.
//
// This is a stronger guarantee than `persistence.ts`'s atomicWriteJson (which
// skips the fsync): UI-state files are small and replaceable, user prose is not.

import {
  open as fsOpen,
  rename as fsRename,
  rm as fsRm,
  readFile as fsReadFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Injectable fs surface so the durability ordering can be tested. */
export type AtomicWriteFs = {
  open: typeof fsOpen;
  rename: typeof fsRename;
  rm: typeof fsRm;
};

const defaultFs: AtomicWriteFs = { open: fsOpen, rename: fsRename, rm: fsRm };

export async function atomicWriteFile(
  target: string,
  content: string,
  fs: AtomicWriteFs = defaultFs
): Promise<void> {
  const tmp = `${target}.tmp`;
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
  try {
    handle = await fs.open(tmp, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fs.rename(tmp, target);
}

/** Stable content fingerprint for external-change detection. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Whether the file at `absPath` differs from `knownHash` (what the renderer
 * last loaded or saved). A missing file is not a conflict — a save will create
 * it — so it returns false.
 */
export async function detectExternalChange(
  absPath: string,
  knownHash: string
): Promise<boolean> {
  try {
    const disk = await fsReadFile(absPath, 'utf8');
    return contentHash(disk) !== knownHash;
  } catch {
    return false;
  }
}
