// Ephemeral save confirmation for the editor bar's left gutter. Autosave is
// automatic (debounced), so rather than a persistent status indicator this just
// flashes a quiet "Saved" when an autosave lands (the active tab's dirty flag
// flipping true -> false within the same document), then fades away. Nothing
// shows in the steady state or while edits are still pending — calm by default,
// reassurance exactly at the moment a save completes.

import { useEffect, useRef, useState } from 'react';
import { selectActiveTab, useProjectStore } from '../../stores/project';
import { IconCheck } from '../icons/IconCheck';

const SAVED_VISIBLE_MS = 1600;

export function SaveStatus() {
  const activeTab = useProjectStore(selectActiveTab);
  const dirty = activeTab?.dirty ?? false;
  const path = activeTab?.path ?? null;
  const [visible, setVisible] = useState(false);
  const prev = useRef({ dirty, path });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const samePath = prev.current.path === path;
    // A save landed: dirty -> clean within the same document. Switching to an
    // already-clean tab also flips dirty, but the path changes, so it's filtered.
    if (samePath && prev.current.dirty && !dirty) {
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), SAVED_VISIBLE_MS);
    } else if (!samePath) {
      setVisible(false);
    }
    prev.current = { dirty, path };
  }, [dirty, path]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!activeTab) return null;

  // Always rendered (text persists so the fade-out reads cleanly); only the
  // opacity class toggles. aria-live announces the confirmation when it appears.
  return (
    <span
      className={`save-status${visible ? ' is-visible' : ''}`}
      role="status"
      aria-live="polite"
    >
      <IconCheck size={16} className="save-status-icon" />
      Saved
    </span>
  );
}
