// Pure boundary math for the macOS delete chords (SKR-165). wordBoundaryRange
// backs Option+Backspace / Option-fn-Backspace; lineBoundaryRange backs
// Cmd+Backspace (and its forward mirror). These lock the semantics independent
// of the surface wiring — the surface just applies the returned [from, to) slice.

import { describe, it, expect } from 'vitest';
import { wordBoundaryRange, lineBoundaryRange } from '../../src/lib/blocksurface/word-boundary';

const back = (text: string, caret: number) => wordBoundaryRange(text, caret, 'backward');
const fwd = (text: string, caret: number) => wordBoundaryRange(text, caret, 'forward');

describe('wordBoundaryRange backward (Option+Backspace)', () => {
  it('mid-word deletes to the start of the current word', () => {
    // "hello wor|ld" -> remove "wor"
    expect(back('hello world', 9)).toEqual([6, 9]);
  });

  it('at a word start eats the preceding word and the space', () => {
    // caret at the start of "world" -> remove "hello "
    expect(back('hello world', 6)).toEqual([0, 6]);
  });

  it('at the end of a word eats that word, leaving the earlier space', () => {
    // "foo bar|" -> remove "bar"
    expect(back('foo bar', 7)).toEqual([4, 7]);
  });

  it('after trailing spaces eats the spaces and the word', () => {
    // "foo   |" -> remove "   " and "foo"? spec: back to previous word start,
    // whitespace between caret and that word goes with it -> remove all of it
    expect(back('foo   ', 6)).toEqual([0, 6]);
  });

  it('treats a run of only whitespace as one gesture', () => {
    expect(back('   ', 3)).toEqual([0, 3]);
  });

  it('stops at a punctuation + space boundary', () => {
    // "foo, bar|" -> remove "bar"; the comma and space are a boundary
    expect(back('foo, bar', 8)).toEqual([5, 8]);
  });

  it('at offset 0 collapses (signals a fall back to the boundary merge)', () => {
    expect(back('hello', 0)).toEqual([0, 0]);
  });
});

describe('wordBoundaryRange forward (Option-fn-Backspace)', () => {
  it('mid-word deletes to the end of the current word', () => {
    // "hel|lo world" -> remove "lo"
    expect(fwd('hello world', 3)).toEqual([3, 5]);
  });

  it('at the end of a word eats the following space and word', () => {
    // "hello| world" -> remove " world"
    expect(fwd('hello world', 5)).toEqual([5, 11]);
  });

  it('at the text end collapses', () => {
    expect(fwd('hello', 5)).toEqual([5, 5]);
  });
});

describe('lineBoundaryRange (Cmd+Backspace / forward mirror)', () => {
  it('prose backward deletes to the block start', () => {
    expect(lineBoundaryRange('hello world', 8, 'backward', false)).toEqual([0, 8]);
  });

  it('prose backward at offset 0 collapses (falls back to plain Backspace)', () => {
    expect(lineBoundaryRange('hello', 0, 'backward', false)).toEqual([0, 0]);
  });

  it('prose forward deletes to the block end', () => {
    expect(lineBoundaryRange('hello world', 5, 'forward', false)).toEqual([5, 11]);
  });

  it('code backward deletes to the start of the current line', () => {
    // "one\ntw|o" caret at 6 -> remove "tw", stop after the newline
    expect(lineBoundaryRange('one\ntwo', 6, 'backward', true)).toEqual([4, 6]);
  });

  it('code backward at a line start collapses (falls back to plain Backspace)', () => {
    // caret right after the newline
    expect(lineBoundaryRange('one\ntwo', 4, 'backward', true)).toEqual([4, 4]);
  });

  it('code forward deletes to the end of the current line', () => {
    expect(lineBoundaryRange('one\ntwo', 1, 'forward', true)).toEqual([1, 3]);
  });

  it('code forward on the last line deletes to the text end', () => {
    expect(lineBoundaryRange('one\ntwo', 5, 'forward', true)).toEqual([5, 7]);
  });
});
