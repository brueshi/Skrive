// Markdown -> mdast -> ProseMirror, capturing the source map.
//
// We parse with mdast-util-from-markdown (which carries byte offsets on every
// node), then map each top-level block to a PM node, slicing its verbatim source
// and the gap before it straight out of the original string. The inline
// structure is mapped faithfully so a *dirty* block can serialize canonically,
// but for a *clean* block the inline tree is never consulted — `src` wins.
//
// Anything the schema does not model richly (blockquotes, tables, thematic
// breaks, HTML, loose or nested lists) becomes a `frozen_block`: it round-trips
// verbatim and is never canonicalized, so it cannot be corrupted by an edit.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type {
  Root,
  RootContent,
  PhrasingContent,
  List,
  ListItem
} from 'mdast';
import { schema } from './schema';

type WithOffsets = { position?: { start: { offset?: number }; end: { offset?: number } } };

function offsetStart(node: WithOffsets, fallback: number): number {
  return node.position?.start?.offset ?? fallback;
}
function offsetEnd(node: WithOffsets, fallback: number): number {
  return node.position?.end?.offset ?? fallback;
}

function inlineToPM(nodes: PhrasingContent[] | undefined, marks: readonly Mark[]): PMNode[] {
  if (!nodes) return [];
  const out: PMNode[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        if (n.value) out.push(schema.text(n.value, marks as Mark[]));
        break;
      case 'inlineCode':
        if (n.value) out.push(schema.text(n.value, schema.marks.code.create().addToSet(marks)));
        break;
      case 'emphasis':
        out.push(...inlineToPM(n.children, schema.marks.em.create().addToSet(marks)));
        break;
      case 'strong':
        out.push(...inlineToPM(n.children, schema.marks.strong.create().addToSet(marks)));
        break;
      case 'link':
        out.push(
          ...inlineToPM(
            n.children,
            schema.marks.link.create({ href: n.url ?? '' }).addToSet(marks)
          )
        );
        break;
      case 'break':
        out.push(schema.text('\n', marks as Mark[]));
        break;
      default:
        // Anything else with children (e.g. delete/strikethrough we don't model
        // yet) contributes its text; a leaf with a value contributes its value.
        if ('children' in n && n.children) out.push(...inlineToPM(n.children, marks));
        else if ('value' in n && typeof n.value === 'string' && n.value)
          out.push(schema.text(n.value, marks as Mark[]));
    }
  }
  return out;
}

// A list is "simple" — safe to model as an editable PM list — only when every
// item is a single paragraph and the list is tight. Loose or nested lists are
// frozen so an edit can never flatten their structure.
function isSimpleList(node: List): boolean {
  if (node.spread) return false;
  return (node.children ?? []).every((item: ListItem) => {
    if (item.spread) return false;
    const kids = item.children ?? [];
    return kids.length === 1 && kids[0]?.type === 'paragraph';
  });
}

function listItemsToPM(node: List): PMNode[] {
  return (node.children ?? []).map((item: ListItem) => {
    const para = item.children.find((c) => c.type === 'paragraph');
    const inline = para && para.type === 'paragraph' ? inlineToPM(para.children, []) : [];
    return schema.node('list_item', {}, [schema.node('paragraph', {}, inline)]);
  });
}

function frozen(src: string, gapBefore: string): PMNode {
  return schema.node('frozen_block', { src, gapBefore });
}

function blockToPM(node: RootContent, src: string, gapBefore: string): PMNode {
  const base = { src, gapBefore, dirty: false };
  switch (node.type) {
    case 'heading':
      return schema.node('heading', { ...base, level: node.depth }, inlineToPM(node.children, []));
    case 'code':
      return schema.node(
        'code_block',
        { ...base, lang: node.lang ?? '' },
        node.value ? [schema.text(node.value)] : []
      );
    case 'paragraph':
      return schema.node('paragraph', base, inlineToPM(node.children, []));
    case 'list': {
      if (!isSimpleList(node)) return frozen(src, gapBefore);
      if (node.ordered) {
        const start = node.start ?? 1;
        const delimiter = src.match(/^\s*\d+([.)])/)?.[1] ?? '.';
        return schema.node('ordered_list', { ...base, start, delimiter }, listItemsToPM(node));
      }
      const marker = src.match(/^\s*([-*+])/)?.[1] ?? '-';
      return schema.node('bullet_list', { ...base, marker }, listItemsToPM(node));
    }
    default:
      // Blockquote, table, thematicBreak, html, definition, footnote, etc.:
      // preserved verbatim, never canonicalized.
      return frozen(src, gapBefore);
  }
}

export function parseDoc(md: string): PMNode {
  const root = fromMarkdown(md) as Root;
  const children = root.children ?? [];

  const blocks: PMNode[] = [];
  let prevEnd = 0;
  for (const child of children) {
    const start = offsetStart(child, prevEnd);
    const end = offsetEnd(child, start);
    const gapBefore = md.slice(prevEnd, start);
    const src = md.slice(start, end);
    blocks.push(blockToPM(child, src, gapBefore));
    prevEnd = end;
  }
  const trailingGap = md.slice(prevEnd);

  // An empty document still needs one block to satisfy `block+`.
  if (blocks.length === 0) blocks.push(schema.node('paragraph', { src: '', gapBefore: '' }));

  return schema.node('doc', { trailingGap }, blocks);
}
