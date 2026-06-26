// Unit gate for the latency statistics. These are the numbers every editor
// stage is judged on, so the percentile maths and the constant-time verdict get
// their own deterministic coverage — independent of any browser or sampler.

import { describe, it, expect } from 'vitest';
import {
  EMPTY_SUMMARY,
  constantTimeRatio,
  percentile,
  summarize
} from '../../../src/lib/instrumentation/stats';

describe('percentile', () => {
  it('returns NaN for an empty set so a miss never reads as fast', () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('returns the single value regardless of p', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.99)).toBe(7);
  });

  it('matches the NumPy R-7 linear-interpolation reference', () => {
    // np.percentile([1..10], q) for q = 50, 90, 99.
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.5)).toBeCloseTo(5.5, 10);
    expect(percentile(xs, 0.9)).toBeCloseTo(9.1, 10);
    expect(percentile(xs, 0.99)).toBeCloseTo(9.91, 10);
  });

  it('is order-independent (sorts a copy, does not mutate input)', () => {
    const xs = [10, 1, 5, 3, 8];
    const snapshot = [...xs];
    expect(percentile(xs, 0.5)).toBe(5);
    expect(xs).toEqual(snapshot);
  });

  it('clamps p<=0 to min and p>=1 to max', () => {
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 1)).toBe(3);
  });
});

describe('summarize', () => {
  it('reports the empty summary for no samples', () => {
    expect(summarize([])).toEqual(EMPTY_SUMMARY);
  });

  it('computes count, min, mean, and the tails', () => {
    const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.count).toBe(10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBeCloseTo(5.5, 10);
    expect(s.p50).toBeCloseTo(5.5, 10);
    expect(s.p99).toBeCloseTo(9.91, 10);
  });
});

describe('constantTimeRatio', () => {
  const fast = summarize([2, 2.1, 2.2, 2.05, 2.15]);

  it('passes when the candidate tail matches the baseline', () => {
    const v = constantTimeRatio(fast, fast, 1.5);
    expect(v.ratio).toBeCloseTo(1, 6);
    expect(v.withinTolerance).toBe(true);
  });

  it('fails when the candidate tail scales past tolerance', () => {
    const slow = summarize([8, 8.2, 8.4, 8.1, 8.3]);
    const v = constantTimeRatio(fast, slow, 1.5);
    expect(v.ratio).toBeGreaterThan(1.5);
    expect(v.withinTolerance).toBe(false);
  });

  it('treats sub-floor tails as timer noise, not a regression', () => {
    const a = summarize([0.1, 0.2, 0.15]);
    const b = summarize([0.3, 0.4, 0.35]); // 2x of a, but both below the floor
    const v = constantTimeRatio(a, b, 1.2, 1);
    expect(v.ratio).toBe(1);
    expect(v.withinTolerance).toBe(true);
  });

  it('anchors the denominator at the floor when only the baseline is sub-floor', () => {
    const a = summarize([0.5, 0.5, 0.5]); // p99 < 1ms floor
    const b = summarize([3, 3, 3]); // real cost
    const v = constantTimeRatio(a, b, 1.5, 1);
    expect(v.ratio).toBeCloseTo(3, 6); // 3 / floor(1), not 3 / 0.5
    expect(v.withinTolerance).toBe(false);
  });
});
