// The model <-> folio seam (SKR-195, spec §2). The wave gate: a rich document
// round-trips model -> file -> model with no loss of content.

import { describe, expect, it } from 'vitest';
import {
  folioToModel,
  modelToFolio,
  parseFolio,
  serializeFolio,
  type FolioMeta
} from '../../src/lib/folio';
import type { BlockNode, Document } from '../../src/lib/blockmodel';
import { richFixture } from './fixture';

const identity: { docId: string; docMeta: FolioMeta } = {
  docId: richFixture.docId,
  docMeta: richFixture.docMeta
};

describe('model <-> folio round-trip (wave gate)', () => {
  it('folio -> model -> folio preserves all content', () => {
    const model = folioToModel(richFixture);
    expect(modelToFolio(model, identity)).toEqual(richFixture);
  });

  it('model -> file -> model round-trips byte-identically through the model', () => {
    const model = folioToModel(richFixture);
    const text = serializeFolio(modelToFolio(model, identity));
    const reloaded = folioToModel(parseFolio(text));
    expect(serializeFolio(modelToFolio(reloaded, identity))).toBe(serializeFolio(richFixture));
  });

  it('carries per-column table widths across the model <-> folio seam', () => {
    const model: BlockNode[] = [
      {
        id: 't3a2b3c4d5',
        type: 'table',
        durable: false,
        src: null,
        gapBefore: null,
        dirty: false,
        align: [null, null],
        widths: [4, 1],
        rows: [
          [[{ kind: 'text', text: 'A', marks: {} }], [{ kind: 'text', text: 'B', marks: {} }]],
          [[{ kind: 'text', text: '1', marks: {} }], [{ kind: 'text', text: '2', marks: {} }]]
        ]
      }
    ];
    const doc: Document = { blocks: model, trailingGap: '' };
    const folio = modelToFolio(doc, identity);
    expect(folio.blocks[0]).toMatchObject({ type: 'table', widths: [4, 1] });
    // Back to the model, the widths survive unchanged.
    const back = folioToModel(folio).blocks[0];
    expect(back?.type).toBe('table');
    if (back?.type === 'table') expect(back.widths).toEqual([4, 1]);
  });

  it('leaves a width-free table without a widths field on either side', () => {
    const model: BlockNode[] = [
      {
        id: 't4a2b3c4d5',
        type: 'table',
        durable: false,
        src: null,
        gapBefore: null,
        dirty: false,
        align: [null],
        rows: [[[{ kind: 'text', text: 'A', marks: {} }]]]
      }
    ];
    const folio = modelToFolio({ blocks: model, trailingGap: '' }, identity);
    expect('widths' in folio.blocks[0]!).toBe(false);
    const back = folioToModel(folio).blocks[0];
    expect(back?.type).toBe('table');
    if (back?.type === 'table') expect('widths' in back).toBe(false);
  });

  it('persists every block id (not just durable ones)', () => {
    const model = folioToModel(richFixture);
    const folio = modelToFolio(model, identity);
    expect(folio.blocks.map((b) => b.id)).toEqual([
      'h1a2b3c4d5',
      'p1a2b3c4d5',
      'c1a2b3c4d5',
      'b1a2b3c4d5',
      't1a2b3c4d5',
      'r1a2b3c4d5',
      'q1a2b3c4d5'
    ]);
  });
});

describe('modelToFolio drops Markdown-fidelity fields (spec §2)', () => {
  it('omits src / gapBefore / dirty / durable / fence / marker / delimiter', () => {
    const doc: Document = {
      trailingGap: '\n',
      blocks: [
        {
          id: 'a',
          type: 'code_block',
          durable: true,
          src: '```js\nx\n```',
          gapBefore: '\n\n',
          dirty: true,
          lang: 'js',
          meta: 'extra',
          fence: '~~~~',
          text: 'x\n'
        },
        {
          id: 'b',
          type: 'ordered_list',
          durable: false,
          src: null,
          gapBefore: null,
          dirty: false,
          start: 3,
          delimiter: ')',
          spread: true,
          items: [
            {
              spread: false,
              children: [
                {
                  id: 'c',
                  type: 'paragraph',
                  durable: false,
                  src: null,
                  gapBefore: null,
                  dirty: false,
                  inline: [{ kind: 'text', text: 'item', marks: {} }]
                }
              ]
            }
          ]
        }
      ]
    };
    const folio = modelToFolio(doc, identity);
    const json = JSON.stringify(folio);
    for (const dropped of ['src', 'gapBefore', 'dirty', 'durable', 'fence', 'marker', 'delimiter']) {
      expect(json).not.toContain(`"${dropped}"`);
    }
    // Content that survives: lang, meta, text, start, spread.
    const code = folio.blocks[0];
    expect(code).toMatchObject({ type: 'code_block', lang: 'js', meta: 'extra', text: 'x\n' });
    const list = folio.blocks[1];
    expect(list).toMatchObject({ type: 'ordered_list', start: 3, spread: true });
  });
});

describe('modelToFolio resolves a frozen block to a paragraph (spec §2)', () => {
  it('carries the raw source as literal text', () => {
    const doc: Document = {
      trailingGap: '',
      blocks: [
        { id: 'f1', type: 'frozen_block', durable: false, src: '<div>raw</div>', gapBefore: null }
      ] as BlockNode[]
    };
    const folio = modelToFolio(doc, identity);
    expect(folio.blocks[0]).toEqual({
      id: 'f1',
      type: 'paragraph',
      inline: [{ kind: 'text', text: '<div>raw</div>', marks: {} }]
    });
  });
});

describe('folioToModel fills folio-neutral fidelity defaults', () => {
  it('sets src/gapBefore null, dirty/durable false, no captured fence/marker style', () => {
    const model = folioToModel(richFixture);
    const first = model.blocks[0]!;
    expect(first).toMatchObject({ durable: false, src: null, gapBefore: null, dirty: false });
    expect(model.trailingGap).toBe('');
  });
});
