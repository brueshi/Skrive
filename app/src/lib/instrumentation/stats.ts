// Latency statistics — pure, DOM-free, unit-testable.
//
// The keystroke→paint gate (planning/editor-surface-build-plan.md, "The core
// gate") is measured, not vibed: every stage reports p50/p99 keystroke→glyph
// and proves *constant-time* behaviour (identical latency in block 1 vs block
// 10,000, plain vs anchor-bearing, idle vs mid-cold-path). These helpers turn a
// raw sample stream into that verdict. They take plain number arrays so they
// run identically in the browser sampler, the Playwright matrix, and Vitest.

/** Summary of a latency sample set. Times are milliseconds. */
export type LatencySummary = {
  /** Number of samples the summary was computed from. */
  count: number;
  min: number;
  /** Arithmetic mean. Reported for context; the gate reads the tails. */
  mean: number;
  p50: number;
  p90: number;
  /**
   * The 95th percentile. One rank looser than p99, so a single slow outlier
   * (a GC pause, a stray layout) can't dominate it the way it can p99 on a
   * modest sample count — the metric of choice for a *ratio* comparison,
   * where both sides need to be stable relative to each other, not just each
   * individually low-variance.
   */
  p95: number;
  p99: number;
  max: number;
};

/** A zero-sample summary. Distinct from "fast" — callers gate on `count`. */
export const EMPTY_SUMMARY: LatencySummary = {
  count: 0,
  min: 0,
  mean: 0,
  p50: 0,
  p90: 0,
  p95: 0,
  p99: 0,
  max: 0
};

/**
 * Percentile via linear interpolation between closest ranks (the "R-7" method,
 * NumPy's default). `p` is a fraction in [0, 1]. Returns NaN for an empty input
 * so a missing measurement never masquerades as a fast one; callers should gate
 * on sample count before trusting any percentile.
 *
 * Linear interpolation (not nearest-rank) so small sample sets — a 200-keystroke
 * matrix run — don't quantise p99 to whichever single sample happens to land on
 * the rank boundary.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  if (p <= 0) return Math.min(...samples);
  if (p >= 1) return Math.max(...samples);

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Collapse a sample stream into the gate's reporting shape. */
export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { ...EMPTY_SUMMARY };
  const sum = samples.reduce((acc, n) => acc + n, 0);
  return {
    count: samples.length,
    min: Math.min(...samples),
    mean: sum / samples.length,
    p50: percentile(samples, 0.5),
    p90: percentile(samples, 0.9),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples)
  };
}

/** The tail percentiles a ratio comparison can be keyed on. */
export type RatioMetric = 'p50' | 'p90' | 'p95' | 'p99';

/**
 * Constant-time verdict. The gate's real test is that latency does not grow with
 * document size or position, so we compare a candidate scenario's tail against a
 * baseline scenario's tail as a ratio. `ratio = candidate[metric] / baseline[metric]`;
 * 1.0 is identical, >1 means the candidate is slower. A scenario that scales
 * with the document (something document-sized leaked onto the hot path) shows up
 * here as a ratio that climbs with block count.
 *
 * `metric` defaults to p99 (the historical gate metric). Callers whose baseline
 * scenario has a low sample count — where p99 quantises to close to the single
 * slowest keystroke and swings run to run — should pass `'p95'` instead: one
 * rank looser, so an outlier on either side can't single-handedly move the
 * ratio across the tolerance line.
 *
 * Returns the ratio plus a `withinTolerance` flag against a multiplier (e.g.
 * 1.5 = "the 10k-block doc may be at most 50% slower than block 1"). Guards the
 * degenerate near-zero baseline: when both tails are below `floorMs` the
 * measurement is dominated by timer noise, not real cost, so the ratio is
 * reported as 1 and always within tolerance.
 */
export function constantTimeRatio(
  baseline: LatencySummary,
  candidate: LatencySummary,
  tolerance: number,
  floorMs = 1,
  metric: RatioMetric = 'p99'
): { ratio: number; withinTolerance: boolean } {
  if (baseline[metric] < floorMs && candidate[metric] < floorMs) {
    return { ratio: 1, withinTolerance: true };
  }
  // Avoid divide-by-zero when only the baseline is sub-floor: anchor the
  // denominator at the floor so the ratio stays finite and meaningful.
  const denom = Math.max(baseline[metric], floorMs);
  const ratio = candidate[metric] / denom;
  return { ratio, withinTolerance: ratio <= tolerance };
}
