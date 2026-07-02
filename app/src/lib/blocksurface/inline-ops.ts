// Inline-model edits over flat offsets (SKR-95, Stage 3a). The keystroke hot path
// mutates the focused block's inline content here, then the block is re-rendered
// from the new model — the model stays authoritative, the DOM is derived.
//
// Offset space (SKR-155): a mark wrapper is presentation and contributes nothing,
// but every leaf occupies width — a text run its character count, and an ATOM
// (inline image / hard break) exactly ONE unit (the PM/Notion convention). Atoms
// used to be zero-width and passed through untouched, which duplicated them on a
// split, resurrected them on a cross-block delete, and made them undeletable;
// giving them a cell in the offset space lets delete/split/insert address them.
// The DOM<->offset mapping in selection.ts counts atoms the same way, so a
// DOM-derived offset and a model offset stay identical. All ops return a NEW
// array — blocks are immutable, so an edit replaces the one block object.

import type { InlineMarks, InlineNode } from '../blockmodel';

function isText(node: InlineNode): node is Extract<InlineNode, { kind: 'text' }> {
  return node.kind === 'text';
}

/** Width of a leaf in the flat offset space: a text run's length, or one unit for
 *  an atom (image / hard break). */
function nodeWidth(node: InlineNode): number {
  return isText(node) ? node.text.length : 1;
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
    if (isText(node)) {
      const len = node.text.length;
      if (!done && offset <= acc + len) {
        const local = offset - acc;
        out.push({ kind: 'text', text: node.text.slice(0, local) + text + node.text.slice(local), marks: node.marks });
        done = true;
      } else {
        out.push(node);
      }
      acc += len;
    } else {
      // Atom (width 1). A caret resting at or before its cell inserts a fresh text
      // run in front of it, inheriting the atom's marks. An offset landing on the
      // text|atom seam is consumed by the preceding text run first (offset <= acc +
      // len above), so this only fires when nothing text precedes the point.
      if (!done && offset <= acc) {
        out.push({ kind: 'text', text, marks: node.marks });
        done = true;
      }
      out.push(node);
      acc += 1;
    }
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
    const nodeStart = acc;
    const nodeEnd = acc + nodeWidth(node);
    acc = nodeEnd;
    // A leaf entirely outside [start, end) survives untouched. This is the whole
    // fix for an atom: its one-unit cell is dropped exactly when the range covers
    // it, and kept otherwise — no more unconditional pass-through.
    if (nodeEnd <= start || nodeStart >= end) {
      out.push(node);
      continue;
    }
    if (!isText(node)) continue; // an overlapped atom is removed
    const left = node.text.slice(0, Math.max(0, start - nodeStart));
    const right = node.text.slice(Math.max(0, end - nodeStart));
    const kept = left + right;
    if (kept.length > 0) out.push({ kind: 'text', text: kept, marks: node.marks });
  }
  return out;
}

/** Total flat length of an inline run: text characters plus one per atom. */
export function inlineLength(nodes: InlineNode[]): number {
  let n = 0;
  for (const node of nodes) n += nodeWidth(node);
  return n;
}

/** Flat plain text of an inline run (no marks). Used to read the `/query` of the
 *  slash menu out of the focused block. */
export function inlinePlainText(nodes: InlineNode[]): string {
  let s = '';
  for (const node of nodes) if (isText(node)) s += node.text;
  return s;
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
      // Atoms carry no toggleable marks, but they hold a cell in the offset space,
      // so advance past it or every offset after an atom would be misaligned.
      out.push(node);
      acc += 1;
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
    if (!isText(node)) {
      acc += 1; // atom holds a cell in the offset space; keep later offsets aligned
      continue;
    }
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
    if (!isText(node)) {
      acc += 1;
      continue;
    }
    const s = acc;
    const e = acc + node.text.length;
    acc = e;
    if (e <= start || s >= end) continue;
    any = true;
    if (!node.marks.link) return false;
  }
  return any;
}

/** The href shared by every text run in the range, or null when the range is not
 *  uniformly covered by one link. Lets a menu prefill the link editor with the
 *  existing target. */
export function linkHrefInRange(nodes: InlineNode[], start: number, end: number): string | null {
  let acc = 0;
  let href: string | null = null;
  let any = false;
  for (const node of nodes) {
    if (!isText(node)) {
      acc += 1;
      continue;
    }
    const s = acc;
    const e = acc + node.text.length;
    acc = e;
    if (e <= start || s >= end) continue;
    const link = node.marks.link;
    if (!link) return null;
    if (!any) {
      href = link.href;
      any = true;
    } else if (href !== link.href) {
      return null;
    }
  }
  return any ? href : null;
}

/** Force a boolean mark on or off over a range, regardless of its current state.
 *  Used for multi-block selections, where every covered block must end up in the
 *  same state (so a toggle decided once over the whole selection applies
 *  uniformly, rather than each block flipping on its own). */
export function setMarkInInline(
  nodes: InlineNode[],
  start: number,
  end: number,
  mark: BooleanMark,
  on: boolean
): InlineNode[] {
  if (start >= end) return nodes;
  return mapRange(nodes, start, end, (m) => {
    const next = { ...m };
    if (on) next[mark] = true;
    else delete next[mark];
    return next;
  });
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
  return setMarkInInline(nodes, start, end, mark, !rangeHasMark(nodes, start, end, mark));
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
    case 's':
    case 'del':
    case 'strike':
      return { ...marks, strikethrough: true };
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
