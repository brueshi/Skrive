// Title resolution for sidebar / backlinks rows.
//
// Resolves a writer-meaningful display title for a file by walking the
// fallback chain laid out in `planning/navigation-panels-plan.md`:
//
//   frontmatter `title:` (when a non-empty string) → first H1 → filename
//
// Phase 3 only handles the frontmatter and filename rungs (and the
// frontmatter is empty until Phase 7 wires parsing). The H1 fallback
// needs a lazy body load + per-path cache and ships as a follow-up.

import type { FileEntry } from '@skrive/shared';

export type ResolvedTitle = {
  /** What to render as the row's main label. */
  primary: string;
  /**
   * Filename to render as the muted secondary line, or null when no
   * secondary should appear. Null when primary already *is* the filename.
   */
  secondary: string | null;
};

/** Native `.folio` is not surfaced as a format: its extension is hidden in
 *  display names (a document reads as "notes", not "notes.folio"). Markdown keeps
 *  its extension. Display-only — the real path/name still drives operations. */
export function stripFolioExtension(name: string): string {
  return name.replace(/\.folio$/i, '');
}

/** Middle-truncate a display name past `max` chars, keeping both ends —
 *  a long filename's distinguishing part is often its tail (chapter
 *  numbers, dates), so end-ellipsis would hide exactly what matters.
 *  Used by the front-title (SKR-243). */
export function middleTruncate(name: string, max = 40): string {
  if (name.length <= max) return name;
  const half = Math.floor((max - 1) / 2);
  return `${name.slice(0, max - 1 - half)}…${name.slice(name.length - half)}`;
}

export function resolveTitle(file: FileEntry): ResolvedTitle {
  const name = stripFolioExtension(file.name);
  const fm = file.frontmatter['title'];
  if (typeof fm === 'string') {
    const trimmed = fm.trim();
    if (trimmed) {
      return { primary: trimmed, secondary: name };
    }
  }
  return { primary: name, secondary: null };
}
