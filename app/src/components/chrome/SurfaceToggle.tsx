// Rich | Text surface toggle for the topbar trio (Stage 2). Flips the
// defaultSurface pref, which App.tsx reads to decide whether the active
// document renders in the Rich (ProseMirror) or Text (CodeMirror) surface
// — the same switch ⌘⇧E drives. Hidden when surface switching is locked
// off in Settings, so a writer who never wants to see syntax can't flip
// into it by accident.
//
// Text labels for now; the IconSurfaceRich / IconSurfaceText glyphs are
// tracked in the 1.0 build plan's deferred-icons list.

import { usePreferencesStore } from '../../stores/preferences';
import type { SurfaceId } from '@skrive/shared';

const OPTIONS: { id: SurfaceId; label: string; hint: string }[] = [
  { id: 'rich', label: 'Rich', hint: 'Rich surface  ⌘⇧E' },
  { id: 'text', label: 'Text', hint: 'Text surface  ⌘⇧E' }
];

export function SurfaceToggle() {
  const defaultSurface = usePreferencesStore((s) => s.defaultSurface);
  const setDefaultSurface = usePreferencesStore((s) => s.setDefaultSurface);
  const switchingEnabled = usePreferencesStore((s) => s.surfaceSwitchingEnabled);

  if (!switchingEnabled) return null;

  return (
    <div className="chip-segmented" role="radiogroup" aria-label="Editing surface">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="radio"
          aria-checked={defaultSurface === opt.id}
          className={`chip-segmented-option${
            defaultSurface === opt.id ? ' active' : ''
          }`}
          title={opt.hint}
          onClick={() => setDefaultSurface(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
