// Paste round-trip corpus (SKR-119). The fixtures under ./fixtures are *real*
// clipboard captures (the exact text/html + text/plain a web page, a Notion
// page, and an Obsidian note put on the clipboard), grabbed with the dev
// capture harness. These tests assert the two pure halves of the paste path:
//
//   text/html  -> markdownForPaste -> canonical, cruft-free Markdown
//   Markdown   -> parseDocument    -> real blocks (headings, lists, code, …)
//
// Caret placement and the split-and-insert seam are surface/DOM behaviour and
// are verified in the real shell (jsdom can't model WKWebView selection) — see
// project_wkwebview_caret_blindspot.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownForPaste } from '../../src/lib/clipboard/htmlToMarkdown';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';
import web from './fixtures/web-anthropic.json';
import notion from './fixtures/notion-typescript.json';
import obsidian from './fixtures/obsidian-reading-brussel.json';

// Markers that betray HTML cruft surviving into the Markdown — if any appears,
// the clean pipeline let source-specific noise through.
const CRUFT = [
  'style=',
  'class=',
  '<span',
  '<div',
  '<head',
  'Apple-converted-space',
  'font-weight',
  'box-sizing',
  '-webkit-'
];

function blockTypes(md: string): string[] {
  return parseDocument(md).blocks.map((b: BlockNode) => b.type);
}

function expectNoCruft(md: string): void {
  for (const marker of CRUFT) {
    expect(md, `cruft marker "${marker}" leaked into the Markdown`).not.toContain(marker);
  }
}

describe('paste: text/html -> clean Markdown', () => {
  it('web page (anthropic) converts to cruft-free Markdown with real structure', () => {
    const md = htmlToMarkdown(web.data['text/html']);
    expectNoCruft(md);
    // Headings keep their level and are NOT wrapped in redundant bold.
    expect(md).toContain('## Introduction');
    expect(md).toContain('## Cadences');
    expect(md).not.toContain('## **Introduction**');
    // Links and lists survive.
    expect(md).toContain('](https://www.anthropic.com/research/clio)');
    const types = blockTypes(md);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bullet_list');
  });

  it('notion page collapses Apple-converted-space spans and keeps inline code/marks', () => {
    const md = htmlToMarkdown(notion.data['text/html']);
    expectNoCruft(md);
    // Inline code, bold, and italic round-trip; spans collapse to single spaces.
    expect(md).toContain('### Variables: `let`, `const`, and `var`');
    expect(md).toContain('**scope**');
    expect(md).toContain('*rules*');
    expect(md).not.toMatch(/\bvar`{2,}/); // no doubled backticks from span seams
    // Notion's escaped <aside> callout folds into a blockquote, not literal text.
    expect(md).not.toContain('aside');
    expect(md).toContain('> `var` is function-scoped');
    const types = blockTypes(md);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('blockquote');
  });

  it('obsidian (reading mode) preserves fenced code blocks and horizontal rules', () => {
    const md = htmlToMarkdown(obsidian.data['text/html']);
    expectNoCruft(md);
    expect(md).toContain('# Brussel — Technical Architecture');
    expect(md).toContain('---'); // <hr> -> thematic break
    expect(md).toContain('```'); // <pre><code> -> fenced code block
    expect(md).toContain('React Native'); // the ASCII diagram content survives
    const types = blockTypes(md);
    expect(types).toContain('heading');
    expect(types).toContain('horizontal_rule');
    expect(types).toContain('code_block');
  });
});

describe('paste: markdownForPaste gating', () => {
  it('returns null for blank or content-free HTML so the caller pastes plain text', () => {
    expect(markdownForPaste('')).toBeNull();
    expect(markdownForPaste('   ')).toBeNull();
    expect(markdownForPaste('<head><meta charset="UTF-8"></head>')).toBeNull();
  });

  it('returns Markdown for real rich HTML', () => {
    expect(markdownForPaste(notion.data['text/html'])).toContain('`const`');
  });
});

describe('paste: text/plain Markdown -> blocks (Obsidian source-mode path)', () => {
  // Obsidian source/edit-mode copy puts literal Markdown on text/plain with no
  // usable text/html; the full-round-trip path parses it straight into blocks.
  it('parses literal Markdown into the matching block types', () => {
    const md = [
      '# Title',
      '',
      'A paragraph with **bold** and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '> a quote',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |'
    ].join('\n');
    const types = blockTypes(md);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'bullet_list',
      'blockquote',
      'code_block',
      'table'
    ]);
  });

  it('round-trips wikilinks and tags as literal text (no Obsidian-only parsing)', () => {
    // Skrive does not model [[wikilinks]] or #tags; they must survive verbatim as
    // paragraph text rather than being dropped or mangled.
    const md = 'See [[Some Note]] and #project for context.';
    const blocks = parseDocument(md).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('paragraph');
  });
});
