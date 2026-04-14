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
// Trust model: image URLs come from files the user owns. We do not
// validate or restrict them — if Phase 4 importers start pulling content
// from the network, that caller is responsible for sanitization before
// the content reaches the editor.

import { Decoration, WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { HandlerMap, NodeHandler } from "./shared";

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
    // Images that fail to load would otherwise collapse to a broken-image
    // glyph that drags the line baseline around. Hide failed loads and
    // fall back to showing the alt text so the document still reads.
    img.addEventListener("error", () => {
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
  const src = sliceUrl(ctx.view, container);
  if (!src) return;
  const altRange = findAltRange(container);
  const alt = altRange
    ? ctx.view.state.doc.sliceString(altRange.from, altRange.to)
    : "";

  ctx.decorations.push(
    Decoration.replace({
      widget: new ImageWidget(src, alt),
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
