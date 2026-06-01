// ProseMirror -> Markdown, splice-untouched. The whole bet lives here:
//   - A clean block emits its verbatim `src` — byte-identical, no normalization.
//   - A frozen block always emits its verbatim `src`.
//   - A dirty block serializes canonically, UNLESS the idempotence guard finds
//     that its canonical form re-parses to the same tree as the original `src`
//     (an edit that was reverted, or a no-op), in which case the original bytes
//     are restored.
//   - Gaps are reconstructed at the SEAM: a captured gap (string, possibly '')
//     emits verbatim; a new seam (gapBefore === null, from a block created during
//     editing) emits the canonical separator. Gap fidelity therefore depends on
//     whether the seam is known, never on whether the block's content changed.

import type { Node as PMNode } from 'prosemirror-model';
import type { Root } from 'mdast';
import { parseMarkdown } from './mdast';

// Structural mdast equality ignoring `position`. Short-circuits on the first
// difference and allocates nothing. This replaces a
// `JSON.stringify(stripPositions(tree))` compare that, per guard check, cloned a
// whole position-stripped tree and serialized two trees to strings — three
// tree-sized allocations that were the dominant GC fuel in a snapshot. Key order
// is ignored, so it is at least as permissive as the old string compare (both
// operands come from the same parser, so order matched anyway).
function mdastEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!mdastEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k in ao) {
      if (k === 'position') continue;
      if (!mdastEqual(ao[k], bo[k])) return false;
    }
    for (const k in bo) {
      if (k === 'position') continue;
      if (!(k in ao)) return false;
    }
    return true;
  }
  return false;
}

// The `src` operand of the guard is a block's original bytes, stable while the
// block is edited, so its parsed tree is cached by string and reused across
// snapshots (mdastEqual only reads it, never mutates). The `canonical` operand
// changes every keystroke and is parsed fresh. Bounded by a coarse clear so a
// long session can't grow it without limit; it is a pure perf cache, so dropping
// entries only costs a re-parse.
const SRC_TREE_CACHE_LIMIT = 1024;
const srcTreeCache = new Map<string, Root>();
function srcTree(src: string): Root {
  const hit = srcTreeCache.get(src);
  if (hit !== undefined) return hit;
  const tree = parseMarkdown(src);
  if (srcTreeCache.size >= SRC_TREE_CACHE_LIMIT) srcTreeCache.clear();
  srcTreeCache.set(src, tree);
  return tree;
}

// Two Markdown strings are "semantically equal" when they parse to the same
// mdast tree (ignoring source positions). This is what lets edit-then-revert
// restore the original bytes instead of baking in normalization.
function semanticallyEqual(canonical: string, src: string): boolean {
  return mdastEqual(parseMarkdown(canonical), srcTree(src));
}

type InlineRun = { text: string; code: boolean; strong: boolean; em: boolean; href: string | null };

function runKey(r: InlineRun): string {
  return `${r.code}|${r.strong}|${r.em}|${r.href}`;
}

// Coalesce adjacent text nodes that carry the same mark set into one run, so
// extending a bold span (which PM may represent as two adjacent strong text
// nodes) serializes to `**bold word**`, not `**bold**** word**`.
function serializeInline(node: PMNode): string {
  const runs: InlineRun[] = [];
  node.forEach((child) => {
    if (!child.isText) return;
    const names = new Set(child.marks.map((m) => m.type.name));
    const link = child.marks.find((m) => m.type.name === 'link');
    const run: InlineRun = {
      text: child.text ?? '',
      code: names.has('code'),
      strong: names.has('strong'),
      em: names.has('em'),
      href: link ? String(link.attrs.href) : null
    };
    const prev = runs[runs.length - 1];
    if (prev && runKey(prev) === runKey(run)) prev.text += run.text;
    else runs.push(run);
  });

  let out = '';
  for (const r of runs) {
    let text = r.text;
    if (r.code) text = `\`${text}\``;
    if (r.strong) text = `**${text}**`;
    if (r.em) text = `*${text}*`;
    if (r.href != null) text = `[${text}](${r.href})`;
    out += text;
  }
  return out;
}

// A list serializes item by item. Each item opens with its marker prefix; every
// continuation line — wrapped content, an extra paragraph, a nested sub-list —
// is indented to the marker's width so it stays inside the item under CommonMark.
// A loose list (`spread`) blank-line-separates both its items and the blocks
// within an item; a tight one packs them line-to-line. Recurses through
// canonicalBlock, so nested lists indent at each level.
function serializeList(block: PMNode): string {
  const ordered = block.type.name === 'ordered_list';
  const spread = block.attrs.spread === true;
  const marker = block.attrs.marker ? String(block.attrs.marker) : '-';
  const start: number = typeof block.attrs.start === 'number' ? block.attrs.start : 1;
  const delimiter = block.attrs.delimiter === ')' ? ')' : '.';

  const items: string[] = [];
  block.forEach((item, _offset, index) => {
    const prefix = ordered ? `${start + index}${delimiter} ` : `${marker} `;
    const indent = ' '.repeat(prefix.length);

    const childBlocks: string[] = [];
    item.forEach((child) => childBlocks.push(canonicalBlock(child)));
    const body = childBlocks.join(spread ? '\n\n' : '\n');

    const rendered = body
      .split('\n')
      .map((line, i) => {
        if (i === 0) return prefix + line; // the opening paragraph carries the marker
        return line.length > 0 ? indent + line : ''; // continuation, blanks stay blank
      })
      .join('\n');
    items.push(rendered);
  });

  return items.join(spread ? '\n\n' : '\n');
}

// A blockquote serializes by canonically serializing its child blocks, joining
// them with a blank line, then quoting every line: `> ` before content, a bare
// `>` for the blank separators. Recurses through canonicalBlock, so a nested
// blockquote or a heading inside the quote is quoted at each level.
function quotedBlockquote(block: PMNode): string {
  const parts: string[] = [];
  block.forEach((child) => parts.push(canonicalBlock(child)));
  return parts
    .join('\n\n')
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

// A pipe inside a GFM table cell must be escaped, and a cell is a single line —
// any stray newline (from a hard break) would split the row, so collapse it.
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// PM table -> canonical GFM: a header row, an alignment delimiter row derived
// from the header cells' `align` attr, then the body rows. Cells serialize their
// inline content through serializeInline (so marks survive) with pipes escaped.
// Minimal padding — `| a | b |` — which re-parses to the same table, so this is a
// fixpoint; an untouched table is restored verbatim by the idempotence guard.
function serializeTable(block: PMNode): string {
  const rows: PMNode[] = [];
  block.forEach((row) => rows.push(row));
  const header = rows[0];
  if (!header) return '';

  const rowLine = (row: PMNode): string => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(escapeTableCell(serializeInline(cell))));
    return `| ${cells.join(' | ')} |`;
  };

  const delimiters: string[] = [];
  header.forEach((cell) => {
    const align = cell.attrs.align;
    delimiters.push(
      align === 'left'
        ? ':---'
        : align === 'right'
          ? '---:'
          : align === 'center'
            ? ':---:'
            : '---'
    );
  });

  const lines = [rowLine(header), `| ${delimiters.join(' | ')} |`];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row) lines.push(rowLine(row));
  }
  return lines.join('\n');
}

function canonicalBlock(block: PMNode): string {
  switch (block.type.name) {
    case 'blockquote':
      return quotedBlockquote(block);
    case 'table':
      return serializeTable(block);
    case 'heading':
      return `${'#'.repeat(block.attrs.level)} ${serializeInline(block)}`;
    case 'code_block': {
      const lang = block.attrs.lang ? String(block.attrs.lang) : '';
      return `\`\`\`${lang}\n${block.textContent}\n\`\`\``;
    }
    case 'bullet_list':
    case 'ordered_list':
      return serializeList(block);
    case 'horizontal_rule':
      // Canonical form for a freshly-inserted rule. A parsed rule with a
      // different marker (`***`, `___`) is dirty-equal to this under the
      // idempotence guard, so its original bytes are restored.
      return '---';
    case 'paragraph':
    default:
      return serializeInline(block);
  }
}

// serializeBlock is a pure function of its (immutable) block node, so memoize it
// by node identity. ProseMirror structurally shares unchanged nodes across
// document versions, so across debounced snapshots only the block actually
// edited since the last snapshot is a fresh reference and recomputes; every other
// block — clean or dirty — is a cache hit. This bounds a snapshot to the one
// changed block rather than re-running the parse-heavy idempotence guard for
// every dirty block accumulated over a writing session. The WeakMap lets entries
// for superseded node versions be collected on their own.
const blockCache = new WeakMap<PMNode, string>();

function serializeBlock(block: PMNode): string {
  const cached = blockCache.get(block);
  if (cached !== undefined) return cached;
  const result = serializeBlockUncached(block);
  blockCache.set(block, result);
  return result;
}

function serializeBlockUncached(block: PMNode): string {
  // Frozen blocks are verbatim by construction and carry no `dirty` state.
  if (block.type.name === 'frozen_block') return String(block.attrs.src ?? '');

  const src: string | null = block.attrs.src;
  if (!block.attrs.dirty && src != null) return src;

  const canonical = canonicalBlock(block);
  if (src != null && semanticallyEqual(canonical, src)) return src;
  return canonical;
}

// The gap at the seam before a block. A captured seam (string) is authoritative;
// a new seam (null) is reconstructed: nothing before the first block, the
// standard blank-line separator between top-level blocks otherwise.
function gapForSeam(block: PMNode, index: number): string {
  const captured: string | null = block.attrs.gapBefore ?? null;
  if (captured != null) return captured;
  return index === 0 ? '' : '\n\n';
}

export function serializeDoc(doc: PMNode): string {
  let out = '';
  doc.forEach((block, _offset, index) => {
    out += gapForSeam(block, index);
    out += serializeBlock(block);
  });
  out += doc.attrs.trailingGap;
  return out;
}
