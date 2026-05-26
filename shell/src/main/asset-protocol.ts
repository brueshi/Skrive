// Custom protocol that serves the project's local image assets to the
// renderer. A page loaded over http(s) (dev) or file:// (prod) can't load
// arbitrary local files, so project-relative image URLs are rewritten in the
// renderer to `skrive-asset://asset/<project-relative-path>` and served here.
//
// Security: every request is resolved against the *active* project root
// (`projectState.root`), and anything that escapes the root is refused — so a
// crafted `<img src="skrive-asset://asset/../../etc/passwd">` in a malicious
// markdown file can't read outside the project. The renderer-supplied URL
// never carries an absolute path; the root comes only from trusted main state.

import { protocol } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectState } from '../state/project-state';

const SCHEME = 'skrive-asset';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
};

// Resolve a project-relative path against the active root, refusing escapes.
// Mirrors the containment check in ipc/fs.ts.
function resolveWithinRoot(root: string, relPath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

// Must run before the app 'ready' event.
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ]);
}

// Must run after the app 'ready' event.
export function registerAssetProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const root = projectState.root;
    if (!root) return new Response(null, { status: 404 });

    let relPath: string;
    try {
      relPath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    } catch {
      return new Response(null, { status: 400 });
    }

    const target = resolveWithinRoot(root, relPath);
    if (!target) return new Response(null, { status: 403 });

    try {
      const data = await fs.readFile(target);
      const mime =
        MIME_BY_EXT[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': mime }
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
