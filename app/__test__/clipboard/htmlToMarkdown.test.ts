// Paste-in conversion oracle. Each case is a small HTML fragment of the kind
// that lands on the clipboard, paired with the canonical Markdown we expect.
//
// The round-trip block additionally proves the converter composes with the
// preview renderer: house-style Markdown -> HTML (marked) -> Markdown (here)
// must return the original. That is the guard against either half drifting out
// of agreement on the house conventions.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownForPaste } from '../../src/lib/clipboard/htmlToMarkdown';
import { renderMarkdown } from '../../src/lib/preview/markdown';

describe('htmlToMarkdown structural conversion', () => {
  const cases: Array<{ name: string; html: string; expected: string }> = [
    { name: 'heading', html: '<h2>Section Title</h2>', expected: '## Section Title' },
    { name: 'bold', html: '<p>a <b>bold</b> word</p>', expected: 'a **bold** word' },
    { name: 'italic', html: '<p>an <i>italic</i> word</p>', expected: 'an *italic* word' },
    {
      name: 'link',
      html: '<p><a href="https://example.com">link</a></p>',
      expected: '[link](https://example.com)'
    },
    {
      name: 'unordered list',
      html: '<ul><li>one</li><li>two</li></ul>',
      expected: '- one\n- two'
    },
    {
      name: 'ordered list',
      html: '<ol><li>first</li><li>second</li></ol>',
      expected: '1. first\n2. second'
    },
    { name: 'inline code', html: '<p>use <code>npm</code></p>', expected: 'use `npm`' },
    {
      name: 'fenced code block',
      html: '<pre><code>const x = 1;</code></pre>',
      expected: '```\nconst x = 1;\n```'
    },
    {
      name: 'blockquote',
      html: '<blockquote><p>quoted</p></blockquote>',
      expected: '> quoted'
    },
    { name: 'strikethrough (gfm)', html: '<p><del>gone</del></p>', expected: '~~gone~~' },
    {
      name: 'table (gfm)',
      html: '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      expected: '| A | B |\n| - | - |\n| 1 | 2 |'
    }
  ];

  for (const { name, html, expected } of cases) {
    it(`converts ${name}`, () => {
      expect(htmlToMarkdown(html)).toBe(expected);
    });
  }

  it('returns an empty string for blank input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   \n  ')).toBe('');
  });
});

describe('htmlToMarkdown drops unrepresentable formatting', () => {
  it('drops inline colour and underline styling, keeping the text', () => {
    const html = '<p>plain <span style="color:red">red</span> <u>under</u></p>';
    expect(htmlToMarkdown(html)).toBe('plain red under');
  });

  it('unwraps Google-Docs fake bold (font-weight:normal)', () => {
    const html = '<p><b style="font-weight:normal">not bold</b></p>';
    expect(htmlToMarkdown(html)).toBe('not bold');
  });

  it('keeps genuine bold alongside cancelled bold', () => {
    const html = '<p><b style="font-weight:normal">plain </b><b>real</b></p>';
    expect(htmlToMarkdown(html)).toBe('plain **real**');
  });
});

// SKR-161: Google Docs and Word carry emphasis as inline style on a <span>
// (font-weight:700, font-style:italic), not as a <b>/<i> tag — so without a
// promotion pass every bold/italic run pasted as plain text. Synthetic fragments
// modelled on the real clipboard shapes (no personal capture is committed).
describe('promotes style-based emphasis (Google Docs / Word)', () => {
  it('promotes a font-weight:700 span to bold', () => {
    const html = '<p><span style="font-weight:700">strong</span> word</p>';
    expect(htmlToMarkdown(html)).toBe('**strong** word');
  });

  it('promotes a font-style:italic span to italic', () => {
    const html = '<p><span style="font-style:italic">slanted</span> word</p>';
    expect(htmlToMarkdown(html)).toBe('*slanted* word');
  });

  it('promotes a span carrying both weight and style', () => {
    const html = '<p><span style="font-weight:700;font-style:italic">both</span></p>';
    expect(htmlToMarkdown(html)).toBe('***both***');
  });

  it('respects the cascade: an inner font-weight:400 span stays plain', () => {
    // Google Docs sets font-weight:700 on the <li> and on the label span, but the
    // value span explicitly resets to 400 — only the label should bold.
    const html =
      '<ul><li style="font-weight:700">' +
      '<span style="font-weight:700">Label</span>' +
      '<span style="font-weight:400">: value</span>' +
      '</li></ul>';
    expect(htmlToMarkdown(html)).toBe('- **Label**: value');
  });

  it('unwraps the Google Docs guid wrapper but keeps the inner styled bold', () => {
    const html =
      '<b style="font-weight:normal"><p><span style="font-weight:700">real</span></p></b>';
    expect(htmlToMarkdown(html)).toBe('**real**');
  });

  it('keeps Word bold that carries mso-bidi-font-weight:normal', () => {
    // The cancel regex used to substring-match this and destroy real Word bold.
    const html = '<p><b style="font-weight:bold;mso-bidi-font-weight:normal">Word bold</b></p>';
    expect(htmlToMarkdown(html)).toBe('**Word bold**');
  });

  it('does not add redundant bold when a styled run fills a heading', () => {
    const html = '<h2><span style="font-weight:700">Title</span></h2>';
    expect(htmlToMarkdown(html)).toBe('## Title');
  });
});

describe('markdownForPaste decision', () => {
  it('returns null for blank or whitespace HTML so plain paste runs', () => {
    expect(markdownForPaste('')).toBeNull();
    expect(markdownForPaste('   \n ')).toBeNull();
  });

  it('returns null when HTML carries no convertible content', () => {
    // A bare clipboard prefix that yields nothing once converted.
    expect(markdownForPaste('<meta charset="utf-8">')).toBeNull();
  });

  it('returns the converted Markdown for real rich HTML', () => {
    expect(markdownForPaste('<p>a <b>bold</b> word</p>')).toBe('a **bold** word');
  });
});

describe('round-trip: house-style Markdown survives render -> convert', () => {
  const samples = [
    '# Title',
    'A paragraph with **bold** and *italic* text.',
    '- one\n- two\n- three',
    '1. first\n2. second',
    '> a quote',
    '`inline code`',
    '[a link](https://example.com)'
  ];

  for (const md of samples) {
    it(`preserves ${JSON.stringify(md)}`, () => {
      expect(htmlToMarkdown(renderMarkdown(md))).toBe(md);
    });
  }
});
