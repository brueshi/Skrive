// The Settings control kit — what remains settings-scoped after the SKR-212
// promotion. Segmented / Toggle / Stepper / Select moved to components/ui as
// app-wide primitives (re-exported from the kit barrel so settings imports
// read the same); this file keeps the controls whose shape is genuinely
// settings-specific: the theme tiles, plus the thin MonoInput wrapper over
// ui/Input. Each maps one pref to one control and is purely presentational:
// value + onChange, no store wiring.

import { useId } from 'react';
import { Input } from '../../ui/Input';

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

/** A small monospace text input for short token strings (date format).
 *  ui/Input under a settings-mono typography class. */
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
    <Input
      type="text"
      className="settings-mono-input"
      aria-label={ariaLabel}
      value={value}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
