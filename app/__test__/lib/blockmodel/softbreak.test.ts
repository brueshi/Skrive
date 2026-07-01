// Soft-break flow (SKR-148). A single newline inside a paragraph is CommonMark
// presentation, not content: the model must carry the flowed text (or
// hard-wrapped source paints its wrap points in the editor), while fidelity
// keeps the wrapped bytes for clean and edit-reverted blocks.

import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from '../../../src/lib/blockmodel';
import type { BlockNode, Document } from '../../../src/lib/blockmodel';

const WRAPPED = [
  'The Electron-to-Zig shell port proved the host layer can be native. That raises a',
  'strategic',
  'question the shell port deliberately did not answer: if the long-term direction is',
  ' "more native,"'
].join('\n');

function paragraphText(block: BlockNode): string {
  if (block.type !== 'paragraph') throw new Error(`expected paragraph, got ${block.type}`);
  return block.inline.map((n) => (n.kind === 'text' ? n.text : `<${n.kind}>`)).join('');
}

function dirtyFirst(doc: Document, appendText?: string): Document {
  const blocks = doc.blocks.slice();
  let next = { ...blocks[0]!, dirty: true } as BlockNode;
  if (appendText && next.type === 'paragraph') {
    next = { ...next, inline: [...next.inline, { kind: 'text', text: appendText, marks: {} }] };
  }
  blocks[0] = next;
  return { ...doc, blocks };
}

describe('soft breaks flow as spaces in the model', () => {
  it('a hard-wrapped paragraph parses to one flowing text run', () => {
    const doc = parseDocument(WRAPPED);
    expect(doc.blocks).toHaveLength(1);
    expect(paragraphText(doc.blocks[0]!)).toBe(
      'The Electron-to-Zig shell port proved the host layer can be native. That raises a strategic question the shell port deliberately did not answer: if the long-term direction is "more native,"'
    );
  });

  it('whitespace around the wrap point collapses into the single space', () => {
    const doc = parseDocument('ends with a space \n  starts indented');
    expect(paragraphText(doc.blocks[0]!)).toBe('ends with a space starts indented');
  });

  it('hard breaks (trailing double-space and backslash) stay real breaks', () => {
    for (const md of ['line one  \nline two', 'line one\\\nline two']) {
      const doc = parseDocument(md);
      const para = doc.blocks[0]!;
      if (para.type !== 'paragraph') throw new Error('expected paragraph');
      expect(para.inline.map((n) => n.kind)).toEqual(['text', 'break', 'text']);
    }
  });

  it('soft breaks inside marks flow too', () => {
    const doc = parseDocument('some *emphasis that\nwraps* mid-span');
    expect(paragraphText(doc.blocks[0]!)).toBe('some emphasis that wraps mid-span');
  });
});

describe('fidelity of hard-wrapped sources', () => {
  it('zero-edit round-trip keeps the wrapped bytes', () => {
    expect(serializeDocument(parseDocument(WRAPPED))).toBe(WRAPPED);
  });

  it('edit-then-revert restores the wrapped bytes via the idempotence guard', () => {
    expect(serializeDocument(dirtyFirst(parseDocument(WRAPPED)))).toBe(WRAPPED);
  });

  it('a real edit re-serializes the paragraph flowed', () => {
    const out = serializeDocument(dirtyFirst(parseDocument(WRAPPED), ' EDITED'));
    expect(out).toContain('is "more native," EDITED');
    expect(out).not.toContain('\nstrategic\n');
  });
});
