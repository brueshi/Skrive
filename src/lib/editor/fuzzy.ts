// Fuzzy scorer for the command palette and — later — similar filter UIs.
//
// Takes a query string and a target string; walks the query characters in
// order and tries to match each in the target, accumulating a score. A
// non-match returns null so callers can drop the target cheaply. On match,
// returns the score and the indices in the target where each query char
// landed, which the UI uses to highlight matched characters.
//
// Scoring is heuristic and deliberately simple — we don't need Sublime-
// tier quality for a v0 file switcher. The knobs to pay attention to:
//
// - Case-insensitive match.
// - Consecutive-run bonus: matching "foo" against "foobar" beats "frodo".
// - Word-start bonus: a char matched right after `/` or `-` or `_` is
//   stronger than one in the middle of a word. Matches VS Code's feel.
// - Substring bonus: if the query appears verbatim, crown that target
//   — the writer almost certainly meant it.
// - Shortness tiebreak: a match in a shorter target beats the same match
//   in a longer one.

export type FuzzyMatch = {
  score: number;
  /** Indices in the target string where each query char matched. */
  indices: number[];
};

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) {
    return { score: 0, indices: [] };
  }
  if (target.length === 0) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const indices: number[] = [];
  let ti = 0;
  let score = 0;
  let consecutive = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const needle = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === needle) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;

    indices.push(found);

    // Base score for a match.
    score += 1;

    // Start-of-string and post-separator matches are worth more —
    // they anchor the query to a meaningful boundary.
    const prev = found === 0 ? "" : target[found - 1];
    const isBoundary =
      found === 0 || prev === "/" || prev === "-" || prev === "_" || prev === " ";
    if (isBoundary) score += 3;

    // Consecutive chars compound — "foo" scoring against "foobar"
    // should far exceed "foo" against "f_o_o".
    if (qi > 0 && indices[qi - 1] === found - 1) {
      consecutive += 1;
      score += consecutive;
    } else {
      consecutive = 0;
    }

    ti = found + 1;
  }

  // Contiguous substring — not just fuzzy-adjacent. Large bump because
  // the writer almost certainly wanted this target.
  const substringIdx = t.indexOf(q);
  if (substringIdx !== -1) {
    score += 10;
    // If the substring starts at a word boundary, bump again.
    const prev = substringIdx === 0 ? "" : target[substringIdx - 1];
    if (
      substringIdx === 0 ||
      prev === "/" ||
      prev === "-" ||
      prev === "_" ||
      prev === " "
    ) {
      score += 5;
    }
  }

  // Shortness tiebreak — among candidates with the same match pattern,
  // prefer the shorter string (more specific target).
  score += Math.max(0, 50 - target.length) / 100;

  return { score, indices };
}

export type ScoredEntry<T> = {
  item: T;
  score: number;
  indices: number[];
};

/**
 * Score a set of items and return the matching ones sorted best-first.
 * `getHaystack` returns the string to match against for each item —
 * the command palette passes the file's path so both filename and
 * directory contribute to matching.
 */
export function rankItems<T>(
  query: string,
  items: T[],
  getHaystack: (item: T) => string,
): ScoredEntry<T>[] {
  const scored: ScoredEntry<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, getHaystack(item));
    if (!match) continue;
    scored.push({ item, score: match.score, indices: match.indices });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
