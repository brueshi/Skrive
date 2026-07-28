// The text the spelling oracle is shown. Two properties matter and are pinned
// here: the string is exactly as wide as the block's flat offset space (so a
// range that comes back can be painted without translation), and nothing that
// isn't prose is offered for judgement.

import { describe, it, expect } from 'vitest';
import {
  MASK_CHAR,
  isCheckable,
  maskedInlineText,
  proseLeaves
} from '../../src/lib/spellcheck/block-text';
import { parseDocument, type InlineNode } from '../../src/lib/blockmodel';
import { inlineLength } from '../../src/lib/blocksurface/inline-ops';

/** The inline run of the first paragraph/heading of a parsed document. */
function inlineOf(markdown: string): InlineNode[] {
  const block = parseDocument(markdown).blocks[0];
  if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) {
    throw new Error(`expected an inline-text leaf, got ${block?.type ?? 'nothing'}`);
  }
  return block.inline;
}

describe('maskedInlineText', () => {
  it('is exactly as wide as the flat offset space', () => {
    // The whole reason the masking exists: a returned range is painted directly
    // into offset space, so any width mismatch paints the squiggle in the wrong
    // place. Atoms are one cell; a tag is `#` plus its name.
    for (const source of [
      'plain prose here\n',
      'text with `inline code` inside\n',
      'a #tag and more\n',
      'an ![alt](img.png) image\n',
      'strong **and** _emphasis_\n',
      'a [link](https://example.com) inline\n',
      'nested #parent/child tag\n'
    ]) {
      const inline = inlineOf(source);
      expect(maskedInlineText(inline)).toHaveLength(inlineLength(inline));
    }
  });

  it('leaves prose alone, including marked prose', () => {
    // Marks are presentation; the words underneath are still words.
    expect(maskedInlineText(inlineOf('strong **and** _emphasis_\n'))).toBe('strong and emphasis');
    expect(maskedInlineText(inlineOf('a [link](https://example.com) inline\n'))).toBe('a link inline');
  });

  it('masks inline code — code is not prose', () => {
    const masked = maskedInlineText(inlineOf('run `npm instal` now\n'));
    expect(masked).toBe(`run ${MASK_CHAR.repeat('npm instal'.length)} now`);
    expect(masked).not.toContain('instal');
  });

  it('masks a tag, so an identifier is never corrected', () => {
    const masked = maskedInlineText(inlineOf('filed under #draftt today\n'));
    expect(masked).toBe(`filed under ${MASK_CHAR.repeat('#draftt'.length)} today`);
  });

  it('masks an image atom to one cell', () => {
    expect(maskedInlineText(inlineOf('see ![alt](img.png) here\n'))).toBe(`see ${MASK_CHAR} here`);
  });
});

describe('isCheckable', () => {
  it('rejects text that is only mask and whitespace', () => {
    expect(isCheckable('')).toBe(false);
    expect(isCheckable('   ')).toBe(false);
    expect(isCheckable(`${MASK_CHAR} ${MASK_CHAR}`)).toBe(false);
  });

  it('accepts text with any prose at all', () => {
    expect(isCheckable(`${MASK_CHAR} a`)).toBe(true);
  });
});

describe('proseLeaves', () => {
  it('descends into lists, quotes and footnote definitions', () => {
    const doc = parseDocument(
      ['# Heading', '', 'A paragraph.', '', '- item one', '- item two', '', '> quoted line', ''].join('\n')
    );
    expect(proseLeaves(doc.blocks).map((l) => l.text)).toEqual([
      'Heading',
      'A paragraph.',
      'item one',
      'item two',
      'quoted line'
    ]);
  });

  it('skips code blocks and tables — neither can carry a block-keyed decoration', () => {
    const doc = parseDocument(
      ['```js', 'const teh = 1;', '```', '', '| a | b |', '| - | - |', '| c | d |', ''].join('\n')
    );
    expect(proseLeaves(doc.blocks)).toEqual([]);
  });
});
