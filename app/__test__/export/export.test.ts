// Export pipeline (SKR-199): pure `.folio` -> string serializers, exercised off
// the schema §10 "every construct" fixture. These assert the honest-export
// contract — faithful where the target allows, lossy where it can't — not a
// byte-round-trip.

import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMATS,
  exportFolio,
  exportTargetPath,
  folioToHtml,
  folioToMarkdown,
  folioToPlainText,
  folioToRtf
} from '../../src/lib/export';
import type { FolioDocument } from '../../src/lib/folio';
import { emptyFixture, richFixture } from '../folio/fixture';

describe('folioToMarkdown', () => {
  it('serializes every construct to canonical Markdown', () => {
    const md = folioToMarkdown(richFixture);
    expect(md).toContain('# Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('[linked](https://skrive.md)');
    expect(md).toContain('```ts');
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
    expect(md).toContain('| **A** | **B** |');
    expect(md).toContain('| :--- | ---: |');
    expect(md).toContain('---');
    expect(md).toContain('> *quoted*');
  });

  it('emits no managed-layer anchor comments (folio blocks are never durable)', () => {
    expect(folioToMarkdown(richFixture)).not.toContain('<!-- sk:');
  });

  it('preserves the hard break as a Markdown backslash break', () => {
    // The paragraph has "…line.<break>Second visual line." — the break must
    // survive as a real line break, not collapse to a space.
    expect(folioToMarkdown(richFixture)).toContain('Second visual line.');
    expect(folioToMarkdown(richFixture)).toMatch(/line\.(\\|  )\nSecond visual line\./);
  });

  it('returns empty output for an empty document', () => {
    expect(folioToMarkdown(emptyFixture)).toBe('');
  });

  it('clamps a ragged table to a rectangular GFM table', () => {
    // A table with a header of 2 columns, a 3-cell row, and a 1-cell row must
    // serialize to a uniform 3-column grid — short rows padded, delimiters wide.
    const ragged: FolioDocument = {
      schemaVersion: 1,
      docId: richFixture.docId,
      docMeta: richFixture.docMeta,
      blocks: [
        {
          id: 'rag1',
          type: 'table',
          align: ['left', 'right'],
          rows: [
            [
              [{ kind: 'text', text: 'A', marks: {} }],
              [{ kind: 'text', text: 'B', marks: {} }]
            ],
            [
              [{ kind: 'text', text: '1', marks: {} }],
              [{ kind: 'text', text: '2', marks: {} }],
              [{ kind: 'text', text: '3', marks: {} }]
            ],
            [[{ kind: 'text', text: 'x', marks: {} }]]
          ]
        }
      ]
    };
    const lines = folioToMarkdown(ragged).trim().split('\n');
    // Every row (header, delimiter, body) has the same pipe count = 3 columns.
    const pipeCounts = lines.map((l) => (l.match(/\|/g) ?? []).length);
    expect(new Set(pipeCounts).size).toBe(1);
    expect(pipeCounts[0]).toBe(4); // 3 columns => 4 pipes
    expect(folioToMarkdown(ragged)).toContain('| A | B |  |');
    expect(folioToMarkdown(ragged)).toContain('| x |  |  |');
  });
});

describe('folioToPlainText', () => {
  it('flattens to bare prose with no Markdown syntax', () => {
    const txt = folioToPlainText(richFixture);
    expect(txt).toContain('Title');
    expect(txt).toContain('bold');
    expect(txt).not.toContain('**');
    expect(txt).not.toContain('#');
    expect(txt).not.toContain('```');
    expect(txt).toContain('done');
    expect(txt).toContain('A\tB'); // table as tab-separated rows
  });

  it('returns empty output for an empty document', () => {
    expect(folioToPlainText(emptyFixture)).toBe('');
  });
});

describe('folioToHtml', () => {
  it('wraps rendered HTML in a standalone document', () => {
    const html = folioToHtml(richFixture);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>Kitchen sink</title>');
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://skrive.md"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('uses the supplied title over the document title, escaping it', () => {
    const html = folioToHtml(richFixture, { title: 'My <Notes> & "stuff"' });
    expect(html).toContain('<title>My &lt;Notes&gt; &amp; &quot;stuff&quot;</title>');
  });

  it('falls back to Untitled when there is no title', () => {
    expect(folioToHtml(emptyFixture)).toContain('<title>Untitled</title>');
  });
});

describe('folioToRtf', () => {
  it('produces a well-formed RTF document', () => {
    const rtf = folioToRtf(richFixture);
    expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    expect(rtf).toContain('\\fonttbl');
  });

  it('renders marks, headings, links, and task markers', () => {
    const rtf = folioToRtf(richFixture);
    expect(rtf).toContain('\\b\\fs36 Title\\b0'); // heading is bold at a level-1 size
    expect(rtf).toContain('\\b bold\\b0'); // inline strong
    expect(rtf).toContain('\\i quoted\\i0'); // inline emphasis in the blockquote
    expect(rtf).toContain('HYPERLINK "https://skrive.md"');
    expect(rtf).toContain('\\bullet\\tab [x] done');
    expect(rtf).toContain('\\bullet\\tab [ ] todo');
  });

  it('balances every brace it opens', () => {
    const rtf = folioToRtf(richFixture);
    let depth = 0;
    for (let i = 0; i < rtf.length; i++) {
      const ch = rtf[i];
      const prev = rtf[i - 1];
      if (prev === '\\') continue; // escaped brace, not a group delimiter
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('escapes non-ASCII as unicode escapes and structural chars', () => {
    const doc: FolioDocument = {
      schemaVersion: 1,
      docId: richFixture.docId,
      docMeta: richFixture.docMeta,
      blocks: [
        {
          id: 'p',
          type: 'paragraph',
          inline: [{ kind: 'text', text: 'café {brace} 100% — emoji \u{1f600}', marks: {} }]
        }
      ]
    };
    const rtf = folioToRtf(doc);
    expect(rtf).toContain('caf\\u233?'); // é
    expect(rtf).toContain('\\{brace\\}'); // escaped braces
    expect(rtf).toContain('\\u8212?'); // em dash
    expect(rtf).toContain('\\u55357?\\u56832?'); // grinning face as a surrogate pair
  });

  it('produces a minimal but valid document for an empty folio', () => {
    const rtf = folioToRtf(emptyFixture);
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
  });
});

describe('exportTargetPath', () => {
  const none = () => false;

  it('swaps the source extension for the target extension in the same folder', () => {
    expect(exportTargetPath('notes/journal.folio', 'md', none)).toBe('notes/journal.md');
    expect(exportTargetPath('journal.folio', 'html', none)).toBe('journal.html');
  });

  it('keeps dots earlier in the stem', () => {
    expect(exportTargetPath('a/my.notes.folio', 'txt', none)).toBe('a/my.notes.txt');
  });

  it('never clobbers an existing file — it suffixes an increasing number', () => {
    const taken = new Set(['journal.md', 'journal 1.md']);
    expect(exportTargetPath('journal.folio', 'md', (p) => taken.has(p))).toBe('journal 2.md');
  });

  it('suffixes even the first candidate when it collides', () => {
    const taken = new Set(['doc/report.txt']);
    expect(exportTargetPath('doc/report.folio', 'txt', (p) => taken.has(p))).toBe(
      'doc/report 1.txt'
    );
  });
});

describe('exportFolio registry', () => {
  it('dispatches each format to its serializer', () => {
    expect(exportFolio(richFixture, 'markdown')).toBe(folioToMarkdown(richFixture));
    expect(exportFolio(richFixture, 'txt')).toBe(folioToPlainText(richFixture));
    expect(exportFolio(richFixture, 'rtf')).toBe(folioToRtf(richFixture));
    expect(exportFolio(richFixture, 'html', { title: 'X' })).toBe(
      folioToHtml(richFixture, { title: 'X' })
    );
  });

  it('exposes one registry entry per format id with a unique extension', () => {
    const ids = EXPORT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const exts = EXPORT_FORMATS.map((f) => f.extension);
    expect(new Set(exts).size).toBe(exts.length);
  });
});
