// Copy-out logic: Markdown -> dual-write payload. Everything with behaviour
// worth pinning lives in this pure function.

import { describe, expect, it } from 'vitest';
import { buildClipboardPayload } from '../../src/lib/clipboard/copyOut';

describe('buildClipboardPayload', () => {
  it('puts the raw Markdown on the plain-text representation verbatim', () => {
    const md = '# Title\n\nSome **bold** text.';
    expect(buildClipboardPayload(md).text).toBe(md);
  });

  it('renders the Markdown to HTML for the rich representation', () => {
    const { html } = buildClipboardPayload('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });
});
