// Line-ending policy at the md->model boundary (SKR-160 / F10). The model holds
// LF, always. micromark does not normalize CRLF, and a soft break lives inside a
// `text` node's value, so `alpha\r\nbeta` used to model as the literal text
// `alpha\r beta` — a stray CR carried as CONTENT into `.folio` on paste and on
// import, the latter being a one-way conversion.
//
// Normalizing before the parser reads a byte makes that unrepresentable rather
// than unlikely. `.md` files on disk keep whatever endings they have: that path
// saves text->text and never round-trips through this parser (SKR-196).

import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from '../../../src/lib/blockmodel';
import type { BlockNode } from '../../../src/lib/blockmodel';

function text(block: BlockNode): string {
  if (block.type === 'code_block') return block.text;
  if (block.type !== 'paragraph' && block.type !== 'heading') throw new Error(`no text on ${block.type}`);
  return block.inline.map((n) => (n.kind === 'text' ? n.text : `<${n.kind}>`)).join('');
}

const first = (md: string): BlockNode => {
  const b = parseDocument(md).blocks[0];
  if (!b) throw new Error('no block');
  return b;
};

describe('CRLF never reaches the model', () => {
  it('a CRLF soft break flows to a space, carrying no CR', () => {
    expect(text(first('alpha\r\nbeta\n'))).toBe('alpha beta');
  });

  it('a lone CR is a line ending too, not a character', () => {
    expect(text(first('alpha\rbeta\n'))).toBe('alpha beta');
  });

  it('CRLF inside a code block becomes LF, not literal CR', () => {
    const block = first('```\na\r\nb\n```\n');
    expect(text(block)).toBe('a\nb');
    expect(text(block)).not.toContain('\r');
  });

  it('a CRLF paragraph break still separates paragraphs', () => {
    const blocks = parseDocument('one\r\n\r\ntwo\r\n').blocks;
    expect(blocks).toHaveLength(2);
    expect(text(blocks[0]!)).toBe('one');
    expect(text(blocks[1]!)).toBe('two');
  });

  it('a CRLF hard break is still a hard break', () => {
    const block = first('a  \r\nb\n');
    expect(text(block)).toBe('a<break>b');
  });
});

// mdast offsets index the normalized text and `src` slices index the parser's own
// copy of it. Hand those two different bytes and every slice after the first CRLF
// is off by the carriage returns before it — the whole reason normalization has
// to happen once, above both.
describe('src slices stay aligned under CRLF', () => {
  it('slices the right bytes for each block', () => {
    const blocks = parseDocument('# h\r\n\r\npara\r\n').blocks;
    expect(blocks.map((b) => (b.type === 'frozen_block' ? b.src : b.src))).toEqual(['# h', 'para']);
  });

  it('a CRLF document re-serializes as LF', () => {
    const doc = parseDocument('# h\r\n\r\npara\r\n');
    const md = serializeDocument(doc);
    expect(md).toBe('# h\n\npara\n');
    expect(md).not.toContain('\r');
  });

  it('an untouched CRLF document is idempotent once normalized', () => {
    const md = serializeDocument(parseDocument('one\r\n\r\ntwo\r\n'));
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });
});
