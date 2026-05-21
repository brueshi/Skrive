// GitHub-compatible heading slugs for in-document anchor links.
//
// The preview assigns these as the `id` on rendered headings, and the
// same algorithm is what `[label](#slug)` links resolve against. The
// load-bearing requirement is *self-consistency*: the id we emit and the
// fragment we navigate to are produced by the same function, so links
// never miss. The transformation closely follows github-slugger's
// observable algorithm so the slugs also line up with what GitHub and
// rehype-slug generate when the document is later published — close, not
// byte-exact (we strip a few symbol characters github-slugger happens to
// keep). If exact publish parity ever becomes load-bearing for the
// export pipeline, swap this for the `github-slugger` package; until
// then a local implementation avoids a dependency for a small, stable
// surface.
//
// Implementation note: github-slugger ships a denylist regex built from
// raw Unicode punctuation ranges. We use an allow-list instead —
// "keep letters, numbers, space, hyphen, underscore; drop the rest" —
// because it's expressed entirely in ASCII (no fragile literal-codepoint
// ranges to survive an editor round-trip) and `\p{L}`/`\p{N}` keep
// non-Latin scripts slugging sensibly.

/**
 * Slug for a single heading's plain text. Lowercase, drop punctuation
 * and symbols, then spaces become hyphens. Whitespace runs are *not*
 * collapsed first, so "a & b" → "a--b": removing the `&` leaves its two
 * surrounding spaces behind, and each becomes a hyphen — matching
 * GitHub.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .replace(/ /g, '-');
}

/**
 * Per-document slug de-duplicator. GitHub disambiguates repeated slugs
 * by appending `-1`, `-2`, … in document order, and guards against a
 * manufactured collision (a literal "foo-1" heading sitting next to two
 * "foo" headings). Construct one per render pass and call `next` for
 * each heading top-to-bottom; the running counts live in `occurrences`.
 *
 * This replicates github-slugger's loop exactly so a published copy of
 * the document anchors to the same fragments.
 */
export class SlugDeduper {
  private readonly occurrences = new Map<string, number>();

  next(text: string): string {
    const original = slugify(text);
    let slug = original;
    while (this.occurrences.has(slug)) {
      const n = (this.occurrences.get(original) ?? 0) + 1;
      this.occurrences.set(original, n);
      slug = `${original}-${n}`;
    }
    this.occurrences.set(slug, 0);
    return slug;
  }
}
