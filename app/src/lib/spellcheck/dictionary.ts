// Skrive's own dictionaries, layered on top of whatever the OS checker knows.
//
// Two lists feed this: the writer's personal dictionary (a preference, theirs
// across every project) and the project's words (`.skrive.toml` under
// `[dictionary] project_words`, committed with the manuscript so a character
// name or an invented place stops being wrong for everyone who opens it).
//
// The layering is one-directional and deliberate: these lists can only REMOVE a
// misspelling the oracle reported, never add one. A dictionary is a way to say
// "this is a word", not a second opinion on the rest of the language.

/** A word is matched case-insensitively, so teaching "Atticus" also accepts
 *  "atticus" at the start of a sentence. Skrive never asks the writer to teach
 *  the same word twice for capitalization. */
function normalize(word: string): string {
  return word.trim().toLowerCase();
}

/** The layered dictionary as a single membership test. Built once per settled
 *  check pass; rebuilding is a set construction over two small lists. */
export class SpellDictionary {
  private readonly words: Set<string>;

  constructor(personal: readonly string[], projectWords: readonly string[]) {
    this.words = new Set<string>();
    for (const word of personal) this.add(word);
    for (const word of projectWords) this.add(word);
  }

  private add(word: string): void {
    const normalized = normalize(word);
    if (normalized.length > 0) this.words.add(normalized);
  }

  /** True when this word is known and any misspelling reported on it should be
   *  discarded. A possessive is matched against its stem, so teaching "Atticus"
   *  also accepts "Atticus's" — the OS checker does the same, and having to
   *  teach both forms would read as a bug. */
  has(word: string): boolean {
    const normalized = normalize(word);
    if (normalized.length === 0) return true;
    if (this.words.has(normalized)) return true;
    // Straight and typographic apostrophes both appear in real prose.
    const possessive = /['’]s$/;
    return possessive.test(normalized) && this.words.has(normalized.replace(possessive, ''));
  }

  get size(): number {
    return this.words.size;
  }
}
