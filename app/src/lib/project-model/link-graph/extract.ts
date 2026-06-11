// Internal-link extractor for a single Markdown body.
//
// Mirrors `src-tauri/src/link_graph.rs::extract`. Three CommonMark link
// shapes come out of mdast directly: inline `[text](url)`, reference
// uses `[text][label]` / `[label][]` / `[label]`, and definitions
// `[label]: target`. Wiki links `[[Name]]` aren't CommonMark, so a
// hand-rolled sweep finds those after the AST walk.
//
// Range semantics (UTF-16 code units, matching JS strings + CodeMirror):
//   - `inline`: the URL slice inside `[text](url)`.
//   - `wiki`: the inner name inside `[[Name]]` (alias suffix excluded).
//   - `referenceUse`: the full `[text][label]` span (display-only —
//     uses aren't rewritten on rename).
//   - `referenceDefinition`: the target URL inside the definition.
//
// External link targets (`http(s)://`, `mailto:`, `tel:`, `#anchor`)
// and any target that would escape the project root are dropped here.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';
import type { Definition, Root } from 'mdast';
import type { Edge } from '@skrive/shared';

export function extract(body: string, sourceRelpath: string): Edge[] {
  const tree: Root = fromMarkdown(body);
  const lineStarts = computeLineStarts(body);
  const edges: Edge[] = [];

  // Pass 1: collect definitions (identifier → url). Reference uses
  // resolve against this map. mdast preserves the parsed `identifier`
  // (label-folded per CommonMark), so case-insensitive label matching
  // falls out for free.
  const defs = new Map<string, string>();
  visit(tree, 'definition', (node: Definition) => {
    defs.set(node.identifier, node.url);
  });

  // Pass 2: emit edges for every link / linkReference / definition.
  visit(tree, (node) => {
    if (node.type === 'link') {
      if (!node.position) return;
      const dest = node.url;
      if (isExternal(dest)) return;
      const resolved = resolveRelative(sourceRelpath, dest);
      if (resolved === null) return;

      const range = findInlineUrlRange(
        body,
        node.position.start.offset!,
        node.position.end.offset!,
        dest
      );
      if (range === null) return;

      const [line, column] = offsetToLineCol(lineStarts, range.start);
      edges.push({
        target: { kind: 'relative', path: resolved },
        range,
        line,
        column,
        kind: 'inline'
      });
    } else if (node.type === 'linkReference') {
      if (!node.position) return;
      const dest = defs.get(node.identifier);
      // Unresolved references (no matching definition) are silently
      // dropped — same as the Rust path, where pulldown-cmark only
      // emits an edge when the use resolves.
      if (dest === undefined) return;
      if (isExternal(dest)) return;
      const resolved = resolveRelative(sourceRelpath, dest);
      if (resolved === null) return;

      const start = node.position.start.offset!;
      const end = node.position.end.offset!;
      const [line, column] = offsetToLineCol(lineStarts, start);
      edges.push({
        target: { kind: 'relative', path: resolved },
        range: { start, end },
        line,
        column,
        kind: 'referenceUse'
      });
    } else if (node.type === 'definition') {
      if (!node.position) return;
      const dest = node.url;
      if (isExternal(dest)) return;
      const resolved = resolveRelative(sourceRelpath, dest);
      if (resolved === null) return;

      const range = findDefinitionTargetRange(
        body,
        node.position.start.offset!,
        node.position.end.offset!,
        dest
      );
      if (range === null) return;

      const [line, column] = offsetToLineCol(lineStarts, range.start);
      edges.push({
        target: { kind: 'relative', path: resolved },
        range,
        line,
        column,
        kind: 'referenceDefinition'
      });
    }
  });

  // Wiki links sit outside CommonMark; sweep separately.
  extractWikiLinks(body, lineStarts, edges);

  // Document order. mdast emits in tree order, the wiki sweep emits
  // after it finishes — combining them in document order keeps the
  // edge list reading top-to-bottom the way callers expect.
  edges.sort((a, b) => a.range.start - b.range.start);

  return edges;
}

// ─────────────────────────── Helpers ───────────────────────────

function isExternal(dest: string): boolean {
  return (
    dest.startsWith('#') ||
    dest.startsWith('http://') ||
    dest.startsWith('https://') ||
    dest.startsWith('mailto:') ||
    dest.startsWith('tel:')
  );
}

/** Normalize a relative link target into a project-relative path with
 *  forward slashes. Strips any `#fragment` suffix — fragments address
 *  within-file anchors and don't participate in path resolution.
 *  Returns null when the link would escape the root or has no path
 *  part (`#anchor`-only targets are caught earlier by `isExternal`,
 *  but this guards against `#` after a slash sequence that fully
 *  resolves to empty). */
function resolveRelative(
  sourceRelpath: string,
  dest: string
): string | null {
  const hashIdx = dest.indexOf('#');
  const pathPart = hashIdx >= 0 ? dest.slice(0, hashIdx) : dest;
  if (pathPart.length === 0) return null;
  const sourceParts = sourceRelpath.split('/').slice(0, -1);
  const destParts = pathPart.split('/');
  const stack: string[] = [...sourceParts];
  for (const part of destParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) return null;
  return stack.join('/');
}

/** Inline link range narrows to just the URL slice inside `(url)`. The
 *  span covers `[text](url)`; we substring-search for `dest` after the
 *  last `(`. Bracketed URLs (`<url>`) get the same treatment — `dest`
 *  is what mdast decoded, matching the bytes inside the angle brackets. */
function findInlineUrlRange(
  body: string,
  spanStart: number,
  spanEnd: number,
  dest: string
): { start: number; end: number } | null {
  const span = body.slice(spanStart, spanEnd);
  const open = span.lastIndexOf('(');
  if (open < 0) return null;
  const local = span.slice(open + 1).indexOf(dest);
  if (local < 0) return null;
  const start = spanStart + open + 1 + local;
  return { start, end: start + dest.length };
}

/** Definition target range narrows to the URL inside `[label]: target`
 *  or `[label]: <target>` (with optional title following). */
function findDefinitionTargetRange(
  body: string,
  spanStart: number,
  spanEnd: number,
  dest: string
): { start: number; end: number } | null {
  const span = body.slice(spanStart, spanEnd);
  const labelEnd = span.indexOf(']:');
  if (labelEnd < 0) return null;
  let cursor = labelEnd + 2;
  while (
    cursor < span.length &&
    (span[cursor] === ' ' || span[cursor] === '\t')
  ) {
    cursor++;
  }
  if (cursor >= span.length) return null;
  if (span[cursor] === '<') cursor++;
  const local = span.slice(cursor).indexOf(dest);
  if (local < 0) return null;
  const start = spanStart + cursor + local;
  return { start, end: start + dest.length };
}

/** Sweep the body for `[[Name]]` / `[[Name|alias]]`. Aliases collapse
 *  to the name portion only; the range stops at the pipe. */
function extractWikiLinks(
  body: string,
  lineStarts: number[],
  edges: Edge[]
): void {
  let i = 0;
  while (i + 1 < body.length) {
    if (body[i] === '[' && body[i + 1] === '[') {
      const innerStart = i + 2;
      const innerEnd = body.indexOf(']]', innerStart);
      if (innerEnd < 0) {
        i++;
        continue;
      }
      const inner = body.slice(innerStart, innerEnd);
      const pipe = inner.indexOf('|');
      const nameRaw = pipe >= 0 ? inner.slice(0, pipe) : inner;
      const nameTrimmed = nameRaw.trim();
      if (nameTrimmed.length > 0) {
        const nameLen = pipe >= 0 ? pipe : inner.length;
        const start = innerStart;
        const [line, column] = offsetToLineCol(lineStarts, start);
        edges.push({
          target: { kind: 'wiki', name: nameTrimmed },
          range: { start, end: start + Math.min(nameLen, inner.length) },
          line,
          column,
          kind: 'wiki'
        });
      }
      i = innerEnd + 2;
      continue;
    }
    i++;
  }
}

function computeLineStarts(body: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\n') out.push(i + 1);
  }
  return out;
}

function offsetToLineCol(
  lineStarts: number[],
  offset: number
): [number, number] {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const line = lo;
  const column = offset - lineStarts[line]!;
  return [line, column];
}
