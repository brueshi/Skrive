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

/** Total flat length of an inline run (text only; matches the offset model). */
export function inlineLength(nodes: InlineNode[]): number {
  let n = 0;
  for (const node of nodes) if (isText(node)) n += node.text.length;
  return n;
}

/** Split inline content at a flat offset into [left, right], each preserving its
 *  runs' marks. Built from the delete primitive so the split obeys the same
 *  offset/mark rules as every other edit. */
export function splitInline(nodes: InlineNode[], offset: number): [InlineNode[], InlineNode[]] {
  const len = inlineLength(nodes);
  const left = deleteRangeInInline(nodes, offset, len);
  const right = deleteRangeInInline(nodes, 0, offset);
  return [left, right];
}

/** The toggleable boolean marks (link is set/cleared with a value, separately). */
export type BooleanMark = 'strong' | 'em' | 'code';

// Apply a mark transform to the text within the flat range [start, end), splitting
// runs at the range boundaries so only the covered characters change.
function mapRange(
  nodes: InlineNode[],
  start: number,
  end: number,
  fn: (marks: InlineMarks) => InlineMarks
): InlineNode[] {
  const out: InlineNode[] = [];
  let acc = 0;
  for (const node of nodes) {
    if (!isText(node)) {
      out.push(node);
      continue;
    }
    const s = acc;
    const e = acc + node.text.length;
    acc = e;
    if (e <= start || s >= end) {
      out.push(node);
      continue;
    }
    const a = Math.max(start, s);
    const b = Math.min(end, e);
    const before = node.text.slice(0, a - s);
    const mid = node.text.slice(a - s, b - s);
    const after = node.text.slice(b - s);
    if (before) out.push({ kind: 'text', text: before, marks: node.marks });
    if (mid) out.push({ kind: 'text', text: mid, marks: fn(node.marks) });
    if (after) out.push({ kind: 'text', text: after, marks: node.marks });
  }
  return out;
}

/** True when every text character in the range carries the boolean mark (and the
 *  range contains at least one character). Drives toggle direction and the
 *  bubble's active state. */
export function rangeHasMark(nodes: InlineNode[], start: number, end: number, mark: BooleanMark): boolean {
  let acc = 0;
  let any = false;
  for (const node of nodes) {
    if (!isText(node)) continue;
    const s = acc;
    const e = acc + node.text.length;
    acc = e;
    if (e <= start || s >= end) continue;
    any = true;
    if (node.marks[mark] !== true) return false;
  }
  return any;
}

/** True when every text character in the range is part of the same link. */
export function rangeHasLink(nodes: InlineNode[], start: number, end: number): boolean {
  let acc = 0;
  let any = false;
  for (const node of nodes) {
    if (!isText(node)) continue;
    const s = acc;
    const e = acc + node.text.length;
    acc = e;
    if (e <= start || s >= end) continue;
    any = true;
    if (!node.marks.link) return false;
  }
  return any;
}

/** Toggle a boolean mark over a range: remove it if the whole range already has
 *  it, otherwise add it (standard editor semantics). */
export function toggleMarkInInline(
  nodes: InlineNode[],
  start: number,
  end: number,
  mark: BooleanMark
): InlineNode[] {
  if (start >= end) return nodes;
  const has = rangeHasMark(nodes, start, end, mark);
  return mapRange(nodes, start, end, (m) => {
    const next = { ...m };
    if (has) delete next[mark];
    else next[mark] = true;
    return next;
  });
}

/** Set or clear the link mark over a range. */
export function setLinkInInline(
  nodes: InlineNode[],
  start: number,
  end: number,
  link: { href: string; title: string | null } | null
): InlineNode[] {
  if (start >= end) return nodes;
  return mapRange(nodes, start, end, (m) => {
    const next = { ...m };
    if (link) next.link = link;
    else delete next.link;
    return next;
  });
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
