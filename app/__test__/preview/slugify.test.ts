// Invariants for heading slugs. These pin the two properties anchor
// navigation depends on: the transformation is stable (so an id matches
// the fragment a writer types) and repeated headings disambiguate the
// way GitHub does (so links to the second "Notes" don't land on the
// first).

import { describe, expect, it } from 'vitest';
import { SlugDeduper, slugify } from '../../src/lib/preview/slugify';

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Getting Started')).toBe('getting-started');
  });

  it('drops punctuation and trailing marks', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('trims surrounding whitespace before slugging', () => {
    expect(slugify('  Getting Started  ')).toBe('getting-started');
  });

  it('preserves underscores and existing hyphens', () => {
    expect(slugify('snake_case-name')).toBe('snake_case-name');
  });

  it('leaves a double hyphen where a removed symbol sat between spaces', () => {
    // "@0.1 Memory Runtime & the V8 Engine" is the curriculum heading
    // from the design mock; the `&` vanishes but its two spaces don't.
    expect(slugify('@0.1 Memory Runtime & the V8 Engine')).toBe(
      '01-memory-runtime--the-v8-engine'
    );
  });

  it('keeps non-Latin letters and digits', () => {
    expect(slugify('Café 北京 2024')).toBe('café-北京-2024');
  });

  it('returns an empty string for punctuation-only headings', () => {
    expect(slugify('!!!')).toBe('');
  });
});

describe('SlugDeduper', () => {
  it('appends an incrementing suffix to repeated slugs', () => {
    const d = new SlugDeduper();
    expect(d.next('Intro')).toBe('intro');
    expect(d.next('Intro')).toBe('intro-1');
    expect(d.next('Intro')).toBe('intro-2');
  });

  it('does not collide with a literal numbered heading', () => {
    // Two "Foo" headings claim "foo" and "foo-1"; a real "Foo 1"
    // heading must then take "foo-1-1" rather than silently reusing
    // "foo-1".
    const d = new SlugDeduper();
    expect(d.next('Foo')).toBe('foo');
    expect(d.next('Foo')).toBe('foo-1');
    expect(d.next('Foo 1')).toBe('foo-1-1');
  });

  it('scopes counts per deduper instance', () => {
    const a = new SlugDeduper();
    const b = new SlugDeduper();
    expect(a.next('Notes')).toBe('notes');
    expect(b.next('Notes')).toBe('notes');
  });
});
