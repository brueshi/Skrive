// Phase-12b perf instrumentation. Off by default; opt in by running
// the dev server with the env var set:
//
//   VITE_SKRIVE_PERF=1 bun start
//
// Output is greppable in the dev console — every line is prefixed
// `[skrive-perf]` and ends with the elapsed milliseconds. The user-
// facing measurement protocol lives in planning/polish-track-plan.md
// (see "Performance budgets").
//
// The helpers do nothing when the flag is off, so it's safe to leave
// the call sites in place permanently.

const PERF_ENABLED =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_SKRIVE_PERF === '1';

/** Returns `performance.now()` only when perf is enabled — otherwise 0,
 *  so `now()` is a no-op cheap enough to leave on hot paths. */
export function now(): number {
  return PERF_ENABLED ? performance.now() : 0;
}

/** Logs a labelled duration to the console. Silent when perf is off. */
export function logDuration(label: string, startMs: number): void {
  if (!PERF_ENABLED) return;
  const elapsed = performance.now() - startMs;
  // eslint-disable-next-line no-console
  console.log(`[skrive-perf] ${label}: ${elapsed.toFixed(1)}ms`);
}

/** Wraps an async function with perf timing. Returns the original
 *  result; on failure, the duration line is suffixed with `(failed)`
 *  so a noisy stack doesn't hide the timing line in the log. */
export async function timeAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!PERF_ENABLED) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    logDuration(label, start);
    return result;
  } catch (err) {
    logDuration(`${label} (failed)`, start);
    throw err;
  }
}

/** True when perf logging is on — useful for guarding setup work
 *  (e.g. registering a one-shot mark in main.tsx) we don't want to
 *  pay for in normal dev. */
export const perfEnabled = PERF_ENABLED;
