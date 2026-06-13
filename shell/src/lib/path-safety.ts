// Symlink-safe path containment (Zig shell plan, Part I; closes audit
// finding S1). The lexical-only check this replaces let an in-root
// symlink that points OUTSIDE the root pass containment — reads, writes,
// and asset serving would then follow it out of the project. The fix
// adds a physical (realpath) check on the deepest existing ancestor of
// the target.
//
// No Electron import by design: this is the testable core that both
// `ipc/fs.ts` and `main/asset-protocol.ts` call, and the fixture set in
// `__test__/path-safety.test.ts` is reused verbatim by the Zig core in
// Stage 2. `IpcError` comes from the dispatcher, which is itself
// Electron-free.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IpcError } from '../main/dispatch';

/** Lexical escape test on the result of `path.relative(root, target)`:
 *  an empty string means target === root (contained); `..`, a `../`
 *  prefix, or an absolute result means it escaped. */
function lexicallyEscapes(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
}

/** realpath of the deepest existing ancestor of `target`: the target
 *  itself when it exists (so a symlinked file is caught), otherwise its
 *  nearest existing parent — the not-yet-created tail can't be a symlink,
 *  so only the existing prefix needs canonicalizing. Terminates because
 *  the filesystem root always exists. */
async function realpathDeepestExisting(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve `relPath` against `projectRoot` and verify it stays inside the
 * root both lexically and physically. Returns the resolved absolute
 * target (under the canonical root). Throws `IpcError('PATH_ESCAPE')` on
 * any violation: a NUL byte, a missing root, `..` traversal, an absolute
 * `relPath`, or a symlink in the existing prefix that jumps outside.
 */
export async function resolveSafe(
  projectRoot: string,
  relPath: string
): Promise<string> {
  // (5) NUL bytes truncate paths at the C layer — reject before any
  // syscall sees them.
  if (projectRoot.includes('\0') || relPath.includes('\0')) {
    throw new IpcError('PATH_ESCAPE', `Path contains a NUL byte: ${relPath}`);
  }

  // (1) Canonicalize the root so both sides of the containment
  // comparison are symlink-free; a non-existent root is itself a
  // failure. Doing this first is also what makes the check correct under
  // macOS temp dirs (/var -> /private/var) and any symlinked project
  // path: realExisting below is always compared against a canonical root.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(projectRoot));
  } catch {
    throw new IpcError(
      'PATH_ESCAPE',
      `Project root does not exist: ${projectRoot}`
    );
  }

  // (2) Lexical join against the canonical root, then (3) lexical
  // containment — a cheap reject before touching disk.
  const target = path.resolve(realRoot, relPath);
  if (lexicallyEscapes(path.relative(realRoot, target))) {
    throw new IpcError('PATH_ESCAPE', `Path escapes project root: ${relPath}`);
  }

  // (4) Physical check: the deepest existing ancestor, canonicalized,
  // must still be inside the root. This is the case the lexical check
  // misses — an in-root symlink whose target is outside resolves out
  // here even though every textual segment looked contained.
  const realExisting = await realpathDeepestExisting(target);
  const relExisting = path.relative(realRoot, realExisting);
  if (relExisting !== '' && lexicallyEscapes(relExisting)) {
    throw new IpcError(
      'PATH_ESCAPE',
      `Path escapes project root via symlink: ${relPath}`
    );
  }

  return target;
}
