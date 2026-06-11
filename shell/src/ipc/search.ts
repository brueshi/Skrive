// Project-wide full-text search. Walks every Markdown file in the
// active project (via projectState.filePaths so the noise filter from
// the original scan applies) and emits hits with 1-indexed lines and
// UTF-16 column / matchLength offsets.
//
// Naive line-by-line scan, capped at SEARCH_HIT_CAP. Same posture as
// the v0.1.6 Rust path: enough for dogfood-scale projects; revisit if
// profiling shows it's hot. The renderer debounces invokes so a fast
// typist doesn't fan out IPC round-trips.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { SearchHit, SearchOptions } from '@skrive/shared';
import { projectState } from '../state/project-state';
import { IpcError, registerCommand } from '../main/dispatch';

const SEARCH_HIT_CAP = 500;

function utf16Length(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.length;
  return n;
}

export async function searchProject(
  query: string,
  options: SearchOptions
): Promise<SearchHit[]> {
  if (query.length === 0) return [];
  const root = projectState.root;
  if (!root) return [];

  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matchLength = utf16Length(needle);
  const hits: SearchHit[] = [];

  // Stable iteration order for path-sorted output. Sorting up front lets
  // us bail out of the cap predictably; the post-sort below is a no-op
  // on already-sorted paths but keeps the contract explicit.
  const paths = Array.from(projectState.filePaths).sort((a, b) =>
    a.localeCompare(b)
  );

  outer: for (const rel of paths) {
    let body: string;
    try {
      body = await fsp.readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const original = lines[i] ?? '';
      // Trim a single trailing CR so CRLF files don't leak \r into the
      // snippet. Don't trim other whitespace — column math is relative
      // to the original line.
      const line = original.endsWith('\r')
        ? original.slice(0, -1)
        : original;
      const haystack = options.caseSensitive ? line : line.toLowerCase();

      let cursor = 0;
      while (cursor <= haystack.length) {
        const at = haystack.indexOf(needle, cursor);
        if (at < 0) break;
        // UTF-16 column: number of code units before the match start.
        // JS strings are already UTF-16 internally, so `slice + length`
        // gives the right answer without char-iteration.
        const column = haystack.slice(0, at).length;
        hits.push({
          path: rel,
          line: i + 1,
          column,
          matchLength,
          snippet: line
        });
        if (hits.length >= SEARCH_HIT_CAP) break outer;
        cursor = at + Math.max(needle.length, 1);
      }
    }
  }

  hits.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  return hits;
}

export function registerSearchHandlers(): void {
  registerCommand('search:searchProject', async (payload) => {
    const { query, options } = payload;
    if (typeof query !== 'string') {
      throw new IpcError('INVALID_PAYLOAD', 'query must be a string');
    }
    const caseSensitive =
      typeof options === 'object' &&
      options !== null &&
      (options as SearchOptions).caseSensitive === true;
    return { hits: await searchProject(query, { caseSensitive }) };
  });
}
