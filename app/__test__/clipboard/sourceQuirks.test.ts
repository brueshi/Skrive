// SKR-186 / F30, F31 — structural quirks of the HTML specific applications put on
// the clipboard. Each `describe` is one source being wrong in its own way; each
// "leaves alone" case is the guard that keeps the rule from eating something a
// different source meant.

import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/lib/clipboard/htmlToMarkdown';

describe('Word lists', () => {
  // Word renders the bullet as literal content wrapped in downlevel-revealed
  // conditional comments, and marks the paragraph with a class + an mso-list style.
  const bullets =
    '<p class="MsoListParagraph"><!--[if !supportLists]--><span>·<span>&nbsp;&nbsp;</span></span><!--[endif]-->first</p>' +
    '<p class="MsoListParagraph"><!--[if !supportLists]--><span>·<span>&nbsp;</span></span><!--[endif]-->second</p>';

  it('becomes a real bullet list, with no comment junk or bullet glyph', () => {
    const md = htmlToMarkdown(bullets);
    expect(md).toBe('- first\n- second');
    expect(md).not.toContain('supportLists');
    expect(md).not.toContain('·');
  });

  it('reads a numeric marker as an ordered list', () => {
    const html =
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span>1.<span>&nbsp;</span></span><!--[endif]-->one</p>' +
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><!--[if !supportLists]--><span>2.<span>&nbsp;</span></span><!--[endif]-->two</p>';
    expect(htmlToMarkdown(html)).toBe('1. one\n2. two');
  });

  it('leaves an ordinary paragraph alone', () => {
    expect(htmlToMarkdown('<p>just prose</p>')).toBe('just prose');
  });
});

describe('HTML comments', () => {
  it('are stripped rather than carried into the document', () => {
    expect(htmlToMarkdown('<p>a<!-- hidden -->b</p>')).toBe('ab');
  });
});

describe('Google Docs lists', () => {
  it('a lone paragraph inside a list item unwraps, so the list is tight', () => {
    expect(htmlToMarkdown('<ul><li><p>one</p></li><li><p>two</p></li></ul>')).toBe('- one\n- two');
  });

  // A list item with several blocks is genuinely loose; unwrapping would lose one.
  it('leaves a multi-block list item loose', () => {
    expect(htmlToMarkdown('<ul><li><p>one</p><p>two</p></li></ul>')).toBe('- one\n\n  two');
  });
});

describe('<br> runs', () => {
  it('a run of two becomes a paragraph split, not two lone backslashes', () => {
    expect(htmlToMarkdown('<p>one<br><br>two</p>')).toBe('one\n\ntwo');
  });

  it('three or more still make one split', () => {
    expect(htmlToMarkdown('<p>one<br><br><br>two</p>')).toBe('one\n\ntwo');
  });

  // A single <br> is a real hard break — the thing Shift+Enter produces.
  it('a single <br> stays a hard break', () => {
    expect(htmlToMarkdown('<p>one<br>two</p>')).toBe('one\\\ntwo');
  });
});

describe('code from an editor', () => {
  it('a monospace root becomes a fenced block, not a run of paragraphs', () => {
    const html = '<div style="font-family: Menlo, monospace"><div>const x = 1;</div><div>const y = 2;</div></div>';
    expect(htmlToMarkdown(html)).toBe('```\nconst x = 1;\nconst y = 2;\n```');
  });

  it('recognizes a generic monospace stack', () => {
    const html = '<div style="font-family: monospace"><div>a()</div><div>b()</div></div>';
    expect(htmlToMarkdown(html)).toBe('```\na()\nb()\n```');
  });

  // The rule fires only at the fragment root. Inline monospace inside prose is a
  // code span or a font choice, never a block — Docs uses it for inline code.
  it('leaves an inline monospace span inside prose alone', () => {
    expect(htmlToMarkdown('<p>use <span style="font-family: monospace">npm</span> here</p>')).toBe('use npm here');
  });
});

describe('bare URLs', () => {
  it('serialize as an autolink rather than an escaped scheme', () => {
    const md = htmlToMarkdown('<p>see https://example.com for more</p>');
    expect(md).toBe('see <https://example.com> for more');
    expect(md, 'the escape that lost the autolink is gone').not.toContain('https\\:');
  });

  it('picks up several in one paragraph', () => {
    const md = htmlToMarkdown('<p>http://a.test and https://b.test</p>');
    expect(md).toBe('<http://a.test> and <https://b.test>');
  });

  it('leaves a URL inside an existing link alone', () => {
    expect(htmlToMarkdown('<p><a href="https://example.com">https://example.com</a></p>')).toBe(
      '<https://example.com>'
    );
  });

  it('leaves a URL inside a code span alone', () => {
    expect(htmlToMarkdown('<p><code>https://example.com</code></p>')).toBe('`https://example.com`');
  });

  it('does not swallow trailing punctuation', () => {
    expect(htmlToMarkdown('<p>see https://example.com.</p>')).toBe('see <https://example.com>.');
  });
});

describe('Notion callouts', () => {
  // The gate tested a whole-string anchor, so a callout at the very START of a
  // paste fell through unconverted while one further down worked.
  it('converts an aside at the very start of the paste', () => {
    expect(htmlToMarkdown('<p>&lt;aside&gt;</p><p>body</p><p>&lt;/aside&gt;</p>')).toBe('> body');
  });

  it('still converts one further down', () => {
    expect(htmlToMarkdown('<p>intro</p><p>&lt;aside&gt;</p><p>body</p><p>&lt;/aside&gt;</p>')).toBe('intro\n\n> body');
  });

  it('leaves prose that merely mentions <aside> alone', () => {
    expect(htmlToMarkdown('<p>the &lt;aside&gt; element is useful</p>')).toBe('the \\<aside> element is useful');
  });
});
