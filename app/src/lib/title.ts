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

export function resolveTitle(file: FileEntry): ResolvedTitle {
  const fm = file.frontmatter['title'];
  if (typeof fm === 'string') {
    const trimmed = fm.trim();
    if (trimmed) {
      return { primary: trimmed, secondary: file.name };
    }
  }
  return { primary: file.name, secondary: null };
}
