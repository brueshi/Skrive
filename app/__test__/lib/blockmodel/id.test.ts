// The block-stable id generator (SKR-94). Ids are identity handles, so the gate
// is format + uniqueness + a deterministic mode for reproducible tests.

import { describe, it, expect } from 'vitest';
import { BLOCK_ID_RE, generateBlockId, makeIdGenerator, type RandomSource } from '../../../src/lib/blockmodel/id';

describe('generateBlockId', () => {
  it('produces 10-char lowercase-alphanumeric ids', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateBlockId();
      expect(id).toHaveLength(10);
      expect(BLOCK_ID_RE.test(id)).toBe(true);
    }
  });

  it('does not collide across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateBlockId());
    expect(seen.size).toBe(10_000);
  });
});

describe('makeIdGenerator', () => {
  // A deterministic counter source: the i-th draw of each call increments.
  function counterSource(): RandomSource {
    let n = 0;
    return (length) => Array.from({ length }, () => n++);
  }

  it('is deterministic for a given random source', () => {
    const a = makeIdGenerator(counterSource());
    const b = makeIdGenerator(counterSource());
    const first = Array.from({ length: 5 }, () => a());
    const second = Array.from({ length: 5 }, () => b());
    expect(first).toEqual(second);
  });

  it('still yields well-formed ids from arbitrary (including negative) draws', () => {
    const gen = makeIdGenerator((length) => Array.from({ length }, (_, i) => (i % 2 ? -i : i)));
    const id = gen();
    expect(BLOCK_ID_RE.test(id)).toBe(true);
    expect(id).toHaveLength(10);
  });
});
