// The measure resolver turns a ch-denominated preset into a px cap so
// every view (block editor, raw source, preview) shares one physical
// column regardless of its own font. These tests run without a DOM, so
// they exercise the half-em fallback path deterministically.

import { describe, expect, it } from 'vitest';
import { chWidthPx, resolveMeasureCss } from '../../src/lib/typography-css';

const STACK = 'Iowan Old Style, Palatino, serif';

describe('chWidthPx', () => {
  it('falls back to half an em without a canvas', () => {
    expect(chWidthPx(STACK, 17)).toBe(8.5);
    expect(chWidthPx(STACK, 20)).toBe(10);
  });
});

describe('resolveMeasureCss', () => {
  it('caps the column at the preset ch count in px', () => {
    // 55ch / 70ch / 90ch at the 8.5px fallback ch.
    expect(resolveMeasureCss('narrow', STACK, 17)).toBe('468px');
    expect(resolveMeasureCss('normal', STACK, 17)).toBe('595px');
    expect(resolveMeasureCss('wide', STACK, 17)).toBe('765px');
  });

  it('scales with the editor font size', () => {
    expect(resolveMeasureCss('normal', STACK, 20)).toBe('700px');
  });

  it('lifts the cap entirely on full', () => {
    expect(resolveMeasureCss('full', STACK, 17)).toBe('100%');
  });
});
