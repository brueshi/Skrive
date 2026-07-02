// Direct coverage of the idempotence guard (markdown-core/idempotence.ts): the
// position-ignoring structural equality and the semantic-equality relation that
// lets edit-then-revert restore original bytes instead of baking in
// normalization. Previously only exercised transitively (SKR-193).

import { describe, it, expect } from 'vitest';
import { mdastEqual, semanticallyEqual } from '../../../src/lib/markdown-core/idempotence';

describe('mdastEqual', () => {
  it('ignores position while comparing structure', () => {
    const a = { type: 'text', value: 'x', position: { start: { line: 1 } } };
    const b = { type: 'text', value: 'x', position: { start: { line: 9 } } };
    expect(mdastEqual(a, b)).toBe(true);
  });

  it('is false when a non-position field differs', () => {
    expect(mdastEqual({ type: 'text', value: 'x' }, { type: 'text', value: 'y' })).toBe(false);
  });

  it('is false when one side carries an extra (non-position) key', () => {
    expect(mdastEqual({ type: 't' }, { type: 't', depth: 2 })).toBe(false);
  });

  it('compares arrays element-wise and rejects a length mismatch', () => {
    expect(mdastEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(mdastEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('distinguishes a scalar from an object', () => {
    expect(mdastEqual('x', { type: 'text', value: 'x' })).toBe(false);
  });
});

describe('semanticallyEqual', () => {
  it('treats a hard-wrapped paragraph and its flowed form as equal', () => {
    // The soft break flows to a space, so these parse to the same tree — the
    // relation that makes byte-faithful edit-then-revert possible.
    expect(semanticallyEqual('alpha beta', 'alpha\nbeta')).toBe(true);
  });

  it('treats *emphasis* and _emphasis_ as the same meaning', () => {
    expect(semanticallyEqual('*a*', '_a_')).toBe(true);
  });

  it('separates genuinely different content', () => {
    expect(semanticallyEqual('*a*', 'a')).toBe(false);
  });

  it('is stable across repeated calls (cache does not corrupt results)', () => {
    for (let i = 0; i < 5; i++) {
      expect(semanticallyEqual('x', 'x')).toBe(true);
      expect(semanticallyEqual('x', 'y')).toBe(false);
    }
  });
});
