// COMPAT (SKR-243 Stage 1): the tab strip rendered over the working-set
// model while the front-title + fan land. Pills are the working set in LRU
// order — entry 0 (the live doc) is the active pill, clicking switches,
// the close X drops the entry. Deleted at the end of the stage along with
// the header-tabs slot and the tabs.* commands.

import { useProjectStore } from '../../stores/project';
import { noDragProps } from './windowDrag';
import { DocIcon } from '../icons/DocIcon';
import { IconDotUnsaved } from '../icons/IconDotUnsaved';
import { IconX } from '../icons/IconX';
import { stripFolioExtension } from '../../lib/title';

function leafName(p: string): string {
  const lastSep = p.lastIndexOf('/');
  const base = lastSep === -1 ? p : p.slice(lastSep + 1);
  // Hide the `.folio` extension in the tab, matching the sidebar — the native
  // format is not surfaced. Markdown keeps its extension.
  return stripFolioExtension(base);
}

export function TabBar() {
  const workingSet = useProjectStore((s) => s.workingSet);
  const liveDoc = useProjectStore((s) => s.liveDoc);
  const openDoc = useProjectStore((s) => s.openDoc);
  const dropFromWorkingSet = useProjectStore((s) => s.dropFromWorkingSet);

  if (workingSet.length === 0) return null;

  return (
    <div className="tabs" role="tablist">
      {workingSet.map((entry) => {
        const active = entry.path === liveDoc?.path;
        return (
          <TabPill
            key={entry.path}
            path={entry.path}
            active={active}
            dirty={active && (liveDoc?.dirty ?? false)}
            onSelect={() => void openDoc(entry.path)}
            onClose={(e) => {
              e.stopPropagation();
              void dropFromWorkingSet(entry.path);
            }}
          />
        );
      })}
    </div>
  );
}

type TabPillProps = {
  path: string;
  active: boolean;
  dirty: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
};

// The TAB opts out of window dragging, not the strip that holds it. The strip is
// `flex: 1` and marking IT no-drag swallowed the entire topbar's drag lane (SKR-240).
function TabPill({ path, active, dirty, onSelect, onClose }: TabPillProps) {
  return (
    <button
      type="button"
      role="tab"
      className={`tab${active ? ' active' : ''}`}
      aria-selected={active}
      onClick={onSelect}
      title={path}
      {...noDragProps}
    >
      <span className="tab-icon" aria-hidden="true">
        <DocIcon path={path} size={16} />
      </span>
      <span className="tab-name">{leafName(path)}</span>
      {dirty && (
        <span className="tab-dirty" aria-label="unsaved changes">
          <IconDotUnsaved size={16} />
        </span>
      )}
      {/* Close affordance is a non-interactive span — see Header.tsx
          comment for rationale. Mouse close still works via click
          bubbling; keyboard users close via ⌘W. */}
      <span className="tab-close" aria-hidden="true" onClick={onClose}>
        <IconX size={16} />
      </span>
    </button>
  );
}
