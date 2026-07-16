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
import { HARD_BREAK_ATTR, TAG_ATTR, TAG_CLASS } from './render';

function isText(node: InlineNode): node is Extract<InlineNode, { kind: 'text' }> {
  return node.kind === 'text';
}

/** Width of a leaf in the flat offset space: a text run's length; a tag its
 *  rendered `('#'+name).length` (a multi-cell atom); one unit for a single-cell
 *  atom (image / hard break). */
function nodeWidth(node: InlineNode): number {
  if (node.kind === 'text') return node.text.length;
  if (node.kind === 'tag') return 1 + node.name.length;
  return 1;
}

/** Structural equality of two mark sets. Boolean marks compare by truthiness —
 *  absent and false are the same mark state — and links by href + title. */
export function marksEqual(a: InlineMarks, b: InlineMarks): boolean {
  if (
    !a.em !== !b.em ||
    !a.strong !== !b.strong ||
    !a.code !== !b.code ||
    !a.strikethrough !== !b.strikethrough ||
    !a.underline !== !b.underline
  ) {
    return false;
  }
  if (!a.link !== !b.link) return false;
  return !a.link || !b.link || (a.link.href === b.link.href && a.link.title === b.link.title);
}

/** Merge adjacent same-mark text runs (SKR-192). Mark edits split runs at the
 *  range boundaries and deletes drop the middle, so identical neighbors
 *  accumulate; unmerged they render as sibling <strong>/<em> elements and
 *  double-click word selection stops at the seams. Atoms never merge and act as
 *  seams. Returns the input array unchanged (same reference) when nothing merges. */
export function coalesceInline(nodes: InlineNode[]): InlineNode[] {
  if (nodes.length < 2) return nodes;
  const out: InlineNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && isText(prev) && isText(node) && marksEqual(prev.marks, node.marks)) {
      out[out.length - 1] = { kind: 'text', text: prev.text + node.text, marks: prev.marks };
    } else {
      out.push(node);
    }
  }
  return out.length === nodes.length ? nodes : out;
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
      // Atom. A caret resting at or before its first cell inserts a fresh text run
      // in front of it, inheriting the atom's marks. An offset on the text|atom seam
      // is consumed by the preceding text run first (offset <= acc + len above), so
      // this only fires when no text precedes the point. A multi-cell atom (a tag)
      // has interior cells: an offset landing strictly inside it snaps to just after
      // it (the second check), since a tag is indivisible.
      const w = nodeWidth(node);
      if (!done && offset <= acc) {
        out.push({ kind: 'text', text, marks: node.marks });
        done = true;
      }
      out.push(node);
      acc += w;
      if (!done && offset < acc) {
        out.push({ kind: 'text', text, marks: node.marks });
        done = true;
      }
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

/** Insert a hard-break atom at a flat offset, splitting the text run it lands in
 *  and inheriting that run's marks (a break typed inside a bold word stays inside
 *  the bold run, matching what a DOM readback reconstructs). A caret resting on a
 *  text|atom seam is consumed by the preceding text run first, so the break lands
 *  after it; at or past the end it inherits the last text run's marks. Unlike text,
 *  a break is its own node — it never merges — so no coalesce is needed. */
export function insertBreakInInline(nodes: InlineNode[], offset: number): InlineNode[] {
  const out: InlineNode[] = [];
  let acc = 0;
  let done = false;
  for (const node of nodes) {
    if (isText(node)) {
      const len = node.text.length;
      if (!done && offset <= acc + len) {
        const local = offset - acc;
        const left = node.text.slice(0, local);
        const right = node.text.slice(local);
        if (left) out.push({ kind: 'text', text: left, marks: node.marks });
        out.push({ kind: 'break', marks: { ...node.marks } });
        if (right) out.push({ kind: 'text', text: right, marks: node.marks });
        done = true;
      } else {
        out.push(node);
      }
      acc += len;
    } else {
      const w = nodeWidth(node);
      if (!done && offset <= acc) {
        out.push({ kind: 'break', marks: { ...node.marks } });
        done = true;
      }
      out.push(node);
      acc += w;
      if (!done && offset < acc) {
        // An offset strictly inside a multi-cell atom (a tag) snaps after it.
        out.push({ kind: 'break', marks: { ...node.marks } });
        done = true;
      }
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
    out.push({ kind: 'break', marks: { ...marks } });
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
  // Deleting everything between two same-mark runs leaves identical neighbors.
  return coalesceInline(out);
}

/** Total flat length of an inline run: text characters plus one per atom. */
export function inlineLength(nodes: InlineNode[]): number {
  let n = 0;
  for (const node of nodes) n += nodeWidth(node);
  return n;
}

/** Flat plain text of an inline run (no marks). Used to read the `/query` of the
 *  slash menu out of the focused block. A tag contributes its `#name` text so the
 *  plain text matches the characters the tag's cells occupy in offset space. */
export function inlinePlainText(nodes: InlineNode[]): string {
  let s = '';
  for (const node of nodes) {
    if (node.kind === 'text') s += node.text;
    else if (node.kind === 'tag') s += `#${node.name}`;
  }
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

/** Splice an inline tag leaf into `nodes` at a flat offset, inheriting `marks`
 *  (the context at the insertion point). Built on splitInline so it obeys the same
 *  offset rules as every other edit; the tag is its own node and never merges. */
export function insertTagInInline(nodes: InlineNode[], offset: number, name: string, marks: InlineMarks): InlineNode[] {
  const [left, right] = splitInline(nodes, offset);
  return coalesceInline([...left, { kind: 'tag', name, marks: { ...marks } }, ...right]);
}

/** The toggleable boolean marks (link is set/cleared with a value, separately). */
export type BooleanMark = 'strong' | 'em' | 'code' | 'strikethrough' | 'underline';

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
      // Atoms carry no toggleable marks, but they hold cells in the offset space,
      // so advance past them or every offset after an atom would be misaligned.
      out.push(node);
      acc += nodeWidth(node);
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
      acc += nodeWidth(node); // atoms hold cells in the offset space; stay aligned
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
      acc += nodeWidth(node);
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
      acc += nodeWidth(node);
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

/** The mark context a collapsed caret sits in (SKR-177): the marks of the run
 *  covering the character BEFORE the caret (Docs semantics — typing continues the
 *  preceding run's formatting), or the first run's marks at offset 0, or {} when
 *  empty. Atoms carry marks too, so a caret after a bold hard break stays bold. */
export function marksAtOffset(nodes: InlineNode[], offset: number): InlineMarks {
  if (nodes.length === 0) return {};
  const probe = offset > 0 ? offset - 1 : 0;
  let acc = 0;
  for (const node of nodes) {
    const w = nodeWidth(node);
    if (probe < acc + w) return node.marks;
    acc += w;
  }
  return nodes[nodes.length - 1]!.marks; // past end: the last run's context
}

/** The link run a caret at `offset` sits in (SKR-177): the maximal contiguous span
 *  of runs sharing the link the character BEFORE the caret carries, expanded so a
 *  caret anywhere inside a link resolves the whole link's range and href. Null when
 *  the caret is not inside a link (offset 0, or the preceding run is unlinked). Lets
 *  a collapsed caret edit/remove a link without selecting its exact extent. */
export function linkRunAt(nodes: InlineNode[], offset: number): { start: number; end: number; href: string } | null {
  if (offset <= 0) return null;
  const probe = offset - 1;
  const bounds: Array<{ start: number; end: number; node: InlineNode }> = [];
  let acc = 0;
  let hit: { index: number; link: NonNullable<InlineMarks['link']> } | null = null;
  for (const node of nodes) {
    const w = nodeWidth(node);
    bounds.push({ start: acc, end: acc + w, node });
    if (hit === null && probe < acc + w) {
      if (!node.marks.link) return null;
      hit = { index: bounds.length - 1, link: node.marks.link };
    }
    acc += w;
  }
  if (!hit) return null;
  const link = hit.link;
  const same = (n: InlineNode): boolean =>
    !!n.marks.link && n.marks.link.href === link.href && (n.marks.link.title ?? null) === (link.title ?? null);
  let lo = hit.index;
  while (lo > 0 && same(bounds[lo - 1]!.node)) lo--;
  let hi = hit.index;
  while (hi + 1 < bounds.length && same(bounds[hi + 1]!.node)) hi++;
  return { start: bounds[lo]!.start, end: bounds[hi]!.end, href: link.href };
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
  return coalesceInline(
    mapRange(nodes, start, end, (m) => {
      const next = { ...m };
      if (on) next[mark] = true;
      else delete next[mark];
      return next;
    })
  );
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
  return coalesceInline(
    mapRange(nodes, start, end, (m) => {
      const next = { ...m };
      if (link) next.link = link;
      else delete next.link;
      return next;
    })
  );
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
    case 'u':
    case 'ins':
      return { ...marks, underline: true };
    default:
      return marks;
  }
}

function walkDom(node: Node, marks: InlineMarks, out: InlineNode[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Strip the zero-width caret filler (SKR-176) — it is view-only, never model
      // content. It lives in its own node, but an IME can merge it into an adjacent
      // run, so strip the character rather than skip the node.
      const text = (child as Text).data.replace(/\u200b/g, '');
      if (text) out.push({ kind: 'text', text, marks: { ...marks } });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') {
        // Only a tagged <br> is a real hard break. A bare <br> is the placeholder an
        // empty block carries for height/caret — view-only, not model content.
        if (el.hasAttribute(HARD_BREAK_ATTR)) out.push({ kind: 'break', marks: { ...marks } });
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
      } else if (tag === 'span' && el.classList.contains(TAG_CLASS)) {
        // An inline-tag chip. Its name is authoritative in the attribute; the
        // `#name` text inside is view-only, so read the attribute (falling back to
        // stripping the leading `#`) and don't descend into the span.
        const name = el.getAttribute(TAG_ATTR) ?? (el.textContent ?? '').replace(/^#/, '');
        if (name) out.push({ kind: 'tag', name, marks: { ...marks } });
      } else {
        walkDom(el, markEl(tag, marks), out);
      }
    }
  }
}

/** Reconstruct a block's inline model from its DOM (the inverse of the inline
 *  render). Used to reconcile after a native edit the hot path didn't model —
 *  IME composition. walkDom already distinguishes a real hard break (tagged <br>)
 *  from the view-only placeholders — the bare <br> an empty block carries and the
 *  zero-width caret filler on a trailing-break line — so neither reads back as
 *  content: an empty block reads empty, and a phantom trailing break can't appear
 *  even when an IME composes in front of a placeholder (SKR-192 / SKR-176). */
export function readInlineFromDOM(blockEl: HTMLElement): InlineNode[] {
  const out: InlineNode[] = [];
  walkDom(blockEl, {}, out);
  return coalesceInline(out);
}
