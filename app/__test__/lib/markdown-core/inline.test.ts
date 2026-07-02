// Direct coverage of the canonical inline serializer (markdown-core/inline.ts):
// CommonMark escaping, code-span fence widening, mark-wrapper nesting, and the
// heading level clamp. Previously exercised only transitively through the block
// serializer (SKR-193 / gate appendix). The strongest assertions re-parse the
// emitted Markdown and check it means what the InlineItem said — that is exactly
// the contract the module owns: emit Markdown that re-parses to the same tree.

import { describe, it, expect } from 'vitest';
import {
  type InlineItem,
  type LinkRef,
  sameInlineContext,
  inlineItemsToParagraphMarkdown,
  inlineItemsToHeadingMarkdown
} from '../../../src/lib/markdown-core/inline';
import { parseMarkdown } from '../../../src/lib/markdown-core/mdast';
import type { Paragraph, PhrasingContent } from 'mdast';

type Marks = { em?: boolean; strong?: boolean; strikethrough?: boolean; link?: LinkRef | null };

const txt = (text: string, m: Marks = {}): InlineItem => ({
  kind: 'text',
  text,
  em: !!m.em,
  strong: !!m.strong,
  strikethrough: !!m.strikethrough,
  link: m.link ?? null
});
const code = (text: string, m: Marks = {}): InlineItem => ({
  kind: 'code',
  text,
  em: !!m.em,
  strong: !!m.strong,
  strikethrough: !!m.strikethrough,
  link: m.link ?? null
});

// The phrasing children of the sole paragraph the emitted Markdown parses to.
function phrasingOf(md: string): PhrasingContent[] {
  const root = parseMarkdown(md);
  const first = root.children[0];
  expect(first?.type).toBe('paragraph');
  return (first as Paragraph).children;
}

describe('inlineItemsToParagraphMarkdown — escaping', () => {
  it('escapes inline markup in plain text so it re-parses literally', () => {
    const md = inlineItemsToParagraphMarkdown([txt('*not emphasis*')]);
    // The asterisks must be escaped in the emitted source...
    expect(md).toContain('\\*');
    // ...and the round trip must yield a single literal text node, not emphasis.
    const kids = phrasingOf(md);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ type: 'text', value: '*not emphasis*' });
  });

  it('escapes a line-start block opener so it is not read as a blockquote', () => {
    const md = inlineItemsToParagraphMarkdown([txt('> quote')]);
    const root = parseMarkdown(md);
    // A literal "> quote" paragraph, never a blockquote block.
    expect(root.children[0]?.type).toBe('paragraph');
    expect(phrasingOf(md)[0]).toMatchObject({ type: 'text', value: '> quote' });
  });

  it('escapes a backslash so it survives the round trip', () => {
    const md = inlineItemsToParagraphMarkdown([txt('a\\b')]);
    expect(phrasingOf(md)[0]).toMatchObject({ type: 'text', value: 'a\\b' });
  });

  it('returns the empty string for empty content', () => {
    expect(inlineItemsToParagraphMarkdown([])).toBe('');
  });
});

describe('inlineItemsToParagraphMarkdown — marks and nesting', () => {
  it('wraps strong and em in the canonical asterisk style', () => {
    expect(inlineItemsToParagraphMarkdown([txt('x', { strong: true })])).toBe('**x**');
    expect(inlineItemsToParagraphMarkdown([txt('x', { em: true })])).toBe('*x*');
  });

  it('emits strikethrough as ~~…~~ (GFM, SKR-142)', () => {
    const md = inlineItemsToParagraphMarkdown([txt('x', { strikethrough: true })]);
    expect(md).toBe('~~x~~');
    expect(phrasingOf(md)[0]).toMatchObject({ type: 'delete' });
  });

  it('nests coextensive em+strong so the round trip is em-outside-strong', () => {
    const md = inlineItemsToParagraphMarkdown([txt('x', { em: true, strong: true })]);
    const outer = phrasingOf(md)[0];
    expect(outer).toMatchObject({ type: 'emphasis' });
    expect((outer as { children: PhrasingContent[] }).children[0]).toMatchObject({ type: 'strong' });
  });

  it('renders a link with its destination', () => {
    const md = inlineItemsToParagraphMarkdown([txt('label', { link: { href: 'https://x.test', title: null } })]);
    const kid = phrasingOf(md)[0] as { type: string; url?: string };
    expect(kid.type).toBe('link');
    expect(kid.url).toBe('https://x.test');
  });
});

describe('inlineItemsToParagraphMarkdown — code spans', () => {
  it('widens the backtick fence past any run inside the span', () => {
    const md = inlineItemsToParagraphMarkdown([code('a`b')]);
    // A single-backtick fence could not hold "a`b"; the fence must widen.
    expect(md.startsWith('`')).toBe(true);
    const kid = phrasingOf(md)[0];
    expect(kid).toMatchObject({ type: 'inlineCode', value: 'a`b' });
  });

  it('keeps code content verbatim (markup chars are not escaped inside code)', () => {
    const md = inlineItemsToParagraphMarkdown([code('*still code*')]);
    expect(phrasingOf(md)[0]).toMatchObject({ type: 'inlineCode', value: '*still code*' });
  });
});

describe('inlineItemsToHeadingMarkdown', () => {
  it('emits ATX hashes for the given level', () => {
    expect(inlineItemsToHeadingMarkdown([txt('Title')], 2)).toBe('## Title');
  });

  it('clamps the level into 1..6', () => {
    expect(inlineItemsToHeadingMarkdown([txt('x')], 9)).toBe('###### x');
    expect(inlineItemsToHeadingMarkdown([txt('x')], 0)).toBe('# x');
  });
});

describe('sameInlineContext', () => {
  it('is true when every mark matches', () => {
    expect(sameInlineContext(txt('a', { strong: true }), txt('b', { strong: true }))).toBe(true);
  });

  it('is false when a boolean mark differs', () => {
    expect(sameInlineContext(txt('a', { em: true }), txt('b'))).toBe(false);
  });

  it('distinguishes links by destination and title', () => {
    const a = txt('a', { link: { href: 'u1', title: null } });
    const b = txt('b', { link: { href: 'u2', title: null } });
    expect(sameInlineContext(a, b)).toBe(false);
    const c = txt('c', { link: { href: 'u1', title: null } });
    expect(sameInlineContext(a, c)).toBe(true);
  });

  it('treats both-unlinked as the same context and one-linked as different', () => {
    expect(sameInlineContext(txt('a'), txt('b'))).toBe(true);
    expect(sameInlineContext(txt('a'), txt('b', { link: { href: 'u', title: null } }))).toBe(false);
  });
});
