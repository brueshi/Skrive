import styles from './Stepper.module.css';

// Numeric stepper (SKR-212, promoted from the settings kit) — minus /
// value / plus. `format` renders the value with its unit; bounds disable
// the relevant button at the edges.
//
// Two modes: a uniform range (min/max/step) for continuous values like the
// autosave delay, or a discrete `values` list for non-uniform preset scales
// (font size, line height) where stepping moves by list index.

export function Stepper({
  value,
  onChange,
  min,
  max,
  step,
  values,
  format,
  ariaLabel
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  values?: readonly number[];
  format: (value: number) => string;
  ariaLabel: string;
}) {
  let prev: number | null;
  let next: number | null;
  if (values && values.length > 0) {
    // Nearest index to the current value, then walk the list.
    let i = values.indexOf(value);
    if (i === -1) {
      i = values.reduce(
        (best, v, idx) =>
          Math.abs(v - value) < Math.abs((values[best] ?? value) - value)
            ? idx
            : best,
        0
      );
    }
    prev = i > 0 ? values[i - 1] ?? null : null;
    next = i < values.length - 1 ? values[i + 1] ?? null : null;
  } else {
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    const by = step ?? 1;
    prev = value > lo ? Math.max(lo, value - by) : null;
    next = value < hi ? Math.min(hi, value + by) : null;
  }
  const atMin = prev === null;
  const atMax = next === null;
  return (
    <div className={styles.stepper} role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={styles.button}
        aria-label="Decrease"
        disabled={atMin}
        onClick={() => prev !== null && onChange(prev)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <line
            x1="2.5"
            y1="6"
            x2="9.5"
            y2="6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span className={styles.value}>{format(value)}</span>
      <button
        type="button"
        className={styles.button}
        aria-label="Increase"
        disabled={atMax}
        onClick={() => next !== null && onChange(next)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
          <line x1="6" y1="2.5" x2="6" y2="9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="2.5" y1="6" x2="9.5" y2="6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
