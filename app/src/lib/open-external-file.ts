// Resolving an OS-initiated document open (Finder / Explorer double-click,
// `open -a Skrive note.md`, a file argument on launch) to something Skrive can
// actually open.
//
// The problem this solves: the OS hands over an ABSOLUTE FILE PATH, and Skrive
// addresses every document as PROJECT ROOT + PROJECT-RELATIVE PATH. Snapshot,
// watcher, asset origin, and persistence are all keyed on that root, so a file
// with no project is not something the app can currently represent (the rootless
// mode is its own rework). Every incoming path therefore has to acquire a root,
// and the only question is which one and how loudly.
//
// Three tiers, cheapest and least surprising first:
//
//   current — the file is inside the open project. Just open the document.
//   known   — the file is inside a project the user has opened before. Switch
//             to that project, then open the document. No prompt: the user has
//             already consented to that folder being a project.
//   new     — the file is somewhere else. Its containing folder WOULD become a
//             project, which means snapshotting an arbitrary directory and
//             evicting whatever is open, so the caller confirms first.
//
// Pure: no store reads, no IPC, no side effects. The caller supplies the
// current root and the recent roots, and decides what to do with the answer.

import { isOpenableDoc } from './doc-types';

export type OpenTargetKind = 'current' | 'known' | 'new';

export type OpenTarget = {
  kind: OpenTargetKind;
  /** Absolute project root, VERBATIM from the caller's candidate list for
   *  `current`/`known` (so a Windows root keeps its backslashes and matches
   *  what persistence stored), or derived from the file's own path for `new`. */
  root: string;
  /** Project-relative, forward-slash separated, in the order given. */
  relPaths: string[];
};

export type OpenResolution = {
  /** The project to open, or null when nothing openable came in. */
  target: OpenTarget | null;
  /** Paths naming a file type Skrive cannot open. */
  unsupported: string[];
  /** Openable paths belonging to a DIFFERENT root than `target`. Opening them
   *  too would mean opening a second project and discarding the first, so they
   *  are reported rather than silently dropped. */
  deferred: string[];
};

/** Forward slashes, no trailing separator. For COMPARISON only — never hand
 *  the result to a host, which may want its own separator back. */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  // A lone "/" is a real root; everything else loses its trailing separator.
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * The path of `filePath` relative to `root`, or null when it isn't inside.
 *
 * Case-insensitive, which is correct for the two filesystems Skrive ships on
 * (APFS and NTFS both default to case-insensitive) and matters in practice:
 * the root arrives from persisted state or a folder picker while the file
 * arrives from the OS open event, and the two disagree on case more often than
 * you would like.
 *
 * The prefix is sliced off the ORIGINAL string by length and only then
 * compared case-folded, so a character whose lowercase form has a different
 * length can't shift the split point.
 */
export function relativeTo(root: string, filePath: string): string | null {
  const nRoot = normalize(root);
  const nPath = normalize(filePath);
  if (nRoot === '') return null;
  if (nPath.length < nRoot.length) return null;
  if (nPath.slice(0, nRoot.length).toLowerCase() !== nRoot.toLowerCase()) {
    return null;
  }
  // The filesystem root ("/") already ends in its separator.
  if (nRoot.endsWith('/')) return nPath.slice(nRoot.length);
  if (nPath.length === nRoot.length) return null; // the root itself, not a file
  if (nPath[nRoot.length] !== '/') return null; // "/pro" must not match "/project"
  return nPath.slice(nRoot.length + 1);
}

/** The containing directory, keeping the path's own separator style so a
 *  Windows root stays a Windows root. */
function dirnameOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (cut < 0) return filePath;
  if (cut === 0) return filePath.slice(0, 1); // "/note.md" -> "/"
  return filePath.slice(0, cut);
}

type Candidate = { root: string; kind: OpenTargetKind };

/** Deepest match wins, so a file in a nested project resolves to the nested
 *  root rather than its parent. Ties (equal depth) can't overlap. */
function matchCandidate(
  candidates: Candidate[],
  filePath: string
): { candidate: Candidate; relPath: string } | null {
  let best: { candidate: Candidate; relPath: string } | null = null;
  for (const candidate of candidates) {
    const relPath = relativeTo(candidate.root, filePath);
    if (relPath === null) continue;
    if (best === null || candidate.root.length > best.candidate.root.length) {
      best = { candidate, relPath };
    }
  }
  return best;
}

/**
 * Resolve the paths an OS open handed over into one project to open and the
 * documents to open inside it.
 *
 * Multiple paths arrive from a multi-select in Finder. They usually share a
 * folder, in which case they all open; when they don't, the FIRST path decides
 * the project (it's the one the user acted on) and the rest come back in
 * `deferred` for the caller to surface.
 */
export function resolveOpenTargets(
  absPaths: string[],
  context: { projectRoot: string | null; recentRoots: string[] }
): OpenResolution {
  const unsupported: string[] = [];
  const openable: string[] = [];
  for (const path of absPaths) {
    if (path.trim() === '') continue;
    if (isOpenableDoc(path)) openable.push(path);
    else unsupported.push(path);
  }
  if (openable.length === 0) {
    return { target: null, unsupported, deferred: [] };
  }

  const candidates: Candidate[] = [];
  if (context.projectRoot) {
    candidates.push({ root: context.projectRoot, kind: 'current' });
  }
  for (const root of context.recentRoots) {
    // The open project is already in the list at a higher tier; a duplicate
    // entry would only compete with itself.
    if (
      context.projectRoot &&
      normalize(root).toLowerCase() === normalize(context.projectRoot).toLowerCase()
    ) {
      continue;
    }
    candidates.push({ root, kind: 'known' });
  }

  const resolved = openable.map((path) => {
    const match = matchCandidate(candidates, path);
    if (match) {
      return {
        path,
        root: match.candidate.root,
        kind: match.candidate.kind,
        relPath: match.relPath
      };
    }
    // Nothing knows this file: its own folder becomes the project, pending
    // the caller's confirmation.
    const root = dirnameOf(path);
    const relPath = relativeTo(root, path);
    // relPath can only be null for a path with no filename after its
    // separator, which isn't a file the OS would ask us to open.
    return relPath === null
      ? null
      : { path, root, kind: 'new' as OpenTargetKind, relPath };
  });

  const first = resolved.find((entry) => entry !== null);
  if (!first) return { target: null, unsupported, deferred: [] };

  const targetRoot = normalize(first.root).toLowerCase();
  const relPaths: string[] = [];
  const deferred: string[] = [];
  for (const entry of resolved) {
    if (entry === null) continue;
    if (normalize(entry.root).toLowerCase() === targetRoot) {
      if (!relPaths.includes(entry.relPath)) relPaths.push(entry.relPath);
    } else {
      deferred.push(entry.path);
    }
  }

  return {
    target: { kind: first.kind, root: first.root, relPaths },
    unsupported,
    deferred
  };
}
