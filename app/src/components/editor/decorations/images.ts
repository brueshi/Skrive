// Inline image widget. On non-cursor lines, the entire `![alt](src)` range
// is replaced with an `<img>` element rendered from the URL the grammar
// extracted. The user sees the image where the markup used to be; moving
// the cursor to the image's line reveals the raw syntax.
//
// Path resolution: Markdown image URLs are relative to the source file,
// not the project root. In Phase 6 the resolver gets wired through to a
// project-aware function that prefixes the project root and converts to
// a webview-loadable URL via Electron's custom protocol. For Phase 2 the
// default resolver is identity — the raw URL is rendered as-is, which
// works for absolute http(s) URLs and breaks for project-relative paths.
// That's acceptable for the migration's intermediate state.

import { Decoration, WidgetType } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import type { HandlerMap, NodeHandler } from './shared';

export type ImageContext = {
  projectRoot: string;
  filePath: string | null;
};

/**
 * Identity resolver — returns the raw URL unchanged. Phase 6 swaps this
 * for a project-aware resolver via `setImageResolver`.
 */
export type ImageResolver = (rawUrl: string, ctx: ImageContext) => string;

const identityResolver: ImageResolver = (rawUrl) => rawUrl;

export const setImageContext = StateEffect.define<ImageContext>();
export const setImageResolver = StateEffect.define<ImageResolver>();

export const imageContextField = StateField.define<ImageContext>({
  create: () => ({ projectRoot: '', filePath: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setImageContext)) return e.value;
    }
    return value;
  }
});

export const imageResolverField = StateField.define<ImageResolver>({
  create: () => identityResolver,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setImageResolver)) return e.value;
    }
    return value;
  }
});

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  override toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'cm-md-image';
    img.addEventListener('error', () => {
      console.warn('[skrive] image failed to load:', img.src);
      img.style.display = 'none';
    });
    return img;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function findAltRange(
  container: import('@lezer/common').SyntaxNode
): { from: number; to: number } | null {
  const first = container.firstChild;
  if (!first || first.name !== 'LinkMark') return null;
  let closeStart: number | null = null;
  let child = first.nextSibling;
  while (child) {
    if (child.name === 'LinkMark') {
      closeStart = child.from;
      break;
    }
    child = child.nextSibling;
  }
  if (closeStart === null) return null;
  return { from: first.to, to: closeStart };
}

function sliceUrl(
  view: EditorView,
  container: import('@lezer/common').SyntaxNode
): string | null {
  const url = container.getChild('URL');
  if (!url) return null;
  return view.state.doc.sliceString(url.from, url.to);
}

const imageHandler: NodeHandler = (node, ctx) => {
  if (ctx.isOnCursorLine(node.from, node.to)) return;

  const container = node.node;
  const rawUrl = sliceUrl(ctx.view, container);
  if (!rawUrl) return;
  const altRange = findAltRange(container);
  const alt = altRange
    ? ctx.view.state.doc.sliceString(altRange.from, altRange.to)
    : '';

  const imageCtx = ctx.view.state.field(imageContextField, false) ?? {
    projectRoot: '',
    filePath: null
  };
  const resolver =
    ctx.view.state.field(imageResolverField, false) ?? identityResolver;
  const resolvedSrc = resolver(rawUrl, imageCtx);

  ctx.decorations.push(
    Decoration.replace({
      widget: new ImageWidget(resolvedSrc, alt)
    }).range(container.from, container.to)
  );

  return false;
};

export const imageHandlers: HandlerMap = {
  Image: imageHandler
};
