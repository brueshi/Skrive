// Pure helpers for the working-set + document-history model (SKR-243).
// The project store owns the state; the list mechanics live here so the
// LRU/eviction/trail rules are unit-testable without a store harness.
//
// The model (planning/chrome-navigation-model.md): one live document, one
// bounded working set (LRU, entry 0 = the live doc, cap on the unpinned
// portion), and one history trail of document visits (browser-style, capped).
// Deleted files drop out of both lists; renames follow.

import { WORKING_SET_CAP, type WorkingSetEntryState } from '@skrive/shared';

/** Document visits, oldest first, with a cursor for ⌘⇧[ / ⌘⇧] walking.
 *  `index` is -1 only when the trail is empty. */
export type NavTrail = {
  paths: string[];
  index: number;
};

export const EMPTY_TRAIL: NavTrail = { paths: [], index: -1 };

const NAV_TRAIL_CAP = 50;

/** Move (or insert) `entry` to the front of the working set and evict past
 *  the cap. Eviction is LRU over the *unpinned* entries only — pinned
 *  documents keep their view-state memory indefinitely and don't count
 *  against the cap. Entry 0 (the live doc) is always among the kept. */
export function promoteEntry(
  workingSet: readonly WorkingSetEntryState[],
  entry: WorkingSetEntryState,
  pinned: readonly string[]
): WorkingSetEntryState[] {
  const next = [entry, ...workingSet.filter((e) => e.path !== entry.path)];
  const pinnedSet = new Set(pinned);
  const kept: WorkingSetEntryState[] = [];
  let unpinned = 0;
  for (const e of next) {
    if (pinnedSet.has(e.path)) {
      kept.push(e);
      continue;
    }
    if (unpinned < WORKING_SET_CAP) {
      kept.push(e);
      unpinned++;
    }
  }
  return kept;
}

/** Record a visit: truncate any forward entries (a new visit mid-trail
 *  starts a new branch, browser-style), append, cap from the old end. A
 *  visit to the path already under the cursor is a no-op. */
export function pushVisit(trail: NavTrail, path: string): NavTrail {
  const paths = trail.paths.slice(0, trail.index + 1);
  if (paths[paths.length - 1] === path) {
    return { paths, index: paths.length - 1 };
  }
  paths.push(path);
  while (paths.length > NAV_TRAIL_CAP) paths.shift();
  return { paths, index: paths.length - 1 };
}

/** The path one step back/forward from the cursor, or null at either end.
 *  The trail holds only existing files (`pruneToExisting` runs on every
 *  manifest change), so no existence walk is needed here. */
export function peekVisit(trail: NavTrail, dir: -1 | 1): string | null {
  const i = trail.index + dir;
  return i >= 0 && i < trail.paths.length ? (trail.paths[i] ?? null) : null;
}

/** Drop trail entries whose file no longer exists, collapsing any
 *  consecutive duplicates the removal exposes, and keep the cursor on the
 *  same visit (or the nearest surviving one). */
export function pruneTrail(
  trail: NavTrail,
  exists: (path: string) => boolean
): NavTrail {
  const paths: string[] = [];
  let index = -1;
  for (let i = 0; i < trail.paths.length; i++) {
    const p = trail.paths[i]!;
    if (exists(p) && paths[paths.length - 1] !== p) paths.push(p);
    // The cursor lands on the nearest surviving visit at or before it
    // (-1 when none survived yet — peeking forward still works).
    if (i === trail.index) index = paths.length - 1;
  }
  return { paths, index };
}

/** Repoint a renamed file everywhere it appears in the trail. */
export function renameInTrail(
  trail: NavTrail,
  oldPath: string,
  newPath: string
): NavTrail {
  if (!trail.paths.includes(oldPath)) return trail;
  return {
    paths: trail.paths.map((p) => (p === oldPath ? newPath : p)),
    index: trail.index
  };
}
