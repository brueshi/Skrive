// @vitest-environment jsdom
//
// Asset-URL resolver seam (SKR-223). SKR-175's paste/drop writes an image to a
// sibling `assets/` folder and splices `![](assets/…)` into the model; render.ts
// builds a real <img>. But in the real Zig/WKWebView shell that raw relative src
// never resolves — project binaries are served over a SEPARATE asset origin
// (`skrive-asset://…`, AssetSchemeHandler.swift), not the app's document origin —
// so the image is invisible. Chromium/jsdom are structurally blind to it: a
// relative src "works" against a normal http(s) base.
//
// The fix is a view-only resolver threaded through render.ts and held by the
// surface: it maps a model image URL to a loadable one at render time while the
// model keeps the raw relative path (serialization untouched — see the parity
// gate). These tests pin the three seam contracts: the render layer applies
// whatever resolver it's given; no resolver -> today's literal path; and the real
// resolver BlockEditor builds (skriveAssetResolver bound to the doc path) maps
// relative paths onto the asset origin while passing absolute URLs through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockSurface } from '../../src/lib/blocksurface';
import { renderBlock, renderDocument, BlockViewRegistry } from '../../src/lib/blocksurface/render';
import { skriveAssetResolver } from '../../src/lib/preview/imageResolver';
import { parseDocument, type BlockNode } from '../../src/lib/blockmodel';

// getAttribute, not the .src property: jsdom resolves the property against the
// document base URL, but the model/DOM contract is the literal attribute string.
function imgSrc(root: ParentNode): string | null {
  return root.querySelector('img')?.getAttribute('src') ?? null;
}

function imageBlock(url = 'assets/cat.png', alt = 'cat'): BlockNode {
  const block = parseDocument(`![${alt}](${url})\n`).blocks[0];
  if (!block) throw new Error('no block parsed');
  return block;
}

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
});

describe('render seam — the resolver is applied to <img> src', () => {
  it('renderBlock maps the model url through the supplied resolver', () => {
    const el = renderBlock(imageBlock('assets/cat.png'), (url) => `resolved:${url}`);
    expect(imgSrc(el)).toBe('resolved:assets/cat.png');
  });

  it('renderDocument maps image srcs through the resolver too (nested consumers stay covered)', () => {
    const registry = new BlockViewRegistry();
    renderDocument(container, parseDocument('![cat](assets/cat.png)\n').blocks, registry, (url) => `resolved:${url}`);
    expect(imgSrc(container)).toBe('resolved:assets/cat.png');
  });

  it('with no resolver, renderBlock keeps the raw relative path (default identity — today\'s behavior)', () => {
    const el = renderBlock(imageBlock('assets/cat.png'));
    expect(imgSrc(el)).toBe('assets/cat.png');
  });
});

describe('surface seam — the resolver reaches the initial paint and re-renders', () => {
  it('resolves images already in the doc on the first paint (file-open lifecycle)', () => {
    // The resolver is passed at construction, so renderDocument in the constructor
    // already resolves — an opened doc with images shows them, not just pastes.
    new BlockSurface({
      container,
      doc: parseDocument('![cat](assets/cat.png)\n'),
      resolveAsset: (url) => `x://${url}`
    });
    expect(imgSrc(container)).toBe('x://assets/cat.png');
  });

  it('with no resolver registered, the surface renders the raw path (identity fallback)', () => {
    new BlockSurface({ container, doc: parseDocument('![cat](assets/cat.png)\n') });
    expect(imgSrc(container)).toBe('assets/cat.png');
  });
});

describe('production resolver — skriveAssetResolver bound to the document path', () => {
  const resolve = (url: string) =>
    skriveAssetResolver(url, { projectRoot: '', filePath: 'notes/journal.folio' });

  it('rewrites a document-relative path onto the asset origin', () => {
    expect(resolve('assets/cat.png')).toBe('skrive-asset://asset/notes/assets/cat.png');
  });

  it('passes an absolute http(s) URL through untouched', () => {
    expect(resolve('https://example.com/x.png')).toBe('https://example.com/x.png');
  });

  it('leaves an empty src alone', () => {
    expect(resolve('')).toBe('');
  });
});
