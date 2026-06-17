// The Settings control kit — the small, reusable input primitives the
// 1.0 Settings panes are built from. Each maps one pref to one control
// and is purely presentational: it takes a value + onChange, owns no
// store wiring, and styles itself entirely through the .settings-* /
// control classes in index.css (Overcast tokens, no inline color).
//
// Visual spec traced from the paper.design "Skrive v2.0 — Settings"
// mock: segmented sunken track with a raised active pill, 40x23 toggle
// on the slate-indigo accent, bordered stepper with a centered value
// cell, native select under a custom chevron, and mono field chips.

import { useId, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

type Option<T extends string> = { id: T; label: string };

/** Segmented control — a sunken track of mutually exclusive options with
 *  one raised active pill. For 2-3 short choices (surface, line measure).
 *  The pill is a single shared element (layoutId) that slides between
 *  segments on switch rather than cross-fading per option. */
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
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`seg-option${active ? ' active' : ''}`}
            onClick={() => onChange(opt.id)}
          >
            {active && (
              <motion.span
                layoutId={thumbId}
                className="seg-thumb"
                aria-hidden
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 520, damping: 38 }
                }
              />
            )}
            <span className="seg-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** On/off switch. The knob slides to the accent-filled right on. */
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
      className={`tgl${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="tgl-knob" />
    </button>
  );
}

/** Numeric stepper — minus / value / plus. `format` renders the value
 *  with its unit; bounds disable the relevant button at the edges.
 *
 *  Two modes: a uniform range (min/max/step) for continuous values like
 *  the autosave delay, or a discrete `values` list for non-uniform preset
 *  scales (font size, line height) where stepping moves by list index. */
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
    <div className="stepper" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className="stepper-btn"
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
      <span className="stepper-value">{format(value)}</span>
      <button
        type="button"
        className="stepper-btn"
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

/** Dropdown over a native <select> for keyboard + a11y, with the chrome
 *  hidden behind our chevron. Used for the multi-option prefs. `disabled`
 *  makes the control inert (not focusable, can't change) for prefs that
 *  don't apply in the current context — pair it with SettingRow's
 *  `dimmed` for the visual cue. */
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
    <div className="sel">
      <select
        className="sel-native"
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
        className="sel-caret"
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

/** The three color-theme tiles, each a miniature page preview over a
 *  radio. Light / Dark render a static preview; System splits the two. */
type ThemeTileId = 'system' | 'light' | 'dark';

export function ThemeTiles({
  value,
  onChange
}: {
  value: ThemeTileId;
  onChange: (value: ThemeTileId) => void;
}) {
  const name = useId();
  const tiles: { id: ThemeTileId; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' }
  ];
  return (
    <div className="theme-tiles" role="radiogroup" aria-label="Color theme">
      {tiles.map((t) => (
        <label
          key={t.id}
          className={`theme-tile${value === t.id ? ' active' : ''}`}
        >
          <span className={`theme-preview theme-preview--${t.id}`} aria-hidden>
            <span className="theme-preview-line" />
            <span className="theme-preview-line" />
            <span className="theme-preview-line" />
          </span>
          <span className="theme-tile-foot">
            <input
              type="radio"
              name={name}
              checked={value === t.id}
              onChange={() => onChange(t.id)}
            />
            <span className="theme-tile-label">{t.label}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Editable list of frontmatter field names, rendered as mono chips with
 *  a dashed "+ field" affordance that reveals an inline input. */
export function FieldChips({
  fields,
  onChange
}: {
  fields: string[];
  onChange: (fields: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const name = draft.trim();
    if (name && !fields.includes(name)) onChange([...fields, name]);
    setDraft('');
    setAdding(false);
  }

  return (
    <div className="chips">
      {fields.map((f) => (
        <span key={f} className="chip">
          <span className="chip-text">{f}</span>
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove ${f}`}
            onClick={() => onChange(fields.filter((x) => x !== f))}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
              <path
                d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          className="chip-input"
          autoFocus
          value={draft}
          placeholder="field"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          className="chip-add"
          onClick={() => setAdding(true)}
        >
          + field
        </button>
      )}
    </div>
  );
}

/** A small monospace text input for short token strings (date format). */
export function MonoInput({
  value,
  onChange,
  ariaLabel,
  width
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  width?: number;
}) {
  return (
    <input
      type="text"
      className="settings-mono-input"
      aria-label={ariaLabel}
      value={value}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
