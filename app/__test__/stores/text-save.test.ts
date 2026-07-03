// Plain-text mode (SKR-204): the mode decision and the save path. A `.txt` opens
// in `text` mode and saves its body verbatim — no frontmatter, no serializer.

import { describe, expect, it } from 'vitest';
import { fileMode } from '../../src/stores/save/file-mode';
import { buildSavePayload } from '../../src/stores/save';

describe('fileMode', () => {
  it('routes by extension: .folio -> rich, .txt/.text -> text, else markdown', () => {
    expect(fileMode('doc.folio')).toBe('rich');
    expect(fileMode('a/log.txt')).toBe('text');
    expect(fileMode('notes.TEXT')).toBe('text');
    expect(fileMode('readme.md')).toBe('markdown');
    expect(fileMode('page.html')).toBe('markdown'); // until SKR-205 gives it a view
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
