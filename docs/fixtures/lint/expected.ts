// Canonical expected lint output for the three project-shaped fixtures.
// Used by `app/__test__/lint/fixtures.test.ts` (and any future Zig
// experiment per `docs/Zig lint experiment.md` step 3 fixture parity).
//
// Findings are listed in the engine's sort order (path → line →
// column → rule). Adding or moving content in a fixture also requires
// updating the expectations here — that's the whole point.

import type { LintFinding } from '@skrive/shared';

export type ExpectedFixture = {
  /** The literal `[lint]` keys overridden by the fixture's `.skrive.toml`,
   *  applied over engine defaults. Empty means "use the defaults." */
  configOverrides?: { tomlSource: string | null };
  findings: LintFinding[];
};

export const CLEAN_FIXTURE: ExpectedFixture = {
  findings: []
};

export const VIOLATIONS_FIXTURE: ExpectedFixture = {
  findings: [
    {
      rule: 'broken_internal_links',
      severity: 'error',
      path: 'chapters/broken-links.md',
      line: 8,
      column: 37,
      range: { start: 98, end: 108 },
      message: 'Link target "chapters/missing.md" doesn\'t exist in this project.'
    },
    {
      rule: 'broken_internal_links',
      severity: 'error',
      path: 'chapters/broken-links.md',
      line: 8,
      column: 67,
      range: { start: 128, end: 146 },
      message: 'Link target "also-missing.md" doesn\'t exist in this project.'
    },
    {
      rule: 'heading_hierarchy',
      severity: 'warn',
      path: 'chapters/broken-links.md',
      line: 10,
      column: 1,
      range: { start: 150, end: 169 },
      message: 'Heading skips from h1 to h3.'
    },
    {
      rule: 'missing_required_frontmatter',
      severity: 'warn',
      path: 'chapters/missing-fm.md',
      line: 1,
      column: 1,
      range: null,
      message: 'Missing required frontmatter: `title` and `date`.'
    },
    // index.md is orphaned because nothing in the project links *to* it.
    // That's the realistic shape of a root index, and a real signal worth
    // surfacing — captured here rather than papered over by adding a
    // contrived back-link.
    {
      rule: 'orphaned_files',
      severity: 'warn',
      path: 'index.md',
      line: 1,
      column: 1,
      range: null,
      message: 'No other file in the project links to this file.'
    },
    {
      rule: 'duplicate_headings',
      severity: 'warn',
      path: 'intro.md',
      line: 14,
      column: 1,
      range: { start: 100, end: 108 },
      message: 'Duplicate heading "Notes" at level 2 (first seen on line 10).'
    },
    {
      rule: 'orphaned_files',
      severity: 'warn',
      path: 'orphan-1.md',
      line: 1,
      column: 1,
      range: null,
      message: 'No other file in the project links to this file.'
    },
    {
      rule: 'orphaned_files',
      severity: 'warn',
      path: 'orphan-2.md',
      line: 1,
      column: 1,
      range: null,
      message: 'No other file in the project links to this file.'
    }
  ]
};

export const EDGE_CASES_FIXTURE: ExpectedFixture = {
  findings: [
    {
      rule: 'duplicate_headings',
      severity: 'warn',
      path: 'unicode.md',
      line: 11,
      column: 1,
      range: { start: 276, end: 283 },
      message: 'Duplicate heading "Café" at level 2 (first seen on line 7).'
    }
  ]
};
