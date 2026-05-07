// Small helpers shared across rules.

import type { Heading, Root as MdastRoot } from 'mdast';

export function extractHeadings(ast: MdastRoot): Heading[] {
  const out: Heading[] = [];
  walkHeadings(ast, out);
  return out;
}

function walkHeadings(node: MdastRoot | Heading | { children?: unknown[]; type: string }, out: Heading[]): void {
  if (node.type === 'heading') {
    out.push(node as Heading);
    return;
  }
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (child && typeof child === 'object' && 'type' in child) {
      walkHeadings(child as { type: string }, out);
    }
  }
}

/**
 * Translate between (line, column) and absolute offsets when mdast
 * doesn't carry `offset` on a position. mdast-util-from-markdown
 * usually includes both, but the helpers here are defensive.
 */
export const lineColumnFromOffset = {
  toOffset(body: string, line: number, column: number): number | null {
    if (line < 1 || column < 1) return null;
    let pos = 0;
    let currentLine = 1;
    while (currentLine < line) {
      const next = body.indexOf('\n', pos);
      if (next === -1) return null;
      pos = next + 1;
      currentLine += 1;
    }
    return pos + (column - 1);
  }
};
