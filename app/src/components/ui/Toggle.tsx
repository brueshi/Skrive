import { cn } from './variants';
import styles from './Toggle.module.css';

// On/off switch (SKR-212, promoted from the settings kit). The knob slides
// to the accent-filled right on.

export function Toggle({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={cn(styles.toggle, checked && styles.on)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  );
}
