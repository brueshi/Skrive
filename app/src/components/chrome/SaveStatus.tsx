// Save-status dot for the topbar trio (Stage 2). Saving is automatic
// (debounced autosave), so the state is simply the active tab's dirty flag:
// a filled accent dot when the document is saved (clean), a hollow ring
// while edits are still pending the next autosave. A single soft pulse
// plays on the dirty -> saved transition for quiet confirmation; the dot
// never moves, per the calm, stationary-chrome bias. Per-tab detail still
// lives on the tab dirty dot.

import { useEffect, useRef, useState } from 'react';
import { selectActiveTab, useProjectStore } from '../../stores/project';

export function SaveStatus() {
  const activeTab = useProjectStore(selectActiveTab);
  const dirty = activeTab?.dirty ?? false;
  const path = activeTab?.path ?? null;
  const [pulse, setPulse] = useState(false);
  const prev = useRef({ dirty, path });

  useEffect(() => {
    // Pulse only on a real dirty -> clean edge within the same document
    // (a save landing). Switching to an already-clean tab also flips
    // dirty true -> false, but the path changes, so it's filtered out.
    const samePath = prev.current.path === path;
    if (samePath && prev.current.dirty && !dirty) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 360);
      prev.current = { dirty, path };
      return () => clearTimeout(t);
    }
    prev.current = { dirty, path };
  }, [dirty, path]);

  if (!activeTab) return null;

  return (
    <span
      className={`save-dot${dirty ? ' dirty' : ' saved'}${
        pulse ? ' pulse' : ''
      }`}
      role="status"
      aria-label={dirty ? 'Saving' : 'Saved'}
      title={dirty ? 'Saving…' : 'Saved'}
    />
  );
}
