import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from './variants';
import styles from './Segmented.module.css';

// Segmented control (SKR-212, promoted from the settings kit): a sunken
// track of mutually exclusive options with one raised active pill. For 2-3
// short choices. The pill is a single shared element (layoutId) that slides
// between segments on switch rather than cross-fading per option.

type Option<T extends string> = { id: T; label: string };

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel
}: {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  ariaLabel: string;
}) {
  // Unique per instance so multiple segmented controls on a pane don't
  // share one thumb and animate into each other.
  const thumbId = useId();
  const reduced = useReducedMotion();
  return (
    <div className={styles.root} role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn(styles.option, active && styles.active)}
            onClick={() => onChange(opt.id)}
          >
            {active && (
              <motion.span
                layoutId={thumbId}
                className={styles.thumb}
                aria-hidden
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 520, damping: 38 }
                }
              />
            )}
            <span className={styles.label}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
