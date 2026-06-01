// Heading ids are what in-document anchor links resolve against, so the
// renderer must emit them, derive them from rendered text content (not
// raw markup), and de-duplicate within a single render pass.

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/lib/preview/markdown';

describe('renderMarkdown heading ids', () => {
  it('assigns a slug id to each heading', () => {
    const html = renderMarkdown('# Getting Started\n\n## Next Steps');
    expect(html).toContain('<h1 id="getting-started">');
    expect(html).toContain('<h2 id="next-steps">');
  });

  it('slugs from text content, ignoring inline markup', () => {
    const html = renderMarkdown('## The **bold** word');
    expect(html).toContain('id="the-bold-word"');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('slugs a link heading from its label, not its url', () => {
    const html = renderMarkdown('## See [the docs](https://example.com)');
    expect(html).toContain('id="see-the-docs"');
  });

  it('de-duplicates repeated headings within one render', () => {
    const html = renderMarkdown('## Notes\n\n## Notes');
    expect(html).toContain('id="notes"');
    expect(html).toContain('id="notes-1"');
  });

  it('resets the deduper between renders', () => {
    renderMarkdown('## Notes');
    const html = renderMarkdown('## Notes');
    expect(html).toContain('id="notes"');
    expect(html).not.toContain('id="notes-1"');
  });

  it('omits the id attribute for a punctuation-only heading', () => {
    const html = renderMarkdown('## !!!');
    expect(html).toMatch(/<h2>!!!<\/h2>/);
  });
});

describe('renderMarkdown GFM + content', () => {
  it('renders a GFM table', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
  });

  it('renders a task list with checkbox inputs', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });

  it('passes raw HTML through untouched (trusted local files)', () => {
    const html = renderMarkdown('before\n\n<div class="callout">hi</div>\n\nafter');
    expect(html).toContain('<div class="callout">hi</div>');
  });
});

describe('renderMarkdown image resolution', () => {
  it('rewrites a Markdown image src through the resolver', () => {
    const html = renderMarkdown('![alt](pic.png)', {
      context: { projectRoot: '/proj', filePath: 'doc.md' },
      resolver: (raw, ctx) => `resolved://${ctx.projectRoot}/${raw}`
    });
    expect(html).toContain('src="resolved:///proj/pic.png"');
    expect(html).toContain('alt="alt"');
  });

  it('leaves the src as-is with the default identity resolver', () => {
    expect(renderMarkdown('![a](pic.png)')).toContain('src="pic.png"');
  });

  it('does not run the resolver on a raw HTML <img> (matches marked)', () => {
    const html = renderMarkdown('<img src="raw.png">', {
      resolver: () => 'SHOULD_NOT_APPLY'
    });
    expect(html).toContain('src="raw.png"');
    expect(html).not.toContain('SHOULD_NOT_APPLY');
  });
});
