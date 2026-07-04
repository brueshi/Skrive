// Plain-text mode (SKR-204): the mode decision and the save path. A `.txt` opens
// in `text` mode and saves its body verbatim — no frontmatter, no serializer.

import { describe, expect, it } from 'vitest';
import { fileMode } from '../../src/stores/save/file-mode';
import { buildSavePayload } from '../../src/stores/save';

describe('fileMode', () => {
  it('routes by extension: .folio -> rich, .txt/.text -> text, .html/.htm -> view, else markdown', () => {
    expect(fileMode('doc.folio')).toBe('rich');
    expect(fileMode('a/log.txt')).toBe('text');
    expect(fileMode('notes.TEXT')).toBe('text');
    expect(fileMode('page.html')).toBe('view'); // SKR-205: read-only viewer
    expect(fileMode('legacy.HTM')).toBe('view');
    expect(fileMode('readme.md')).toBe('markdown');
  });
});

describe('buildSavePayload — text mode', () => {
  it('writes the body verbatim, with no frontmatter serialization', () => {
    const body = '---\nnot: frontmatter\n---\n\nJust some plain text.\n';
    expect(buildSavePayload({ mode: 'text', body, frontmatter: {} })).toBe(body);
  });

  it('does not tidy whitespace or append a trailing newline', () => {
    const body = 'line with trailing spaces   \n\n\nno final newline';
    expect(buildSavePayload({ mode: 'text', body, frontmatter: {} })).toBe(body);
  });
});

describe('buildSavePayload — view mode', () => {
  it('throws: a read-only viewer (`.html`, SKR-205) has no save path', () => {
    // The defensive invariant — a view tab never goes dirty, so this is never
    // reached in practice, but the throw guarantees no view file can be persisted.
    expect(() =>
      buildSavePayload({ mode: 'view', body: '<h1>Hi</h1>', frontmatter: {} })
    ).toThrow(/read-only/i);
  });
});
