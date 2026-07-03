// The docId (ULID) generator (SKR-195, spec §3).

import { describe, expect, it } from 'vitest';
import { DOC_ID_RE, generateDocId, makeDocIdGenerator } from '../../src/lib/folio';

describe('generateDocId', () => {
  it('produces a 26-char lowercased Crockford base32 id', () => {
    const id = generateDocId();
    expect(id).toHaveLength(26);
    expect(DOC_ID_RE.test(id)).toBe(true);
  });

  it('is unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateDocId());
    expect(seen.size).toBe(1000);
  });
});

describe('makeDocIdGenerator (injectable for deterministic tests)', () => {
  it('is deterministic under a fixed clock and random source', () => {
    const clock = () => 1_720_000_000_000; // fixed ms
    const random = (n: number) => Array.from({ length: n }, () => 0);
    const gen = makeDocIdGenerator(clock, random);
    expect(gen()).toBe(gen());
    expect(gen()).toHaveLength(26);
    expect(DOC_ID_RE.test(gen())).toBe(true);
  });

  it('encodes the timestamp into the leading 10 chars, creation-time-sortable', () => {
    const random = (n: number) => Array.from({ length: n }, () => 0);
    const earlier = makeDocIdGenerator(() => 1_000, random)();
    const later = makeDocIdGenerator(() => 2_000, random)();
    // Same random tail (all zero); the time prefix orders them.
    expect(earlier < later).toBe(true);
    expect(earlier.slice(0, 10)).not.toBe(later.slice(0, 10));
    expect(earlier.slice(10)).toBe(later.slice(10));
  });

  it('maps the random draws through the Crockford alphabet', () => {
    // Draw 10 -> alphabet index 10 -> 'a' (0-9 then a...). All-10 tail.
    const gen = makeDocIdGenerator(() => 0, (n) => Array.from({ length: n }, () => 10));
    expect(gen().slice(10)).toBe('a'.repeat(16));
  });
});
