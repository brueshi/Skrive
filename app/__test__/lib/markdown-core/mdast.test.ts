// Direct coverage of the shared parser (markdown-core/mdast.ts): the
// flowSoftBreaks normalization, the deliberately-narrow GFM scope (tables,
// strikethrough, task lists — and NOT literal autolinks), and the preservation
// of newlines inside code where flowing them would be wrong (SKR-193).

import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../../src/lib/markdown-core/mdast';
import type { Code, Paragraph, PhrasingContent, Table } from 'mdast';

function firstParagraph(md: string): PhrasingContent[] {
  const first = parseMarkdown(md).children[0];
  expect(first?.type).toBe('paragraph');
  return (first as Paragraph).children;
}

describe('flowSoftBreaks', () => {
  it('flows a paragraph soft break to a space (presentation, not content)', () => {
    const kids = firstParagraph('alpha\nbeta');
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ type: 'text', value: 'alpha beta' });
  });

  it('keeps a hard break (two trailing spaces) as a distinct break node', () => {
    const kids = firstParagraph('alpha  \nbeta');
    expect(kids.some((k) => k.type === 'break')).toBe(true);
    // The text either side is not merged across the hard break.
    expect(kids.map((k) => k.type)).toContain('text');
  });

  it('does not flow newlines inside a fenced code block', () => {
    const first = parseMarkdown('```\na\nb\n```').children[0];
    expect(first?.type).toBe('code');
    expect((first as Code).value).toBe('a\nb');
  });
});

describe('GFM scope is deliberately narrow', () => {
  it('models tables', () => {
    const first = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |').children[0];
    expect(first?.type).toBe('table');
    expect((first as Table).children.length).toBe(2); // header + one row
  });

  it('models strikethrough as a delete node', () => {
    expect(firstParagraph('~~gone~~')[0]).toMatchObject({ type: 'delete' });
  });

  it('models task list items with a checked flag', () => {
    const list = parseMarkdown('- [x] done\n- [ ] todo').children[0];
    expect(list?.type).toBe('list');
    const items = (list as { children: Array<{ checked?: boolean | null }> }).children;
    expect(items[0]?.checked).toBe(true);
    expect(items[1]?.checked).toBe(false);
  });

  it('does NOT auto-link a bare URL (literal autolinks stay plain text)', () => {
    // gfm-autolink-literal is intentionally not enabled, so a bare URL must
    // remain frozen text rather than silently gaining link syntax on edit.
    const kids = firstParagraph('see https://example.com now');
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ type: 'text' });
    expect(kids.some((k) => k.type === 'link')).toBe(false);
  });
});
