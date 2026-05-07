// Per-rule tests using minimal in-memory project snapshots. Each test
// builds a manifest and bodies for one or two files, runs the engine,
// and asserts on the resulting findings.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_CONFIG,
  inferSchema,
  parseFrontmatter,
  type DeadLink,
  type FileEntry,
  type LintConfig,
  type ProjectManifest,
  type SkriveProjectConfig
} from '@skrive/shared';
import { runProjectLint } from '../../src/lib/lint';

function makeFile(rel: string, body: string): FileEntry {
  const fm = parseFrontmatter(body).frontmatter;
  return {
    path: rel,
    name: rel.split('/').pop() ?? rel,
    sizeBytes: body.length,
    modifiedMs: 0,
    frontmatter: fm,
    outgoingLinks: []
  };
}

function makeManifest(
  bodies: Record<string, string>,
  config: SkriveProjectConfig = DEFAULT_PROJECT_CONFIG
): { manifest: ProjectManifest; bodies: Map<string, string> } {
  const files = Object.entries(bodies).map(([rel, body]) => makeFile(rel, body));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: ProjectManifest = {
    root: '/test',
    files,
    schema: inferSchema(files),
    config,
    warnings: []
  };
  return {
    manifest,
    bodies: new Map(Object.entries(bodies))
  };
}

function configWithLint(partial: Partial<LintConfig>): SkriveProjectConfig {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    lint: {
      ...DEFAULT_PROJECT_CONFIG.lint,
      ...partial,
      requiredFrontmatter: {
        ...DEFAULT_PROJECT_CONFIG.lint.requiredFrontmatter,
        ...(partial.requiredFrontmatter ?? {})
      }
    }
  };
}

describe('duplicate_headings rule', () => {
  it('flags two headings with identical text at the same level', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# Notes\n\n## Notes\n\nbody\n\n## Notes\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    const dupes = report.findings.filter(
      (f) => f.rule === 'duplicate_headings'
    );
    expect(dupes.length).toBe(1);
    expect(dupes[0]!.line).toBe(7);
  });

  it('does not flag headings at different levels with the same text', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# Notes\n\n## Notes\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(
      report.findings.filter((f) => f.rule === 'duplicate_headings')
    ).toEqual([]);
  });

  it('normalizes case + whitespace when comparing', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '## Setup\n\n## SETUP\n\n##  setup  \n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    const dupes = report.findings.filter(
      (f) => f.rule === 'duplicate_headings'
    );
    expect(dupes.length).toBe(2);
  });

  it('ignores headings inside fenced code blocks', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '## Setup\n\n```\n## Setup\n```\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(
      report.findings.filter((f) => f.rule === 'duplicate_headings')
    ).toEqual([]);
  });
});

describe('heading_hierarchy rule', () => {
  it('flags h1 → h3 skip', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# Top\n\n### Skipped\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    const skips = report.findings.filter((f) => f.rule === 'heading_hierarchy');
    expect(skips.length).toBe(1);
    expect(skips[0]!.message).toMatch(/h1 to h3/);
  });

  it('does not flag h1 → h2 → h3', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# Top\n\n## Mid\n\n### Inner\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(
      report.findings.filter((f) => f.rule === 'heading_hierarchy')
    ).toEqual([]);
  });

  it('does not flag stepping back down (h3 → h2)', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# A\n\n## B\n\n### C\n\n## D\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(
      report.findings.filter((f) => f.rule === 'heading_hierarchy')
    ).toEqual([]);
  });
});

describe('missing_required_frontmatter rule', () => {
  it('is silent when no fields are required', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# No frontmatter\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(
      report.findings.filter(
        (f) => f.rule === 'missing_required_frontmatter'
      )
    ).toEqual([]);
  });

  it('flags files missing every required field', () => {
    const config = configWithLint({
      requiredFrontmatter: { fields: ['title', 'date'] }
    });
    const { manifest, bodies } = makeManifest(
      {
        'a.md': '---\ntitle: Hello\n---\nbody\n',
        'b.md': '---\ntitle: World\ndate: 2026-05-07\n---\n'
      },
      config
    );
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    const findings = report.findings.filter(
      (f) => f.rule === 'missing_required_frontmatter'
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.path).toBe('a.md');
    expect(findings[0]!.message).toMatch(/date/);
  });
});

describe('broken_internal_links rule', () => {
  it('emits one finding per dead link from the IPC payload', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '[bad](missing.md)\n',
      'b.md': '# B\n'
    });
    const deadLinks: DeadLink[] = [
      {
        source: 'a.md',
        target: 'missing.md',
        range: { start: 6, end: 16 },
        line: 0,
        column: 6,
        kind: 'inline'
      }
    ];
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks,
      orphanedFiles: []
    });
    const broken = report.findings.filter(
      (f) => f.rule === 'broken_internal_links'
    );
    expect(broken.length).toBe(1);
    expect(broken[0]!.path).toBe('a.md');
    expect(broken[0]!.line).toBe(1);
    expect(broken[0]!.column).toBe(7);
  });

  it('respects severity off', () => {
    const config = configWithLint({ brokenInternalLinks: 'off' });
    const { manifest, bodies } = makeManifest(
      {
        'a.md': '[bad](missing.md)\n'
      },
      config
    );
    const deadLinks: DeadLink[] = [
      {
        source: 'a.md',
        target: 'missing.md',
        range: { start: 6, end: 16 },
        line: 0,
        column: 6,
        kind: 'inline'
      }
    ];
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks,
      orphanedFiles: []
    });
    expect(
      report.findings.filter((f) => f.rule === 'broken_internal_links')
    ).toEqual([]);
  });
});

describe('orphaned_files rule', () => {
  it('does not run when severity is off (default)', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': 'orphan\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: ['a.md']
    });
    expect(
      report.findings.filter((f) => f.rule === 'orphaned_files')
    ).toEqual([]);
  });

  it('flags every entry in the orphans payload when enabled', () => {
    const config = configWithLint({ orphanedFiles: 'warn' });
    const { manifest, bodies } = makeManifest(
      {
        'a.md': 'a\n',
        'b.md': 'b\n'
      },
      config
    );
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: ['a.md', 'b.md']
    });
    const orphans = report.findings.filter(
      (f) => f.rule === 'orphaned_files'
    );
    expect(orphans.map((f) => f.path)).toEqual(['a.md', 'b.md']);
    expect(orphans.every((f) => f.severity === 'warn')).toBe(true);
  });
});

describe('engine plumbing', () => {
  it('sorts findings by (path, line, column)', () => {
    const config = configWithLint({});
    const { manifest, bodies } = makeManifest(
      {
        'b.md': '# Top\n\n### Skip\n',
        'a.md': '## Setup\n\n## Setup\n'
      },
      config
    );
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(report.findings.map((f) => f.path)).toEqual(['a.md', 'b.md']);
  });

  it('returns empty findings for a clean project', () => {
    const { manifest, bodies } = makeManifest({
      'a.md': '# Top\n\n## Section\n\n[link](b.md)\n',
      'b.md': '# B\n'
    });
    const report = runProjectLint({
      manifest,
      bodies,
      deadLinks: [],
      orphanedFiles: []
    });
    expect(report.findings).toEqual([]);
  });
});
