import styles from './Select.module.css';

// Dropdown (SKR-212, promoted from the settings kit) over a native <select>
// for keyboard + a11y, with the chrome hidden behind our chevron. `disabled`
// makes the control inert (not focusable, can't change) for prefs that don't
// apply in the current context — pair it with SettingRow's `dimmed` for the
// visual cue.

// `group` is optional: options without one render flat, exactly as before.
// When any option carries a group, the list renders under <optgroup>
// headings in first-appearance order — so the caller controls grouping by
// ordering its options, not by passing a separate structure.
type Option<T extends string> = { id: T; label: string; group?: string };

type OptionRun<T extends string> =
  | { kind: 'bare'; option: Option<T> }
  | { kind: 'group'; group: string; options: Option<T>[] };

/** Collapse a flat option list into runs. Ungrouped options render bare;
 *  consecutive options sharing a group collect under one heading. Order is
 *  preserved throughout, and a group name that recurs after a gap opens a
 *  second heading rather than reordering the list to merge them. */
function groupOptions<T extends string>(options: Option<T>[]): OptionRun<T>[] {
  const runs: OptionRun<T>[] = [];
  for (const opt of options) {
    if (opt.group === undefined) {
      runs.push({ kind: 'bare', option: opt });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === 'group' && last.group === opt.group) {
      last.options.push(opt);
    } else {
      runs.push({ kind: 'group', group: opt.group, options: [opt] });
    }
  }
  return runs;
}

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
        {groupOptions(options).map((run) =>
          run.kind === 'bare' ? (
            <option key={run.option.id} value={run.option.id}>
              {run.option.label}
            </option>
          ) : (
            <optgroup key={run.group} label={run.group}>
              {run.options.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          )
        )}
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
