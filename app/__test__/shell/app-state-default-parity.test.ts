// The Zig core embeds its own copy of the default AppUiState, because the shell
// owns load-with-defaults and there is no app-side seam for it to read. Two
// copies of one contract, and the comment on each said "keep these in lockstep"
// — which had already been missed twice by the time anyone checked (SKR-273):
//
//   - `showWordCount` / `wordCountMetric` were absent from the embedded copy.
//     Combined with a merge that iterated the DEFAULT's keys, that meant those
//     prefs were dropped on every load — hiding the badge could not be saved.
//   - `editorLineHeightX100` was 170 against the shared 150, and
//     `autosaveIdleDelayMs` was 0 against 500. A fresh install on the Zig shell
//     therefore got 1.7 line-height and an autosave debounce of 0ms — a write
//     on every edit instead of after a 500ms pause.
//
// The parity corpus could not have caught the second pair: `normalize()` in
// scripts/parity/corpus.ts zeroes every key ending in `Ms` (a rule aimed at
// volatile timestamps), so `autosaveIdleDelayMs` is invisible to it in both the
// expected and actual output. Hence this test rather than another fixture — it
// compares values, not just key sets, and nothing here is normalized away.
//
// Add a pref to DEFAULT_APP_UI_STATE and this fails until the Zig default has it
// too. That is the point.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_APP_UI_STATE } from '@skrive/shared';

const PERSISTENCE_ZIG = join(
  __dirname,
  '..',
  '..',
  '..',
  'shell-zig',
  'core',
  'src',
  'persistence.zig'
);

/** The embedded default, lifted out of its Zig multiline-string literal. The
 *  literal is one `\\{...}` line by construction (it is asserted byte-for-byte
 *  against the `loadAppState-default` fixture), so one line is all we read. */
function embeddedDefault(): Record<string, unknown> {
  const source = readFileSync(PERSISTENCE_ZIG, 'utf8');
  const marker = 'const DEFAULT_APP_STATE =';
  const start = source.indexOf(marker);
  expect(start, `${marker} not found — was the constant renamed?`).toBeGreaterThan(-1);

  const line = source
    .slice(start)
    .split('\n')
    .find((l) => l.trimStart().startsWith('\\\\'));
  expect(line, 'no multiline-string literal after the marker').toBeDefined();

  return JSON.parse(line!.trimStart().slice(2)) as Record<string, unknown>;
}

describe('the Zig core embedded app-state default', () => {
  it('mirrors DEFAULT_APP_UI_STATE exactly — same keys, same values', () => {
    expect(embeddedDefault()).toEqual(DEFAULT_APP_UI_STATE);
  });

  it('carries every key the shared default does, in the same order', () => {
    // Order matters beyond tidiness: the embedded literal is asserted
    // byte-for-byte against the loadAppState-default parity fixture, and the
    // merge emits keys in the default's order.
    expect(Object.keys(embeddedDefault())).toEqual(Object.keys(DEFAULT_APP_UI_STATE));
  });
});
