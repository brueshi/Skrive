// Structural quirks of the HTML that specific applications put on the clipboard
// (SKR-186 / F30, F31). `cleanHtml.ts` handles the emphasis noise; this handles
// the block structure, where each source is wrong in its own way.
//
// Every rule below is named for the source that needs it and is written to fire
// only on that source's shape. A catch-all would be shorter and would quietly
// destroy formatting that some other application meant.
//
// Runs after `rehypeSanitizeUrls` (so an unsafe href is already gone) and before
// `rehypeCleanRichText` (so the emphasis pass sees the final block structure).

import { visit } from 'unist-util-visit';
import type { Element, ElementContent, Root, RootContent, Text } from 'hast';

/** Word's list bullets: `<span>·<span>&nbsp;</span></span>` or `1.` / `a)`. */
const WORD_MARKER = /^\s*([·•o§▪●-]|\d+[.)]|[a-z][.)])\s*$/i;
const ORDERED_MARKER = /^\s*(\d+|[a-z])[.)]/i;
/** Any font stack a code editor uses. VS Code names the concrete face, not `monospace`. */
const MONOSPACE = /\b(monospace|menlo|consolas|courier|"?sf ?mono"?|"?jetbrains ?mono"?|"?fira ?code"?)\b/i;
const BARE_URL = /(https?:\/\/[^\s<>()[\]]+[^\s<>()[\]{}.,;:!?'"])/g;

type Parent = Root | Element;

function isElement(node: unknown, tagName?: string): node is Element {
  const el = node as Element;
  return el?.type === 'element' && (tagName === undefined || el.tagName === tagName);
}

function isBlank(node: RootContent | ElementContent): boolean {
  return node.type === 'text' && node.value.trim() === '';
}

function textOf(node: ElementContent | RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function styleOf(node: Element): string {
  const style = node.properties?.style;
  return typeof style === 'string' ? style : '';
}

function classOf(node: Element): string {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : '';
}

// --- Word ------------------------------------------------------------------

// Word marks list paragraphs with a class and an `mso-list` style, and renders the
// bullet itself as literal content wrapped in downlevel-revealed conditional
// comments. Comments are stripped separately; here the leading marker span is
// removed and the run of sibling paragraphs becomes a real list.
function isWordListItem(node: RootContent | ElementContent): node is Element {
  if (!isElement(node, 'p')) return false;
  return /MsoListParagraph/i.test(classOf(node)) || /mso-list\s*:/i.test(styleOf(node));
}

/** Strip Word's rendered bullet/number, returning whether it was an ordered one. */
function stripWordMarker(item: Element): boolean {
  const first = item.children.findIndex((c) => !isBlank(c));
  if (first < 0) return false;
  const marker = item.children[first]!;
  if (!isElement(marker)) return false;
  const text = textOf(marker).replace(/ /g, ' ');
  if (!WORD_MARKER.test(text)) return false;
  item.children.splice(first, 1);
  // The marker span is followed by its own whitespace padding.
  while (item.children.length > 0 && isBlank(item.children[0]!)) item.children.shift();
  return ORDERED_MARKER.test(text);
}

function convertWordLists(parent: Parent): void {
  const out: Array<RootContent | ElementContent> = [];
  let run: Element[] = [];
  let ordered = false;

  const flush = (): void => {
    if (run.length === 0) return;
    const items: ElementContent[] = run.map((p) => ({
      type: 'element',
      tagName: 'li',
      properties: {},
      children: p.children
    }));
    out.push({ type: 'element', tagName: ordered ? 'ol' : 'ul', properties: {}, children: items });
    run = [];
    ordered = false;
  };

  for (const child of parent.children) {
    if (isWordListItem(child)) {
      // A blank text node between two list paragraphs must not break the run.
      ordered = stripWordMarker(child) || ordered;
      run.push(child);
      continue;
    }
    if (run.length > 0 && isBlank(child)) continue;
    flush();
    out.push(child);
  }
  flush();
  parent.children = out as Element['children'];
}

// --- Google Docs -----------------------------------------------------------

// Docs wraps each list item's text in a paragraph, which the mdast step reads as
// a loose list (blank lines between items). A lone paragraph child carries no
// meaning of its own, so unwrap it; an item with several blocks is genuinely loose
// and is left alone.
function unwrapListItemParagraphs(tree: Root): void {
  visit(tree, 'element', (node) => {
    if (node.tagName !== 'li') return;
    const meaningful = node.children.filter((c) => !isBlank(c));
    if (meaningful.length !== 1) return;
    const only = meaningful[0]!;
    if (!isElement(only, 'p')) return;
    node.children = only.children;
  });
}

// --- <br><br> --------------------------------------------------------------

// A run of two or more <br> is how many editors write a paragraph break. Converted
// as-is it becomes a pair of hard breaks, which serialize to lone-backslash lines.
// One <br> is a real hard break and is left alone.
function splitBreakRuns(parent: Parent): void {
  const out: Array<RootContent | ElementContent> = [];
  for (const child of parent.children) {
    if (!isElement(child, 'p')) {
      out.push(child);
      continue;
    }
    const chunks: ElementContent[][] = [[]];
    let breaks = 0;
    for (const node of child.children) {
      if (isElement(node, 'br')) {
        breaks++;
        continue;
      }
      if (breaks >= 2) chunks.push([]);
      else if (breaks === 1) chunks[chunks.length - 1]!.push({ type: 'element', tagName: 'br', properties: {}, children: [] });
      breaks = 0;
      chunks[chunks.length - 1]!.push(node);
    }
    const filled = chunks.filter((c) => c.some((n) => !isBlank(n)));
    if (filled.length <= 1) {
      out.push(child);
      continue;
    }
    for (const chunk of filled) {
      out.push({ type: 'element', tagName: 'p', properties: { ...child.properties }, children: chunk });
    }
  }
  parent.children = out as Element['children'];
}

// --- VS Code / any code editor ---------------------------------------------

// A code editor puts styled spans on the clipboard, one wrapper element per line,
// with the font stack as the only signal that it is code. Without this the lines
// become paragraphs and the code loses its shape. Restricted to an element at the
// fragment's ROOT: an inline monospace span inside prose is a code span, not a
// block, and Docs uses those for inline code.
function liftMonospaceBlocks(tree: Root): void {
  tree.children = tree.children.map((child) => {
    if (!isElement(child) || !MONOSPACE.test(styleOf(child))) return child;
    const lines = child.children.filter((c) => isElement(c));
    if (lines.length === 0) return child;
    const text = lines.map((line) => textOf(line).replace(/ /g, ' ')).join('\n');
    if (text.trim() === '') return child;
    const code: Element = {
      type: 'element',
      tagName: 'code',
      properties: {},
      children: [{ type: 'text', value: text }]
    };
    return { type: 'element', tagName: 'pre', properties: {}, children: [code] } satisfies Element;
  });
}

// --- bare URLs -------------------------------------------------------------

// A URL sitting in plain text stringifies as `https\://…`: the escape exists to
// stop Markdown from autolinking text that was never a link. Here it always was
// one on screen, so make it a real link and let it serialize as an autolink.
// Only http(s) is matched, so this cannot reintroduce a scheme the sanitizer just
// removed. Text inside a link, code, or a pre is left exactly as written.
const OPAQUE = new Set(['a', 'code', 'pre', 'kbd', 'samp']);

function autolinkBareUrls(parent: Parent): void {
  const out: Array<RootContent | ElementContent> = [];
  for (const child of parent.children) {
    if (isElement(child)) {
      if (!OPAQUE.has(child.tagName)) autolinkBareUrls(child);
      out.push(child);
      continue;
    }
    if (child.type !== 'text' || !BARE_URL.test(child.value)) {
      out.push(child);
      continue;
    }
    BARE_URL.lastIndex = 0;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = BARE_URL.exec(child.value)) !== null) {
      const url = match[0];
      if (match.index > last) {
        out.push({ type: 'text', value: child.value.slice(last, match.index) } satisfies Text);
      }
      out.push({
        type: 'element',
        tagName: 'a',
        properties: { href: url },
        children: [{ type: 'text', value: url }]
      });
      last = match.index + url.length;
    }
    if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) } satisfies Text);
  }
  parent.children = out as Element['children'];
}

// --- the plugin ------------------------------------------------------------

function stripComments(tree: Root): void {
  visit(tree, 'comment', (_node, index, parent) => {
    if (parent == null || index == null) return;
    parent.children.splice(index, 1);
    return index;
  });
}

/** Word/Docs/VS Code/editor structure repaired, in the order the rules depend on. */
export function rehypeSourceQuirks() {
  return (tree: Root): void => {
    // Comments first: Word's bullets hide inside them, and every later rule reads
    // "the first meaningful child", which a comment would otherwise be.
    stripComments(tree);
    liftMonospaceBlocks(tree);
    convertWordLists(tree);
    visit(tree, 'element', (node) => {
      if (node.tagName === 'blockquote' || node.tagName === 'li' || node.tagName === 'div') {
        convertWordLists(node);
      }
    });
    unwrapListItemParagraphs(tree);
    splitBreakRuns(tree);
    visit(tree, 'element', (node) => {
      if (node.tagName === 'blockquote' || node.tagName === 'li') splitBreakRuns(node);
    });
    autolinkBareUrls(tree);
  };
}
