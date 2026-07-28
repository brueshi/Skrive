// The seam between the checker pipeline and whatever can actually judge a word.
//
// Everything above this file — dirty tracking, debouncing, masking, dictionary
// layering, decoration painting, the correction menu — is Skrive's and is tested
// against a fake provider. Everything below it is the host's. The seam exists
// because the oracle is genuinely platform-specific: macOS answers from
// NSSpellChecker, a host without a checker answers nothing at all, and neither
// case should be visible to the pipeline.

import type { SpellCheckRequest, SpellCheckResult } from '@skrive/shared';

export interface SpellProvider {
  /** Check a batch of blocks. Rejections are the caller's to absorb. */
  check(requests: SpellCheckRequest[]): Promise<SpellCheckResult[]>;
  /** Correction candidates for one word, best first. */
  suggest(word: string): Promise<string[]>;
  /** Suppress a word for this session. */
  ignore(word: string): Promise<void>;
}

/** Resolve the host's provider, or null when this host has no checker (a plain
 *  browser, the latency harness, Windows until its checker lands). Callers treat
 *  null as "spellcheck is not available here" and stay off — never as an error.
 *
 *  Probed once and memoized: the answer cannot change within a run, and every
 *  editor that mounts would otherwise re-ask. */
let probe: Promise<SpellProvider | null> | null = null;

export function hostSpellProvider(): Promise<SpellProvider | null> {
  probe ??= (async () => {
    const spell = globalThis.window?.skrive?.spell;
    if (!spell) return null;
    try {
      if (!(await spell.available())) return null;
    } catch {
      return null;
    }
    return {
      check: (requests) => spell.check(requests),
      suggest: (word) => spell.suggest(word),
      ignore: (word) => spell.ignore(word)
    };
  })();
  return probe;
}

/** Test seam: forget the memoized probe. */
export function resetHostSpellProbe(): void {
  probe = null;
}
