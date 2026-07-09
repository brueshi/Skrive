// @vitest-environment jsdom
//
// SKR-187 / F29 — the render-layer half of the URL guard. Paste sanitizes clipboard
// HTML at ingestion, but a link reaches the model by other roads that never touch
// that pass: a markdown link arriving as `text/plain`, a URL typed into the ⌘K link
// editor, a `.md` file authored elsewhere. render.ts is the last place before the
// URL becomes a navigable DOM attribute, so it checks independently.
//
// These are security fixtures. Each blocked case is a URL a browser would navigate.

import { describe, it, expect } from 'vitest';
import { renderBlock } from '../../src/lib/blocksurface/render';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

const identity = (url: string): string => url;

function block(md: string): BlockNode {
  const b = parseDocument(md).blocks[0];
  if (!b) throw new Error('no block parsed');
  return b;
}

// getAttribute, not the .href property: jsdom resolves the property against the
// document base URL, so an absent attribute reads back as the page URL.
function anchorHref(md: string): string | null {
  const el = renderBlock(block(md), identity);
  return el.querySelector('a')?.getAttribute('href') ?? null;
}

function imageSrc(md: string): string | null {
  const el = renderBlock(block(md), identity);
  return el.querySelector('img')?.getAttribute('src') ?? null;
}

describe('render.ts refuses a dangerous href', () => {
  const blocked = [
    '[click](javascript:alert&#40;1&#41;)',
    '[click](JAVASCRIPT:alert&#40;1&#41;)',
    '[click](vbscript:msgbox&#40;1&#41;)',
    '[click](data:text/html,<script>alert&#40;1&#41;</script>)',
    '[click](file:///etc/passwd)'
  ];
  for (const md of blocked) {
    it(`emits no href for ${JSON.stringify(md)}`, () => {
      expect(anchorHref(`${md}\n`)).toBeNull();
    });
  }

  it('still renders the anchor element, so the inline structure is unchanged', () => {
    const el = renderBlock(block('[click](javascript:alert&#40;1&#41;)\n'), identity);
    const a = el.querySelector('a');
    expect(a, 'the <a> survives; only its href is withheld').not.toBeNull();
    expect(a?.textContent).toBe('click');
  });

  it('keeps the link text addressable, so the caret model is unaffected', () => {
    const el = renderBlock(block('before [click](javascript:alert&#40;1&#41;) after\n'), identity);
    expect(el.textContent).toBe('before click after');
  });
});

describe('render.ts keeps a permitted href', () => {
  const allowed: Array<[string, string]> = [
    ['[x](https://example.com)', 'https://example.com'],
    ['[x](mailto:joe@example.com)', 'mailto:joe@example.com'],
    ['[x](./notes/1.md)', './notes/1.md'],
    ['[x](#section)', '#section']
  ];
  for (const [md, href] of allowed) {
    it(`emits href for ${JSON.stringify(md)}`, () => {
      expect(anchorHref(`${md}\n`)).toBe(href);
    });
  }
});

describe('render.ts refuses a dangerous image src', () => {
  it('drops a data: image src', () => {
    expect(imageSrc('![chart](data:text/html,<script>alert&#40;1&#41;</script>)\n')).toBeNull();
  });

  it('keeps a relative image src, which resolveAsset rewrites downstream', () => {
    expect(imageSrc('![cat](assets/cat.png)\n')).toBe('assets/cat.png');
  });

  it('keeps the alt text on a dropped image', () => {
    const el = renderBlock(block('![chart](javascript:alert&#40;1&#41;)\n'), identity);
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('chart');
  });
});
