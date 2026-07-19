// Word/line delete runs near inline atoms (SKR-56 follow-up). The scans run over
// inlineScanText (flat-offset-aligned, atoms as SCAN_ATOM cells) and the clamp
// stops a run at an atom rather than deleting it silently — an atom adjacent to
// the caret empties the run, signalling the caller to fall back to a plain char
// delete (which owns the atom gestures, the footnote arming beat included).

import { describe, it, expect } from 'vitest';
import { clampRunToAtoms } from '../../../src/lib/blocksurface/word-boundary';

const A = '￼'; // SCAN_ATOM

describe('clampRunToAtoms', () => {
  it('truncates a backward run at the atom nearest the caret', () => {
    // "foo ￼bar|": the run [0, 8) stops just after the atom cell at 4.
    expect(clampRunToAtoms(`foo ${A}bar`, 0, 8, 8, A, 'backward')).toEqual([5, 8]);
  });

  it('empties a backward run when the atom is adjacent to the caret', () => {
    // "foo￼|": [4, 4) — the caller falls back to a plain delete (arming beat).
    expect(clampRunToAtoms(`foo${A}`, 0, 4, 4, A, 'backward')).toEqual([4, 4]);
  });

  it('truncates a forward run at the first atom past the caret', () => {
    expect(clampRunToAtoms(`foo${A}bar`, 0, 7, 0, A, 'forward')).toEqual([0, 3]);
  });

  it('empties a forward run when the atom is adjacent to the caret', () => {
    expect(clampRunToAtoms(`${A}bar`, 0, 4, 0, A, 'forward')).toEqual([0, 0]);
  });

  it('leaves an atom-free run untouched', () => {
    expect(clampRunToAtoms('foo bar', 4, 7, 7, A, 'backward')).toEqual([4, 7]);
  });

  it('ignores atoms outside the run', () => {
    expect(clampRunToAtoms(`${A}foo bar`, 5, 8, 8, A, 'backward')).toEqual([5, 8]);
  });
});
