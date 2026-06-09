// The dirty-path fidelity gate. The clean path is byte-identical by
// construction (realdocs.test.ts); this file stresses the OTHER half of the
// bet: when every block is dirtied, canonical serialization must still mean
// the same document. Byte identity is not the bar here — accepted
// normalizations (setext->ATX, `_em_`->`*em*`, indented->fenced code,
// entity decoding, two-space->backslash hard breaks) all change bytes — but
// every one of them re-parses to an mdast-equal tree, so strict tree equality
// via the serializer's own mdastEqual is the gate.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../../src/lib/projection/schema';
import { parseDoc } from '../../../src/lib/projection/parse';
import { serializeDoc, mdastEqual } from '../../../src/lib/projection/serialize';
import { parseMarkdown } from '../../../src/lib/projection/mdast';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

// Mark every top-level block dirty. Frozen blocks carry no dirty attr (they are
// verbatim by construction), so they pass through untouched.
function dirtyAll(doc: PMNode): PMNode {
  const blocks = childrenOf(doc).map((b) =>
    b.type.name === 'frozen_block'
      ? b
      : schema.node(b.type.name, { ...b.attrs, dirty: true }, b.content, b.marks)
  );
  return schema.node('doc', doc.attrs, blocks);
}

// Serialize with every block dirtied, then assert the output parses to the
// same mdast tree as the original.
function expectDirtySemanticIdentity(md: string, label: string): void {
  const out = serializeDoc(dirtyAll(parseDoc(md)));
  if (!mdastEqual(parseMarkdown(out), parseMarkdown(md))) {
    throw new Error(
      `dirty-all serialization changed the parse of ${label}\n--- original ---\n${md}\n--- serialized ---\n${out}`
    );
  }
  expect(mdastEqual(parseMarkdown(out), parseMarkdown(md))).toBe(true);
}

// ---- corpus sweep (same corpus realdocs.test.ts walks, plus fixture.md) ----

function mdFilesIn(rel: string): string[] {
  const dir = join(repoRoot, rel);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(rel, f));
  } catch {
    return [];
  }
}

const targets = [...mdFilesIn('planning'), ...mdFilesIn('docs/fixtures')];

describe('dirty-all corpus gate', () => {
  it('found docs to test', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it('fixture.md survives dirty-all semantically', () => {
    const md = readFileSync(resolve(here, 'fixture.md'), 'utf8');
    expectDirtySemanticIdentity(md, 'fixture.md');
  });

  it.each(targets)('survives dirty-all semantically: %s', (rel) => {
    const md = readFileSync(join(repoRoot, rel), 'utf8');
    expectDirtySemanticIdentity(md, rel);
  });
});

// ---- targeted dirty-path fixes ----

function topBlock(doc: PMNode, index = 0): PMNode {
  const block = childrenOf(doc)[index];
  if (!block) throw new Error(`no block at index ${index}`);
  return block;
}

// A genuine edit (not just the dirty flag): append plain text to the block's
// inline content so the idempotence guard cannot restore the original bytes
// and the canonical serializer is actually exercised.
function appendText(doc: PMNode, blockIndex: number, text: string): PMNode {
  const blocks = childrenOf(doc);
  const target = blocks[blockIndex];
  if (!target) throw new Error(`no block at index ${blockIndex}`);
  blocks[blockIndex] = schema.node(
    target.type.name,
    { ...target.attrs, dirty: true },
    [...childrenOf(target), schema.text(text)],
    target.marks
  );
  return schema.node('doc', doc.attrs, blocks);
}

describe('F1 — inline images survive a dirtied paragraph', () => {
  it('keeps a plain image through a genuine edit', () => {
    const md = 'Before ![alt text](img.png) after.\n';
    const out = serializeDoc(appendText(parseDoc(md), 0, ' X'));
    expect(out).toContain('![alt text](img.png)');
    const para = parseMarkdown(out).children[0];
    expect(para?.type).toBe('paragraph');
    const kinds = (para as { children: { type: string }[] }).children.map((c) => c.type);
    expect(kinds).toContain('image');
  });

  it('keeps an image title through a genuine edit', () => {
    const md = 'See ![alt](pic.png "the title").\n';
    const out = serializeDoc(appendText(parseDoc(md), 0, ' X'));
    const para = parseMarkdown(out).children[0] as {
      children: { type: string; url?: string; alt?: string; title?: string | null }[];
    };
    const image = para.children.find((c) => c.type === 'image');
    expect(image).toMatchObject({ url: 'pic.png', alt: 'alt', title: 'the title' });
  });

  it('keeps an image inside a link (the link rides as a mark)', () => {
    const md = '[![badge](b.svg)](https://ci.example)\n';
    expectDirtySemanticIdentity(md, 'linked image');
  });
});

describe('F1 — unmappable inline constructs freeze the block', () => {
  it('a paragraph with a reference-style link freezes', () => {
    const md = 'Uses a [reference][ref] link.\n\n[ref]: https://example.com\n';
    const doc = parseDoc(md);
    expect(topBlock(doc, 0).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('a paragraph with a reference-style image freezes', () => {
    const md = 'An image ![alt][img] here.\n\n[img]: pic.png\n';
    const doc = parseDoc(md);
    expect(topBlock(doc, 0).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('a paragraph with inline html freezes', () => {
    const md = 'Press <kbd>Cmd</kbd> to run.\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });

  it('a container holding an unmappable inline construct freezes whole', () => {
    const md = '> quoted <em>html</em> inside\n';
    const doc = parseDoc(md);
    expect(topBlock(doc).type.name).toBe('frozen_block');
    expect(serializeDoc(doc)).toBe(md);
  });
});

describe('F1 — link titles survive a dirtied paragraph', () => {
  it('emits the captured title on a genuine edit', () => {
    const md = 'A [link](https://x.dev "stay put") here.\n';
    const out = serializeDoc(appendText(parseDoc(md), 0, ' X'));
    const para = parseMarkdown(out).children[0] as {
      children: { type: string; url?: string; title?: string | null }[];
    };
    const link = para.children.find((c) => c.type === 'link');
    expect(link).toMatchObject({ url: 'https://x.dev', title: 'stay put' });
  });
});

describe('F3 — canonical inline escaping', () => {
  it('backslash escapes survive: \\*stars\\* stays literal text', () => {
    const md = 'Keep \\*stars\\* literal.\n';
    const out = serializeDoc(appendText(parseDoc(md), 0, ' X'));
    const para = parseMarkdown(out).children[0] as { children: { type: string; value?: string }[] };
    expect(para.children.every((c) => c.type === 'text')).toBe(true);
    expect(para.children.map((c) => c.value).join('')).toBe('Keep *stars* literal. X');
  });

  it.each([
    ['> not a quote', 'paragraph'],
    ['# not a heading', 'paragraph'],
    ['1. not a list', 'paragraph'],
    ['- not a bullet', 'paragraph']
  ])('a paragraph starting with %j stays a paragraph', (text, expected) => {
    // Built fresh (src null) so serialization is forced canonical.
    const para = schema.node('paragraph', { src: null, gapBefore: '', dirty: true }, [
      schema.text(text)
    ]);
    const out = serializeDoc(schema.node('doc', { trailingGap: '' }, [para]));
    const tree = parseMarkdown(out);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.type).toBe(expected);
    const parsed = tree.children[0] as { children: { value?: string }[] };
    expect(parsed.children.map((c) => c.value).join('')).toBe(text);
  });

  it('a code span containing backticks gets a longer fence', () => {
    const para = schema.node('paragraph', { src: null, gapBefore: '', dirty: true }, [
      schema.text('a ` b', [schema.marks.code.create()])
    ]);
    const out = serializeDoc(schema.node('doc', { trailingGap: '' }, [para]));
    const parsed = parseMarkdown(out).children[0] as {
      children: { type: string; value?: string }[];
    };
    const code = parsed.children.find((c) => c.type === 'inlineCode');
    expect(code?.value).toBe('a ` b');
  });

  it('emphasis spanning a hard break stays one emphasis node', () => {
    const md = 'so *em over a\\\nbreak* holds\n';
    expectDirtySemanticIdentity(md, 'emphasis-spanning break');
  });

  it('mark transitions inside emphasis reconstruct the nesting (*a**b***)', () => {
    const md = 'shape: *a**b*** here\n';
    expectDirtySemanticIdentity(md, 'nested attention');
  });
});

describe('F4 — fence fidelity', () => {
  it('a ~~~ fence whose body contains ``` lines survives a genuine edit', () => {
    const md = '~~~\nsome\n```\ninner\n```\n~~~\n';
    const doc = parseDoc(md);
    const block = topBlock(doc);
    const edited = schema.node(
      'code_block',
      { ...block.attrs, dirty: true },
      [schema.text(`${block.textContent}\nmore`)]
    );
    const out = serializeDoc(schema.node('doc', doc.attrs, [edited]));
    const tree = parseMarkdown(out);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.type).toBe('code');
    expect((tree.children[0] as { value: string }).value).toBe('some\n```\ninner\n```\nmore');
    expect(out.startsWith('~~~')).toBe(true);
  });

  it('a backtick fence lengthens past a backtick run typed into the body', () => {
    const md = '```\ncode\n```\n';
    const doc = parseDoc(md);
    const block = topBlock(doc);
    const edited = schema.node(
      'code_block',
      { ...block.attrs, dirty: true },
      [schema.text('code\n```\nmore')]
    );
    const out = serializeDoc(schema.node('doc', doc.attrs, [edited]));
    const tree = parseMarkdown(out);
    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as { value: string }).value).toBe('code\n```\nmore');
  });

  it('fence meta (the info string after the lang) survives a genuine edit', () => {
    const md = '```ts twoslash\nconst x = 1;\n```\n';
    const doc = parseDoc(md);
    const block = topBlock(doc);
    expect(block.attrs.meta).toBe('twoslash');
    const edited = schema.node(
      'code_block',
      { ...block.attrs, dirty: true },
      [schema.text('const x = 2;')]
    );
    const out = serializeDoc(schema.node('doc', doc.attrs, [edited]));
    expect(out).toContain('```ts twoslash\n');
    const tree = parseMarkdown(out).children[0] as { lang?: string | null; meta?: string | null };
    expect(tree.lang).toBe('ts');
    expect(tree.meta).toBe('twoslash');
  });

  it('a dirty-but-unchanged ~~~ fence restores its bytes via the guard', () => {
    const md = '~~~py\nprint(1)\n~~~\n';
    expectDirtySemanticIdentity(md, 'tilde fence');
    const out = serializeDoc(dirtyAll(parseDoc(md)));
    expect(out).toBe(md);
  });
});

describe('F5 — hard break inside a heading cannot split the block', () => {
  it('an ATX-depth heading (3+) collapses the break to a space', () => {
    const heading = schema.node('heading', { level: 3, src: null, gapBefore: '', dirty: true }, [
      schema.text('a'),
      schema.nodes.hard_break.create(),
      schema.text('b')
    ]);
    const out = serializeDoc(schema.node('doc', { trailingGap: '' }, [heading]));
    expect(out).toBe('### a b');
    const tree = parseMarkdown(out);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.type).toBe('heading');
  });

  it('a depth-1 heading keeps the break by going setext (still one heading)', () => {
    const heading = schema.node('heading', { level: 1, src: null, gapBefore: '', dirty: true }, [
      schema.text('a'),
      schema.nodes.hard_break.create(),
      schema.text('b')
    ]);
    const out = serializeDoc(schema.node('doc', { trailingGap: '' }, [heading]));
    const tree = parseMarkdown(out);
    expect(tree.children).toHaveLength(1);
    const parsed = tree.children[0] as { type: string; depth?: number; children: { type: string }[] };
    expect(parsed.type).toBe('heading');
    expect(parsed.depth).toBe(1);
    expect(parsed.children.map((c) => c.type)).toContain('break');
  });
});

describe('per-item spread — a loose list can hold a tight item', () => {
  // Found by the corpus gate: serializeList used to join the blocks WITHIN an
  // item by the LIST's spread, so a loose list whose item packed a nested
  // sub-list right under its intro paragraph gained a blank line on dirty
  // serialization, flipping the re-parsed listItem.spread.
  it('keeps a tight item tight inside a loose list when dirtied', () => {
    const md = '1. intro:\n   - a\n   - b\n\n2. second\n';
    expectDirtySemanticIdentity(md, 'loose list, tight item');
    expect(serializeDoc(dirtyAll(parseDoc(md)))).toBe(md);
  });

  it('keeps a spread item spread', () => {
    const md = '- first paragraph\n\n  second paragraph\n';
    const item = topBlock(parseDoc(md)).child(0);
    expect(item.attrs.spread).toBe(true);
    expectDirtySemanticIdentity(md, 'spread item');
  });
});

describe('accepted normalizations still parse equal (spot checks)', () => {
  it.each([
    ['setext heading', 'Title\n=====\n\nbody\n'],
    ['underscore emphasis', 'an _emphasis_ form\n'],
    ['indented code', '    indented code\n'],
    ['autolink', 'see <https://example.com> now\n'],
    ['entity', 'fish &amp; chips\n'],
    ['two-space hard break', 'line one  \nline two\n']
  ])('%s', (_label, md) => {
    expectDirtySemanticIdentity(md, _label);
  });
});
