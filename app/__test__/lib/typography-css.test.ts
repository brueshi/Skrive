// The measure resolver turns a ch-denominated preset into a px cap so
// every view (block editor, raw source, preview) shares one physical
// column regardless of its own font. These tests run without a DOM, so
// they exercise the half-em fallback path deterministically.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chWidthPx, resolveMeasureCss } from '../../src/lib/typography-css';

const STACK = 'Iowan Old Style, Palatino, serif';

describe('chWidthPx', () => {
  it('falls back to half an em without a canvas', () => {
    expect(chWidthPx(STACK, 17)).toBe(8.5);
    expect(chWidthPx(STACK, 20)).toBe(10);
  });
});

// A bundled face loads after first paint, so the first measurement of "0"
// comes from whatever fallback was resolvable at the time. If that stale
// number stayed cached the writing column would keep the fallback's width
// for the rest of the session — invisible, and wrong by however much the
// two faces differ.
//
// The module memoises both its cache and its measuring canvas, so each test
// loads a fresh copy rather than trying to reach around that state.
describe('invalidateChWidth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function freshModule(readWidth: () => number) {
    vi.resetModules();
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({
          set font(_v: string) {},
          measureText: () => ({ width: readWidth() })
        })
      })
    });
    return import('../../src/lib/typography-css');
  }

  it('lets a re-measure pick up the real face once it loads', async () => {
    let width = 6;
    const mod = await freshModule(() => width);

    // First paint: the fallback is what canvas can resolve.
    expect(mod.chWidthPx('async-face', 17)).toBe(6);
    // The real face arrives and is wider, but the cache still answers.
    width = 9;
    expect(mod.chWidthPx('async-face', 17)).toBe(6);

    mod.invalidateChWidth('async-face', 17);
    expect(mod.chWidthPx('async-face', 17)).toBe(9);
  });

  it('leaves other cached sizes alone', async () => {
    let width = 6;
    const mod = await freshModule(() => width);

    expect(mod.chWidthPx('async-face', 17)).toBe(6);
    expect(mod.chWidthPx('async-face', 22)).toBe(6);
    width = 9;

    mod.invalidateChWidth('async-face', 17);
    expect(mod.chWidthPx('async-face', 17)).toBe(9);
    expect(mod.chWidthPx('async-face', 22)).toBe(6);
  });

  it('resizes the writing column once the face is measured', async () => {
    let width = 6;
    const mod = await freshModule(() => width);

    expect(mod.resolveMeasureCss('normal', 'async-face', 17, 70)).toBe('420px');
    width = 9;
    mod.invalidateChWidth('async-face', 17);
    expect(mod.resolveMeasureCss('normal', 'async-face', 17, 70)).toBe('630px');
  });
});

describe('resolveMeasureCss', () => {
  it('caps the column at the preset ch count in px', () => {
    // 55ch / 70ch / 90ch at the 8.5px fallback ch.
    expect(resolveMeasureCss('narrow', STACK, 17, 70)).toBe('468px');
    expect(resolveMeasureCss('normal', STACK, 17, 70)).toBe('595px');
    expect(resolveMeasureCss('wide', STACK, 17, 70)).toBe('765px');
  });

  it('scales with the editor font size', () => {
    expect(resolveMeasureCss('normal', STACK, 20, 70)).toBe('700px');
  });

  it('lifts the cap entirely on full', () => {
    expect(resolveMeasureCss('full', STACK, 17, 70)).toBe('100%');
  });

  it('uses the custom ch value, clamped to the stepper range', () => {
    expect(resolveMeasureCss('custom', STACK, 17, 80)).toBe('680px');
    // 200 clamps to 120, 10 clamps to 40.
    expect(resolveMeasureCss('custom', STACK, 17, 200)).toBe('1020px');
    expect(resolveMeasureCss('custom', STACK, 17, 10)).toBe('340px');
  });
});
