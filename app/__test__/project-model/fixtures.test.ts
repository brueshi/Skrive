// Fixture-driven correctness oracle. Loads every .md under each
// fixture root, builds the LinkGraph, and asserts forward / backward /
// dead-link state against the canonical manifest in
// docs/fixtures/link-graph/expected.ts. A regression in extraction or
// graph maintenance trips here regardless of whether the bug is in
// the parser, the LinkGraph mutation logic, or path resolution.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { extract } from '../../src/lib/project-model/link-graph/extract';
import { LinkGraph } from '../../src/lib/project-model/link-graph/graph';
import {
  ADVERSARIAL_FIXTURE,
  SMALL_FIXTURE,
  type ExpectedFixture
} from '../../../docs/fixtures/link-graph/expected';

const FIXTURES_ROOT = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'fixtures',
  'link-graph'
);

function walkMarkdown(dir: string, root: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      walkMarkdown(full, root, out);
    } else if (name.endsWith('.md')) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out;
}

function buildGraph(fixtureName: string): {
  graph: LinkGraph;
  filePaths: Set<string>;
} {
  const root = resolve(FIXTURES_ROOT, fixtureName);
  const filePaths = new Set<string>();
  const graph = new LinkGraph();
  for (const relPath of walkMarkdown(root, root)) {
    filePaths.add(relPath);
    const body = readFileSync(resolve(root, relPath), 'utf8');
    graph.setLinks(relPath, extract(body, relPath));
  }
  return { graph, filePaths };
}

function assertFixture(name: string, expected: ExpectedFixture): void {
  const { graph, filePaths } = buildGraph(name);

  // Forward: each source's outgoing target+kind list matches expected.
  for (const [source, expEdges] of Object.entries(expected.forward)) {
    const got = graph.outgoing(source) ?? [];
    const gotShape = got.map((e) =>
      e.target.kind === 'relative'
        ? { target: e.target.path, targetKind: 'relative', kind: e.kind }
        : { target: e.target.name, targetKind: 'wiki', kind: e.kind }
    );
    expect(gotShape, `forward edges for ${source}`).toEqual(expEdges);
  }

  // Backward: every expected target → source set matches.
  for (const [target, expSources] of Object.entries(expected.backward)) {
    const got = graph.incoming(target);
    expect(got.sort(), `backward sources for ${target}`).toEqual(
      [...expSources].sort()
    );
  }

  // Dead links: walk every edge whose target is `relative` and not in
  // the project's file set, compare against expected.deadLinks.
  const dead: Array<{ source: string; target: string; kind: string }> = [];
  for (const [source, edges] of graph.iter()) {
    for (const e of edges) {
      if (e.target.kind !== 'relative') continue;
      if (filePaths.has(e.target.path)) continue;
      dead.push({ source, target: e.target.path, kind: e.kind });
    }
  }
  expect(dead).toEqual(expected.deadLinks);
}

describe('link-graph fixture parity', () => {
  it('small fixture matches expected graph', () => {
    assertFixture('small', SMALL_FIXTURE);
  });

  it('adversarial fixture matches expected graph', () => {
    assertFixture('adversarial', ADVERSARIAL_FIXTURE);
  });
});
