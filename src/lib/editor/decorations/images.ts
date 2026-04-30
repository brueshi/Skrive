// Inline image widget. On non-cursor lines, the entire `![alt](src)` range
// is replaced with an `<img>` element rendered from the URL the grammar
// extracted. The user sees the image where the markup used to be; moving
// the cursor to the image's line reveals the raw syntax so it can be
// edited.
//
// The Image node in @lezer/markdown mirrors the Link node but starts with
// `![` instead of `[`:
//
//   LinkMark `![`        (2 chars)
//   ... label content (used as alt text)
//   LinkMark `]`
//   LinkMark `(`
//   URL
//   LinkMark `)`
//
// We read the URL child directly and pull alt text from the range between
// the first `LinkMark` and the closing `]`. When the tree is mid-edit and
// the shape isn't yet what we expect (e.g. the user has typed `![alt`
// with no closing bracket), we bail out and let the raw characters show.
//
// Path resolution: Markdown image URLs are relative to the source file,
// not the project root. We resolve `dirname(currentFile)` + url, fold
// `.`/`..`, prefix the project root, then run the absolute path through
// `convertFileSrc` so the asset protocol can serve it. Without that
// pipeline the webview can't load arbitrary disk paths — the spec works
// in any markdown reader, but only after the runtime has translated the
// path into something the webview is allowed to fetch.
//
// Trust model: image URLs come from files the user owns. We do not
// validate or restrict them — if Phase 4 importers start pulling content
// from the network, that caller is responsible for sanitization before
// the content reaches the editor.

import { Decoration, WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { resolveImageSrc, type ImageContext } from "$lib/imageSrc";
import type { HandlerMap, NodeHandler } from "./shared";

export type { ImageContext };

export const setImageContext = StateEffect.define<ImageContext>();

export const imageContextField = StateField.define<ImageContext>({
  create: () => ({ projectRoot: "", filePath: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setImageContext)) return e.value;
    }
    return value;
  },
});

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.className = "cm-md-image";
    // Hide failed loads (avoids the broken-image glyph dragging the
    // line baseline) and log the URL so anything that doesn't render
    // points the developer at the exact path that 404'd.
    img.addEventListener("error", () => {
      console.warn("[skrive] image failed to load:", img.src);
      img.style.display = "none";
    });
    return img;
  }

  // Let clicks through to CodeMirror so the user can position the cursor
  // by clicking on or near the widget.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Find the range of alt text inside an Image node — the text between
 * the opening `![` and the closing `]`. Returns `null` if the tree
 * isn't shaped the way we expect (in-flight edit).
 */
function findAltRange(
  container: import("@lezer/common").SyntaxNode,
): { from: number; to: number } | null {
  const first = container.firstChild;
  if (!first || first.name !== "LinkMark") return null;
  let closeStart: number | null = null;
  let child = first.nextSibling;
  while (child) {
    if (child.name === "LinkMark") {
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
  container: import("@lezer/common").SyntaxNode,
): string | null {
  const url = container.getChild("URL");
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
    : "";

  const imageCtx = ctx.view.state.field(imageContextField, false) ?? {
    projectRoot: "",
    filePath: null,
  };
  const resolvedSrc = resolveImageSrc(rawUrl, imageCtx);

  ctx.decorations.push(
    Decoration.replace({
      widget: new ImageWidget(resolvedSrc, alt),
    }).range(container.from, container.to),
  );

  // Skip descent — children of this node are already covered by the
  // widget replacement and don't need per-feature decorations layered on
  // top (e.g. emphasis inside alt text would just hide itself behind the
  // image anyway).
  return false;
};

export const imageHandlers: HandlerMap = {
  Image: imageHandler,
};
