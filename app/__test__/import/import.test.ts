// Import pipeline (SKR-200): open-format source -> block model, the inbound half
// of the portability promise and the raw material for the `.md` -> `.folio`
// upgrade. Round-tripped against the export serializers where it's cheap to.

import { describe, expect, it } from 'vitest';
import { importKind, sourceToModel } from '../../src/lib/import';
import { modelToFolio } from '../../src/lib/folio';
import { folioToMarkdown } from '../../src/lib/export';

describe('importKind', () => {
  it('maps known text extensions to a kind, case-insensitively', () => {
    expect(importKind('notes/journal.md')).toBe('markdown');
    expect(importKind('README.MARKDOWN')).toBe('markdown');
    expect(importKind('page.html')).toBe('html');
    expect(importKind('page.htm')).toBe('html');
    expect(importKind('log.txt')).toBe('text');
  });

  it('returns null for the native format, binaries, and extensionless files', () => {
    expect(importKind('doc.folio')).toBeNull(); // already native
    expect(importKind('image.png')).toBeNull();
    expect(importKind('archive.rtf')).toBeNull(); // RTF import deferred
    expect(importKind('LICENSE')).toBeNull();
    expect(importKind('.gitignore')).toBeNull(); // dotfile, no stem
  });
});

describe('sourceToModel — markdown', () => {
  it('parses the body and lifts a frontmatter title', () => {
    const raw = ['---', 'title: My Notes', 'tags: [a, b]', '---', '', '# Heading', '', 'Body **text**.'].join(
      '\n'
    );
    const { model, title } = sourceToModel(raw, 'markdown');
    expect(title).toBe('My Notes');
    expect(model.blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    // Frontmatter is stripped from the model (it isn't a block); the heading is
    // the first block, not a stray thematic break.
    expect(model.blocks.some((b) => b.type === 'horizontal_rule')).toBe(false);
  });

  it('has a null title when frontmatter carries none', () => {
    expect(sourceToModel('# Just a heading\n', 'markdown').title).toBeNull();
    expect(sourceToModel('---\ntags: [x]\n---\nbody\n', 'markdown').title).toBeNull();
  });

  it('round-trips markdown -> model -> folio -> markdown for prose', () => {
    const md = '# Title\n\nA paragraph with **bold** and *em*.\n';
    const { model } = sourceToModel(md, 'markdown');
    const folio = modelToFolio(model, {
      docId: '01j9zc4t8b2n5q0w7e3r6y9u1d', // noscan
      docMeta: { title: null, createdAt: '2026-07-03T00:00:00.000Z' }
    });
    // Content-level round-trip: folio normalizes away the trailing gap (it has
    // no such concept), so compare modulo a trailing newline.
    expect(folioToMarkdown(folio).trimEnd()).toBe(md.trimEnd());
  });
});

describe('sourceToModel — html', () => {
  it('converts HTML to the model via the rehype pipeline', () => {
    const { model, title } = sourceToModel(
      '<h1>Hi</h1><p>A <strong>bold</strong> word and a <a href="https://skrive.md">link</a>.</p>',
      'html'
    );
    expect(title).toBeNull();
    expect(model.blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    const para = model.blocks[1];
    expect(para.type).toBe('paragraph');
    if (para.type === 'paragraph') {
      const strong = para.inline.find((n) => n.kind === 'text' && n.marks.strong);
      expect(strong).toBeDefined();
      const link = para.inline.find((n) => n.kind === 'text' && n.marks.link);
      expect(link && link.kind === 'text' && link.marks.link?.href).toBe('https://skrive.md');
    }
  });
});

describe('sourceToModel — text', () => {
  it('parses plain prose into paragraphs', () => {
    const { model, title } = sourceToModel('First para.\n\nSecond para.\n', 'text');
    expect(title).toBeNull();
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks.every((b) => b.type === 'paragraph')).toBe(true);
  });
});
