#!/usr/bin/env bun
// Builds a 100-file Markdown project under docs/fixtures/perf-100 for
// the phase-12b cold-open / file-switch / lint-latency budgets.
//
// Each file has YAML frontmatter (title, tags, date), three to five
// paragraphs of placeholder prose, and one to three wiki/inline links
// to other files in the project so the link graph has real work to
// chew on. Output is deterministic: rerunning produces byte-identical
// files (same seed-based pseudo-random generator, no Date.now()).
//
// Run: bun run perf:fixture
//
// The output directory is gitignored — the fixture is reproducible
// from this script alone, and 100 generated files would just be
// noise in `git log` for any future content tweak.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..', 'docs', 'fixtures', 'perf-100');

// Reproducible PRNG (mulberry32). One global stream — order of file
// generation matters for byte-stability.
let seed = 0xc0ffee;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function pickInt(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

const TAG_POOL = [
  'draft',
  'idea',
  'reference',
  'todo',
  'review',
  'archive',
  'character',
  'plot',
  'theme',
  'craft'
];

const PARAGRAPH_POOL = [
  'The structure of the page is the structure of the thought. Every paragraph break is a breath, every section header a decision about what belongs together and what does not.',
  'A draft is a working hypothesis about what the piece is about. Revision is the process of testing that hypothesis against the actual sentences on the page.',
  'There is a difference between writing that wants to be read once and writing that wants to be read again. Both are legitimate; the second is rarer and takes longer.',
  'The blank page is not the problem. The problem is the page that is mostly working — knowing what to keep and what to cut without losing the thread.',
  'Notes are not drafts. Drafts are not pieces. Pieces are not finished work. Each transition is a different kind of attention.',
  'A good link is a promise: the place I am sending you is worth the detour. A bad link is a tax on the reader for clarity I should have put inline.',
  'Frontmatter is metadata, not content. If the reader needs it to follow the prose, it belongs in the prose.',
  'The hardest sentences are the connective ones — the ones that make a paragraph one thing instead of two. Cut them last.',
  'A list is a confession that the items refused to be a paragraph. Sometimes that is right. Often it is laziness.',
  'Every project accumulates files faster than it accumulates structure. The structure is what you build by re-reading.'
];

const TITLE_PREFIXES = [
  'Notes on',
  'Toward',
  'Against',
  'A theory of',
  'After',
  'Before',
  'On reading',
  'On writing',
  'The shape of',
  'The trouble with'
];
const TITLE_SUBJECTS = [
  'revision',
  'voice',
  'pacing',
  'argument',
  'evidence',
  'attention',
  'silence',
  'rhythm',
  'authority',
  'doubt',
  'craft',
  'memory'
];

type FileSpec = {
  path: string;
  title: string;
  date: string;
  tags: string[];
};

// Plan the file set first so links can target real files only.
function planFiles(): FileSpec[] {
  const specs: FileSpec[] = [];
  // Root index.
  specs.push({
    path: 'index.md',
    title: 'Index',
    date: '2026-01-01',
    tags: ['reference']
  });
  // Chapters: 30 files.
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, '0');
    specs.push({
      path: `chapters/chapter-${n}.md`,
      title: `Chapter ${i}`,
      date: dateFor(i, 0),
      tags: ['draft']
    });
  }
  // Notes: 41 files spread across two subdirs.
  for (let i = 1; i <= 26; i++) {
    const n = String(i).padStart(2, '0');
    specs.push({
      path: `notes/loose/${n}.md`,
      title: makeTitle(),
      date: dateFor(i, 1),
      tags: pickTags(1, 3)
    });
  }
  for (let i = 1; i <= 15; i++) {
    const n = String(i).padStart(2, '0');
    specs.push({
      path: `notes/themes/${n}.md`,
      title: makeTitle(),
      date: dateFor(i, 2),
      tags: pickTags(1, 3)
    });
  }
  // Reference: 25 files, including a glossary at the top.
  specs.push({
    path: 'reference/glossary.md',
    title: 'Glossary',
    date: '2026-01-01',
    tags: ['reference']
  });
  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(2, '0');
    specs.push({
      path: `reference/entry-${n}.md`,
      title: `Reference entry ${i}`,
      date: dateFor(i, 3),
      tags: ['reference']
    });
  }
  // Top-level files to round out to 100.
  specs.push({
    path: 'preface.md',
    title: 'Preface',
    date: '2026-01-01',
    tags: ['draft']
  });
  specs.push({
    path: 'epilogue.md',
    title: 'Epilogue',
    date: '2026-12-01',
    tags: ['draft']
  });
  specs.push({
    path: 'colophon.md',
    title: 'Colophon',
    date: '2026-12-15',
    tags: ['reference']
  });
  if (specs.length !== 100) {
    throw new Error(`Expected 100 files, planned ${specs.length}`);
  }
  return specs;
}

function makeTitle(): string {
  return `${pick(TITLE_PREFIXES)} ${pick(TITLE_SUBJECTS)}`;
}

function pickTags(min: number, max: number): string[] {
  const n = pickInt(min, max);
  const chosen = new Set<string>();
  while (chosen.size < n) chosen.add(pick(TAG_POOL));
  return [...chosen].sort();
}

function dateFor(i: number, bucket: number): string {
  // Spread dates across 2026 deterministically by index + bucket.
  const monthIdx = (bucket * 7 + i) % 12;
  const dayIdx = ((bucket + 1) * 13 + i * 3) % 28;
  const month = String(monthIdx + 1).padStart(2, '0');
  const day = String(dayIdx + 1).padStart(2, '0');
  return `2026-${month}-${day}`;
}

function relPath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) {
    i++;
  }
  const ups = fromParts.length - i;
  const tail = toParts.slice(i).join('/');
  return ups > 0 ? `${'../'.repeat(ups)}${tail}` : tail;
}

function buildBody(self: FileSpec, others: FileSpec[]): string {
  const paraCount = pickInt(3, 5);
  const linkCount = pickInt(1, 3);
  const paragraphs: string[] = [];
  for (let i = 0; i < paraCount; i++) {
    paragraphs.push(pick(PARAGRAPH_POOL));
  }
  // Inject links into the first paragraph.
  const targets = new Set<FileSpec>();
  while (targets.size < linkCount && targets.size < others.length) {
    const candidate = others[Math.floor(rand() * others.length)]!;
    if (candidate.path !== self.path) targets.add(candidate);
  }
  const linkSentences = [...targets].map((t, i) => {
    // Mix wiki links and inline links to exercise both parsers.
    if (i % 2 === 0) {
      return `See [[${t.title}]] for context.`;
    }
    const rel = relPath(self.path, t.path);
    return `Compare with [${t.title}](${rel}).`;
  });
  paragraphs[0] = `${paragraphs[0]} ${linkSentences.join(' ')}`;
  return paragraphs.join('\n\n');
}

function buildFile(self: FileSpec, others: FileSpec[]): string {
  const fm = [
    '---',
    `title: ${self.title}`,
    `date: ${self.date}`,
    `tags: [${self.tags.join(', ')}]`,
    '---',
    ''
  ].join('\n');
  return `${fm}\n# ${self.title}\n\n${buildBody(self, others)}\n`;
}

function main() {
  // Wipe + recreate so a stale run with a different file set doesn't
  // leave leftovers.
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const specs = planFiles();
  for (const spec of specs) {
    const full = join(ROOT, spec.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buildFile(spec, specs));
  }

  // A `.skrive.toml` so the project loads with the same lint config
  // shape a real project would have. Empty default — we want the
  // default rule set running, not a custom one.
  writeFileSync(join(ROOT, '.skrive.toml'), '# Generated by scripts/build-perf-fixture.ts\n');

  console.log(`Wrote ${specs.length} files to ${ROOT}`);
}

main();
