// Canonical graph state for the link-graph fixtures. The test harness
// in shell/__test__/link-graph/ asserts against these structures so a
// regression in the parser or the graph builder surfaces immediately.
//
// Per-source edges record only target + kind — byte_range and line/col
// are checked separately on synthetic inputs (mirroring the inline
// Rust unit tests in src-tauri/src/link_graph.rs). The structural
// shape here is what backlinks / outgoing / dead-links UIs care about.

export type ExpectedEdge = {
  /** For relative links: project-relative path with forward slashes.
   *  For wiki links: the inner name verbatim (no filename resolution
   *  at extraction — that happens at lookup time). */
  target: string;
  targetKind: 'relative' | 'wiki';
  kind: 'inline' | 'wiki' | 'referenceUse' | 'referenceDefinition';
};

export type ExpectedFixture = {
  /** Source path → ordered list of expected edges. */
  forward: Record<string, ExpectedEdge[]>;
  /** Target relative path → set of source relative paths that link to it.
   *  Wiki edges do not appear here (the Rust `backward` index only
   *  tracks `LinkTarget::Relative`). */
  backward: Record<string, string[]>;
  /** Edges whose target is a project-relative path that no file in the
   *  fixture actually owns. Wiki edges are never reported as dead. */
  deadLinks: Array<{
    source: string;
    target: string;
    kind: ExpectedEdge['kind'];
  }>;
};

export const SMALL_FIXTURE: ExpectedFixture = {
  forward: {
    'index.md': [
      { target: 'intro.md', targetKind: 'relative', kind: 'inline' },
      { target: 'glossary.md', targetKind: 'relative', kind: 'inline' },
      { target: 'Setup', targetKind: 'wiki', kind: 'wiki' }
    ],
    'intro.md': [
      { target: 'index.md', targetKind: 'relative', kind: 'inline' }
    ],
    'glossary.md': [
      { target: 'terms/term1.md', targetKind: 'relative', kind: 'referenceUse' },
      { target: 'terms/term2.md', targetKind: 'relative', kind: 'referenceUse' },
      {
        target: 'terms/term1.md',
        targetKind: 'relative',
        kind: 'referenceDefinition'
      },
      {
        target: 'terms/term2.md',
        targetKind: 'relative',
        kind: 'referenceDefinition'
      }
    ],
    'setup.md': [
      { target: 'Glossary', targetKind: 'wiki', kind: 'wiki' },
      {
        target: 'chapters/01.md',
        targetKind: 'relative',
        kind: 'inline'
      }
    ],
    'chapters/01.md': [
      { target: 'intro.md', targetKind: 'relative', kind: 'inline' },
      { target: 'setup.md', targetKind: 'relative', kind: 'inline' }
    ],
    'chapters/02.md': [
      { target: 'Setup', targetKind: 'wiki', kind: 'wiki' },
      {
        target: 'chapters/03.md',
        targetKind: 'relative',
        kind: 'inline'
      }
    ],
    'chapters/03.md': [
      { target: 'missing.md', targetKind: 'relative', kind: 'inline' }
    ],
    'terms/term1.md': [],
    'terms/term2.md': [
      { target: 'index.md', targetKind: 'relative', kind: 'inline' }
    ],
    'notes/misc.md': []
  },
  backward: {
    'index.md': ['intro.md', 'terms/term2.md'],
    'intro.md': ['chapters/01.md', 'index.md'],
    'glossary.md': ['index.md'],
    'setup.md': ['chapters/01.md'],
    'chapters/01.md': ['setup.md'],
    'chapters/03.md': ['chapters/02.md'],
    'terms/term1.md': ['glossary.md'],
    'terms/term2.md': ['glossary.md']
  },
  deadLinks: [
    { source: 'chapters/03.md', target: 'missing.md', kind: 'inline' }
  ]
};

export const ADVERSARIAL_FIXTURE: ExpectedFixture = {
  forward: {
    'self.md': [
      { target: 'self.md', targetKind: 'relative', kind: 'inline' }
    ],
    'cycle-a.md': [
      { target: 'cycle-b.md', targetKind: 'relative', kind: 'inline' }
    ],
    'cycle-b.md': [
      { target: 'cycle-c.md', targetKind: 'relative', kind: 'inline' }
    ],
    'cycle-c.md': [
      { target: 'cycle-a.md', targetKind: 'relative', kind: 'inline' }
    ],
    'deep/sub/sub/sub/file.md': [
      { target: 'self.md', targetKind: 'relative', kind: 'inline' }
    ],
    'unicode/über.md': [
      {
        target: 'unicode/αβγ.md',
        targetKind: 'relative',
        kind: 'inline'
      }
    ],
    'unicode/αβγ.md': [],
    'broken.md': [
      { target: 'ghost.md', targetKind: 'relative', kind: 'inline' }
    ],
    'ref-in-fence.md': [
      { target: 'self.md', targetKind: 'relative', kind: 'referenceDefinition' }
    ],
    // The malformed `[intro]: self.md` line sits inside a paragraph,
    // so neither the use nor the def becomes an edge.
    'ref-not-block.md': [],
    'ref-angle.md': [
      // Document order: definition appears first (line 2), use second (line 4).
      { target: 'self.md', targetKind: 'relative', kind: 'referenceDefinition' },
      { target: 'self.md', targetKind: 'relative', kind: 'referenceUse' }
    ],
    'alias.md': [
      { target: 'Other Note', targetKind: 'wiki', kind: 'wiki' }
    ],
    'external.md': []
  },
  backward: {
    'self.md': [
      'deep/sub/sub/sub/file.md',
      'ref-angle.md',
      'ref-in-fence.md',
      'self.md'
    ],
    'cycle-a.md': ['cycle-c.md'],
    'cycle-b.md': ['cycle-a.md'],
    'cycle-c.md': ['cycle-b.md'],
    'unicode/αβγ.md': ['unicode/über.md']
  },
  deadLinks: [{ source: 'broken.md', target: 'ghost.md', kind: 'inline' }]
};
