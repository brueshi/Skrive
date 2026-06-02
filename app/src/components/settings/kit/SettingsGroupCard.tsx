// Grouped-card primitives for the Settings panes.
//
// A pane is a stack of sections; each section is an optional uppercase
// cap label over one card. A card holds SettingRows separated by hairline
// dividers (the divider is drawn by the row's top border in CSS, so a
// card needs no internal separators of its own).

import { type ReactNode } from 'react';

/** An uppercase section cap over a single card (e.g. THEME, SAVING). */
export function SettingsSection({
  cap,
  children
}: {
  cap?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      {cap && <h3 className="settings-section-cap">{cap}</h3>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/** One row inside a card: label + description on the left, a control on
 *  the right. `dimmed` fades the row to ~0.4 for prefs that don't apply
 *  in the current context (e.g. Marker mode under the Rich surface); the
 *  row stays present so its place in the layout is stable. */
export function SettingRow({
  label,
  desc,
  control,
  dimmed = false
}: {
  label: string;
  desc?: string;
  control: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div className={`settings-row${dimmed ? ' is-dimmed' : ''}`}>
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {desc && <span className="settings-row-desc">{desc}</span>}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}
