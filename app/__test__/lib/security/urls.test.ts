// SKR-187 / F29 — the URL allowlist. These are security fixtures: each blocked
// case is a string that a browser would actually navigate, so a regression here
// is exploitable, not cosmetic.

import { describe, it, expect } from 'vitest';
import { isSafeUrl } from '../../../src/lib/security/urls';

describe('isSafeUrl — allowed', () => {
  const safe = [
    'https://example.com/a?b=c#d',
    'http://example.com',
    'HTTPS://EXAMPLE.COM',
    'mailto:joe@example.com',
    'tel:+15551234',
    'skrive://open/note',
    '//example.com/protocol-relative',
    '#anchor',
    './notes/1.md',
    '../sibling.md',
    'notes/deep/file.md',
    'file with spaces.md'
  ];
  for (const url of safe) {
    it(`allows ${JSON.stringify(url)}`, () => expect(isSafeUrl(url)).toBe(true));
  }
});

describe('isSafeUrl — blocked', () => {
  const unsafe = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', // noscan -- base64 of `<script>alert(1)</script>`, an attack fixture
    'data:image/svg+xml,<svg onload=alert(1)>',
    'file:///etc/passwd',
    'about:blank',
    'blob:https://example.com/uuid',
    ''
  ];
  for (const url of unsafe) {
    it(`blocks ${JSON.stringify(url)}`, () => expect(isSafeUrl(url)).toBe(false));
  }
});

// A browser strips tabs and newlines from a URL wherever they appear, and trims
// leading C0 controls, before it decides what scheme it is looking at. Deciding
// on the raw string instead of the normalized one is the classic bypass.
describe('isSafeUrl — obfuscated schemes still blocked', () => {
  const unsafe = [
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    '\njavascript:alert(1)',
    '  javascript:alert(1)',
    '\x00javascript:alert(1)',
    '\x01javascript:alert(1)',
    'jav\tascript:alert(1)',
    ' \t\n javascript:alert(1)'
  ];
  for (const url of unsafe) {
    it(`blocks ${JSON.stringify(url)}`, () => expect(isSafeUrl(url)).toBe(false));
  }

  it('does not mistake a relative path containing a colon-ish word', () => {
    expect(isSafeUrl('notes/re: meeting.md')).toBe(true);
  });
});
