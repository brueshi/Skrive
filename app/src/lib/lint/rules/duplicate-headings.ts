// duplicate_headings — flag multiple headings with identical normalized
// text at the same level inside one file. Single-file scope.

import type { LintFinding } from '@skrive/shared';
import type { Heading } from 'mdast';
import { extractHeadings, lineColumnFromOffset } from '../mdast-utils';
import type { FileLintContext, FileRule } from '../types';

export const duplicateHeadingsRule: FileRule = {
  id: 'duplicate_headings',
  scope: 'file',
  defaultSeverity: 'warn',
  run(ctx: FileLintContext, severity): LintFinding[] {
    const headings = extractHeadings(ctx.ast);
    const seen = new Map<string, Heading>();
    const out: LintFinding[] = [];
    for (const heading of headings) {
      const text = headingText(heading);
      const key = `${heading.depth}::${normalize(text)}`;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, heading);
        continue;
      }
      const pos = positionFor(heading, ctx.body);
      out.push({
        rule: 'duplicate_headings',
        severity,
        path: ctx.path,
        line: pos.line,
        column: pos.column,
        range: pos.range,
        message: `Duplicate heading "${text}" at level ${heading.depth} (first seen on line ${first.position?.start.line ?? '?'}).`
      });
    }
    return out;
  }
};

function headingText(heading: Heading): string {
  let out = '';
  for (const child of heading.children) {
    if ('value' in child && typeof child.value === 'string') {
      out += child.value;
    } else if ('children' in child && Array.isArray(child.children)) {
      for (const sub of child.children) {
        if ('value' in sub && typeof (sub as { value: unknown }).value === 'string') {
          out += (sub as { value: string }).value;
        }
      }
    }
  }
  return out.trim();
}

function normalize(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function positionFor(
  heading: Heading,
  body: string
): { line: number; column: number; range: { start: number; end: number } | null } {
  const start = heading.position?.start;
  const end = heading.position?.end;
  if (!start) {
    return { line: 1, column: 1, range: null };
  }
  if (typeof start.offset === 'number' && typeof end?.offset === 'number') {
    return {
      line: start.line,
      column: start.column,
      range: { start: start.offset, end: end.offset }
    };
  }
  // Fall back to computing offsets from line/column.
  const offset = lineColumnFromOffset.toOffset(body, start.line, start.column);
  return {
    line: start.line,
    column: start.column,
    range: offset === null ? null : { start: offset, end: offset }
  };
}
