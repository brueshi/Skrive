// The spec §10 "rich (every construct)" fixture, as a FolioDocument. Exercises
// every block type, mark, the hard break, task-list checkboxes, and table
// alignment — the round-trip gate for SKR-195.

import type { FolioDocument } from '../../src/lib/folio';

// Synthetic docIds copied verbatim from docs/folio-schema-v1.md §10. They are
// example ULIDs, not credentials — the `// noscan` keeps the secret-scanner from
// flagging their high entropy.
export const RICH_DOC_ID = '01j9zc4t8b2n5q0w7e3r6y9u1d'; // noscan
export const EMPTY_DOC_ID = '01j9z8n2q4r7v0c3m6k8t1x5ab'; // noscan

export const richFixture: FolioDocument = {
  schemaVersion: 1,
  docId: RICH_DOC_ID,
  docMeta: { title: 'Kitchen sink', createdAt: '2026-07-02T18:05:00.000Z' },
  blocks: [
    {
      id: 'h1a2b3c4d5',
      type: 'heading',
      level: 1,
      inline: [{ kind: 'text', text: 'Title', marks: {} }]
    },
    {
      id: 'p1a2b3c4d5',
      type: 'paragraph',
      inline: [
        { kind: 'text', text: 'A ', marks: {} },
        { kind: 'text', text: 'bold', marks: { strong: true } },
        { kind: 'text', text: ' and ', marks: {} },
        {
          kind: 'text',
          text: 'linked',
          marks: { link: { href: 'https://skrive.md', title: null } }
        },
        { kind: 'text', text: ' line.', marks: {} },
        { kind: 'break', marks: {} },
        { kind: 'text', text: 'Second visual line.', marks: {} }
      ]
    },
    {
      id: 'c1a2b3c4d5',
      type: 'code_block',
      lang: 'ts',
      meta: null,
      text: 'const x = 1\nconst y = 2\n'
    },
    {
      id: 'b1a2b3c4d5',
      type: 'bullet_list',
      spread: false,
      items: [
        {
          spread: false,
          checked: true,
          children: [
            { id: 'p2a2b3c4d5', type: 'paragraph', inline: [{ kind: 'text', text: 'done', marks: {} }] }
          ]
        },
        {
          spread: false,
          checked: false,
          children: [
            { id: 'p3a2b3c4d5', type: 'paragraph', inline: [{ kind: 'text', text: 'todo', marks: {} }] }
          ]
        }
      ]
    },
    {
      id: 't1a2b3c4d5',
      type: 'table',
      align: ['left', 'right'],
      rows: [
        [
          [{ kind: 'text', text: 'A', marks: { strong: true } }],
          [{ kind: 'text', text: 'B', marks: { strong: true } }]
        ],
        [
          [{ kind: 'text', text: '1', marks: {} }],
          [{ kind: 'text', text: '2', marks: {} }]
        ]
      ]
    },
    { id: 'r1a2b3c4d5', type: 'horizontal_rule' },
    {
      id: 'q1a2b3c4d5',
      type: 'blockquote',
      children: [
        { id: 'p4a2b3c4d5', type: 'paragraph', inline: [{ kind: 'text', text: 'quoted', marks: { em: true } }] }
      ]
    }
  ]
};

export const emptyFixture: FolioDocument = {
  schemaVersion: 1,
  docId: EMPTY_DOC_ID,
  docMeta: { title: null, createdAt: '2026-07-02T18:00:00.000Z' },
  blocks: []
};
