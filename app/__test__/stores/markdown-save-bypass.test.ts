// The load-bearing rule, enforced (SKR-196): a Markdown save is text -> text and
// can never reach a serializer. These tests prove the trap ("keep `.md` on the
// block-model pipeline and re-serialize at save") is structurally impossible, not
// merely avoided — a byte-identical passthrough, a source-level import wall, and
// correct mode dispatch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMarkdownPayload } from '../../src/stores/save/markdown-save';
import { buildFolioPayload } from '../../src/stores/save/folio-save';
import { buildSavePayload, fileMode, type SaveTab } from '../../src/stores/save';
import { usePreferencesStore } from '../../src/stores/preferences';
import { folioToModel, serializeFolio } from '../../src/lib/folio';
import { richFixture } from '../folio/fixture';

describe('markdown save is text -> text (byte-in == byte-out)', () => {
  it('writes the body verbatim — a model round-trip would rewrite this', () => {
    usePreferencesStore.setState({ formatOnSave: false });
    // Deliberately non-canonical Markdown: a `+` marker, loose 3-space bullets,
    // and trailing hard-break spaces. parse -> model -> serialize would normalize
    // every one of these; a text -> text save leaves them exactly as typed.
    const body = '+   loose item\n*   another\n\ntrailing break  \nnext line';
    const tab = { body, frontmatter: {} };
    expect(buildMarkdownPayload(tab)).toBe(body);
  });
});

describe('the trap is structurally blocked (import wall)', () => {
  it('markdown-save.ts imports no serializer', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/stores/save/markdown-save.ts', import.meta.url)),
      'utf8'
    );
    // Strip line and block comments so the module's own prose (which names the
    // forbidden symbols to explain the rule) can't create false matches.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [
      'serializeDocument',
      'serializeFolio',
      'modelToFolio',
      'blockmodel/serialize',
      'folio/serialize'
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe('buildSavePayload routes by mode', () => {
  it('sends a markdown tab down the text path', () => {
    usePreferencesStore.setState({ formatOnSave: false });
    const tab: SaveTab = { mode: 'markdown', body: '# hi\n', frontmatter: {} };
    expect(buildSavePayload(tab)).toBe('# hi\n');
  });

  it('sends a rich tab down the folio path (JSON, not a markdown concat)', () => {
    const tab: SaveTab = {
      mode: 'rich',
      body: '',
      frontmatter: {},
      model: folioToModel(richFixture),
      docId: richFixture.docId,
      docMeta: richFixture.docMeta
    };
    const out = buildSavePayload(tab);
    expect(out.trimStart().startsWith('{')).toBe(true);
    expect(JSON.parse(out).schemaVersion).toBe(1);
  });

  it('refuses a rich tab missing its model / docId / docMeta', () => {
    const tab: SaveTab = { mode: 'rich', body: '', frontmatter: {} };
    expect(() => buildSavePayload(tab)).toThrow();
  });
});

describe('buildFolioPayload', () => {
  it('round-trips the folio fixture byte-identically', () => {
    const out = buildFolioPayload({
      model: folioToModel(richFixture),
      docId: richFixture.docId,
      docMeta: richFixture.docMeta
    });
    expect(out).toBe(serializeFolio(richFixture));
  });
});

describe('fileMode', () => {
  it('routes .folio to rich and everything else to markdown', () => {
    expect(fileMode('a/b/test.folio')).toBe('rich');
    expect(fileMode('test.FOLIO')).toBe('rich');
    expect(fileMode('notes/todo.md')).toBe('markdown');
    expect(fileMode('README')).toBe('markdown');
    expect(fileMode('a.folio.md')).toBe('markdown');
  });
});
