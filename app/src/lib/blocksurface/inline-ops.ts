// Inline-model edits over flat offsets (SKR-95, Stage 3a). The keystroke hot path
// mutates the focused block's inline content here, then the block is re-rendered
// from the new model — the model stays authoritative, the DOM is derived.
//
// Offsets match the selection mapping: only text contributes length (a mark
// wrapper is presentation; an atomic inline is passed through without advancing
// the count, matching range.toString()). All ops return a NEW array — blocks are
// immutable, so an edit replaces the one block object.

import type { InlineMarks, InlineNode } from '../blockmodel';

function isText(node: InlineNode): node is Extract<InlineNode, { kind: 'text' }> {
  return node.kind === 'text';
}

/** Insert text at a flat offset, inheriting the marks of the text run the caret
 *  sits in (typing inside a bold word stays bold). Past the end, or into an empty
 *  block, it lands as plain text. */
export function insertTextInInline(nodes: InlineNode[], offset: number, text: string): InlineNode[] {
  if (text.length === 0) return nodes;
  const out: InlineNode[] = [];
  let acc = 0;
  let done = false;
  for (const node of nodes) {
    if (!isText(node)) {
      out.push(node);
      continue;
    }
    const len = node.text.length;
    if (!done && offset <= acc + len) {
      const local = offset - acc;
      out.push({ kind: 'text', text: node.text.slice(0, local) + text + node.text.slice(local), marks: node.marks });
      done = true;
    } else {
      out.push(node);
    }
    acc += len;
  }
  if (!done) {
    let marks: InlineMarks = {};
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (isText(n)) {
        marks = n.marks;
        break;
      }
    }
    out.push({ kind: 'text', text, marks });
  }
  return out;
}

/** Remove the characters in the flat range [start, end). An overlapped text run
 *  keeps its surrounding text (and its marks); a fully-removed run is dropped. */
export function deleteRangeInInline(nodes: InlineNode[], start: number, end: number): InlineNode[] {
  if (start >= end) return nodes;
  const out: InlineNode[] = [];
  let acc = 0;
  for (const node of nodes) {
    if (!isText(node)) {
      out.push(node);
      continue;
    }
    const len = node.text.length;
    const nodeStart = acc;
    const nodeEnd = acc + len;
    if (nodeEnd <= start || nodeStart >= end) {
      out.push(node);
    } else {
      const left = node.text.slice(0, Math.max(0, start - nodeStart));
      const right = node.text.slice(Math.max(0, end - nodeStart));
      const kept = left + right;
      if (kept.length > 0) out.push({ kind: 'text', text: kept, marks: node.marks });
    }
    acc += len;
  }
  return out;
}

function markEl(tag: string, marks: InlineMarks): InlineMarks {
  switch (tag) {
    case 'strong':
    case 'b':
      return { ...marks, strong: true };
    case 'em':
    case 'i':
      return { ...marks, em: true };
    case 'code':
      return { ...marks, code: true };
    default:
      return marks;
  }
}

function walkDom(node: Node, marks: InlineMarks, out: InlineNode[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child as Text).data;
      if (text) out.push({ kind: 'text', text, marks: { ...marks } });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') {
        out.push({ kind: 'break', marks: { ...marks } });
      } else if (tag === 'img') {
        out.push({
          kind: 'image',
          url: el.getAttribute('src') ?? '',
          alt: el.getAttribute('alt') ?? '',
          title: el.getAttribute('title'),
          marks: { ...marks }
        });
      } else if (tag === 'a') {
        walkDom(el, { ...marks, link: { href: el.getAttribute('href') ?? '', title: el.getAttribute('title') } }, out);
      } else {
        walkDom(el, markEl(tag, marks), out);
      }
    }
  }
}

/** Reconstruct a block's inline model from its DOM (the inverse of the inline
 *  render). Used to reconcile after a native edit the hot path didn't model —
 *  IME composition. A block whose only content is the placeholder <br> reads as
 *  empty, not as a hard break. */
export function readInlineFromDOM(blockEl: HTMLElement): InlineNode[] {
  const out: InlineNode[] = [];
  walkDom(blockEl, {}, out);
  if (out.length === 1 && out[0]!.kind === 'break') return [];
  return out;
}
