// Trailing hard break on the Markdown floor (SKR-176 / F15). A hard break at the
// very end of a block has no rendered effect in Markdown and used to serialize to
// a bare, dangling `\` (invalid CommonMark). The block model and the native
// `.folio` encoding keep trailing breaks faithfully; the lossy Markdown export /
// copy-out path drops them, matching what Docs/Notion emit.

import { describe, it, expect } from 'vitest';
import { serializeDocument, parseDocument } from '../../../src/lib/blockmodel';
import type { Document, InlineNode } from '../../../src/lib/blockmodel';

const text = (s: string): InlineNode => ({ kind: 'text', text: s, marks: {} });
const brk = (): InlineNode => ({ kind: 'break', marks: {} });

function paraDoc(inline: InlineNode[]): Document {
  return { blocks: [{ id: 'b1', type: 'paragraph', inline, dirty: true }], trailingGap: '' } as Document;
}

describe('trailing hard break serialization (F15)', () => {
  it('drops a single trailing break instead of emitting a dangling backslash', () => {
    const out = serializeDocument(paraDoc([text('abc'), brk()]));
    expect(out).toBe('abc');
    expect(out).not.toContain('\\');
  });

  it('drops multiple trailing breaks', () => {
    const out = serializeDocument(paraDoc([text('abc'), brk(), brk()]));
    expect(out).toBe('abc');
  });

  it('a block whose only content is a break serializes empty', () => {
    expect(serializeDocument(paraDoc([brk()]))).toBe('');
  });

  it('keeps a mid-content break (it has following content to break to)', () => {
    const out = serializeDocument(paraDoc([text('abc'), brk(), text('def')]));
    // A real hard break: backslash + newline, then the following text.
    expect(out).toBe('abc\\\ndef');
    // And it re-parses back to a break rather than drifting.
    expect(parseDocument(out).blocks[0]).toMatchObject({
      inline: [{ kind: 'text' }, { kind: 'break' }, { kind: 'text' }]
    });
  });
});
