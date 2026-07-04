// The Settings control kit — what remains settings-scoped after the SKR-212
// promotion. Segmented / Toggle / Stepper / Select moved to components/ui as
// app-wide primitives (re-exported from the kit barrel so settings imports
// read the same); this file keeps the controls whose shape is genuinely
// settings-specific: the theme tiles and the frontmatter field chips, plus
// the thin MonoInput wrapper over ui/Input. Each maps one pref to one
// control and is purely presentational: value + onChange, no store wiring.

import { useId, useRef, useState } from 'react';
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
