import styles from './Select.module.css';

// Dropdown (SKR-212, promoted from the settings kit) over a native <select>
// for keyboard + a11y, with the chrome hidden behind our chevron. `disabled`
// makes the control inert (not focusable, can't change) for prefs that don't
// apply in the current context — pair it with SettingRow's `dimmed` for the
// visual cue.

type Option<T extends string> = { id: T; label: string };

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled = false
}: {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className={styles.root}>
      <select
        className={styles.native}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
      <svg
        className={styles.caret}
        width="11"
        height="11"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden
      >
        <path
          d="M3 4.5L6 7.5L9 4.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
