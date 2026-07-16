// In-document find engine: the pure matching core shared by both editor backends.
// A single `findRanges(text, ...)` primitive turns a query + flags into character
// ranges over a string; the block backend applies it per inline-text leaf to build
// block-keyed matches (`.folio`), and the textarea backend applies it to the raw
// value (`.md` / plain text). No DOM, no model mutation — just string matching, so
// the whole surface is unit-tested here and both backends stay thin.
//
// Scope: inline-text leaves (paragraph / heading, at any depth inside lists and
// blockquotes) — the same set the decoration overlay paints. Code blocks (raw
// text) and table cells (coordinate-addressed, not block-keyed) are not matched
// yet; they need their own offset story and are a follow-up.

import type { BlockNode } from '../blockmodel';
import { inlinePlainText } from '../blocksurface/inline-ops';

export type FindFlags = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

/** A half-open character range `[start, end)` within a single string. */
export type FindRange = { start: number; end: number };

/** A match located in the block model: a flat range within one inline-text leaf,
 *  in the same offset space as inline-ops / the selection map. */
export type Match = { blockId: string; start: number; end: number };

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(literal: string): string {
  return literal.replace(REGEXP_SPECIAL, '\\$&');
}

/** Compile a query + flags into a global RegExp, or null when the query is empty
 *  or (in regex mode) invalid — callers treat null as "no matches". Whole-word
 *  wrapping applies only to a literal query; wrapping a user-supplied regex in `\b`
 *  is ambiguous, so regex mode owns its own boundaries. */
export function buildMatcher(query: string, flags: FindFlags): RegExp | null {
  if (query.length === 0) return null;
  let source = flags.regex ? query : escapeRegExp(query);
  if (flags.wholeWord && !flags.regex) source = `\\b${source}\\b`;
  try {
    return new RegExp(source, flags.caseSensitive ? 'g' : 'gi');
  } catch {
    return null; // invalid regex — surfaced to the user as zero matches
  }
}

/** Every non-empty match of a compiled matcher in `text`, in order. Resets the
 *  matcher's lastIndex so one compiled RegExp can be reused across many strings,
 *  and steps past a zero-width match (e.g. `a*`) so the scan always terminates. */
export function execAll(matcher: RegExp, text: string): FindRange[] {
  const out: FindRange[] = [];
  matcher.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(text)) !== null) {
    if (m[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** All matches of a query in a single string — the primitive the textarea backend
 *  uses directly, and the shape unit tests pin. */
export function findRanges(text: string, query: string, flags: FindFlags): FindRange[] {
  const matcher = buildMatcher(query, flags);
  return matcher ? execAll(matcher, text) : [];
}

/** All matches across a block document, in document order, as block-keyed records.
 *  Descends into lists and blockquotes; matches within each inline-text leaf, never
 *  across a block boundary. The matcher is compiled once and reused per leaf. */
export function findInDocument(blocks: BlockNode[], query: string, flags: FindFlags): Match[] {
  const matcher = buildMatcher(query, flags);
  if (!matcher) return [];
  const out: Match[] = [];
  const walk = (nodes: BlockNode[]): void => {
    for (const b of nodes) {
      if (b.type === 'paragraph' || b.type === 'heading') {
        const text = inlinePlainText(b.inline);
        for (const r of execAll(matcher, text)) out.push({ blockId: b.id, start: r.start, end: r.end });
      } else if (b.type === 'blockquote') {
        walk(b.children);
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        for (const item of b.items) walk(item.children);
      }
      // Barriers (code_block / table / hr / frozen_block) carry no inline-text leaf
      // to match in this pass.
    }
  };
  walk(blocks);
  return out;
}
