// Fixture-driven correctness oracle for the lint engine. Each fixture
// under `docs/fixtures/lint/<name>/` is a real on-disk project; the
// test rebuilds the manifest the way the shell does (walks markdown,
// parses frontmatter, builds the link graph), runs the engine, and
// asserts deep-equal against the canonical expectations in
// `docs/fixtures/lint/expected.ts`.
//
// Per the migration plan § Fixture preservation: a regression in any
// rule, the engine's sort/dedupe, or `.skrive.toml` parsing should
// trip here regardless of which layer changed.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import {
  inferSchema,
  parseFrontmatter,
  type DeadLink,
  type FileEntry,
  type ProjectManifest
} from '@skrive/shared';
import { extract } from '../../src/lib/project-model/link-graph/extract';
import { LinkGraph } from '../../src/lib/project-model/link-graph/graph';
import { parseSkriveToml } from '@skrive/shared';
import { runProjectLint } from '../../src/lib/lint';
import {
  CLEAN_FIXTURE,
  VIOLATIONS_FIXTURE,
  EDGE_CASES_FIXTURE,
  type ExpectedFixture
} from '../../../docs/fixtures/lint/expected';

const FIXTURES_ROOT = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'fixtures',
  'lint'
);

function walkMarkdown(dir: string, root: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.skrive.toml') continue;
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      walkMarkdown(full, root, out);
    } else if (name.endsWith('.md')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out;
}

function loadFixture(name: string) {
  const root = resolve(FIXTURES_ROOT, name);
  const filePaths = new Set<string>();
  const graph = new LinkGraph();
  const bodies = new Map<string, string>();
  const files: FileEntry[] = [];

  for (const relPath of walkMarkdown(root, root)) {
    const body = readFileSync(resolve(root, relPath), 'utf8');
    bodies.set(relPath, body);
    filePaths.add(relPath);
    graph.setLinks(relPath, extract(body, relPath));
    files.push({
      path: relPath,
      name: relPath.split('/').pop() ?? relPath,
      sizeBytes: body.length,
      modifiedMs: 0,
      frontmatter: parseFrontmatter(body).frontmatter,
      outgoingLinks: []
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  let tomlSource: string | null = null;
  try {
    tomlSource = readFileSync(resolve(root, '.skrive.toml'), 'utf8');
  } catch {
    tomlSource = null;
  }
  const { config, warnings } = parseSkriveToml(tomlSource);

  const manifest: ProjectManifest = {
    root,
    files,
    schema: inferSchema(files),
    config,
    warnings
  };

  // Build the dead-link list the way `linkGraph:getDeadLinks` does.
  const deadLinks: DeadLink[] = [];
  for (const [source, edges] of graph.iter()) {
    for (const edge of edges) {
      if (edge.target.kind !== 'relative') continue;
      if (filePaths.has(edge.target.path)) continue;
      deadLinks.push({
        source,
        target: edge.target.path,
        range: edge.range,
        line: edge.line,
        column: edge.column,
        kind: edge.kind
      });
    }
  }

  const orphanedFiles = graph.orphanedAmong(filePaths);

  return { manifest, bodies, deadLinks, orphanedFiles };
}

function assertFixture(name: string, expected: ExpectedFixture): void {
  const { manifest, bodies, deadLinks, orphanedFiles } = loadFixture(name);
  const report = runProjectLint({ manifest, bodies, deadLinks, orphanedFiles });
  expect(report.findings).toEqual(expected.findings);
}

describe('lint fixtures', () => {
  it('clean: zero findings', () => {
    assertFixture('clean', CLEAN_FIXTURE);
  });

  it('violations: every rule fires at least once', () => {
    assertFixture('violations', VIOLATIONS_FIXTURE);
  });

  it('edge-cases: tricky scenarios behave correctly', () => {
    assertFixture('edge-cases', EDGE_CASES_FIXTURE);
  });
});
