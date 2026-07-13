// The folder filter (SKR-245) — the funnel in the All header opens this
// menu to scope the list to a folder. Built on Radix DropdownMenu (the
// SortMenu primitive) for the anchored, dismissable popover; the folder
// rows are plain buttons (not menu items) so the live-search input can own
// keyboard focus without Radix's roving/typeahead fighting it.
//
// V1 is folders only. The Tags group is a marked seam: when tags land, a
// second group renders here from the frontmatter tag index, and the store's
// SidebarFilter union gains its `{ kind: 'tag' }` member.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { SidebarFilter } from '@skrive/shared';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { IconFilter } from '../icons/IconFilter';
import { IconFolder } from '../icons/IconFolder';
import { IconSearch } from '../icons/IconSearch';
import { IconCheck } from '../icons/IconCheck';
import type { FolderInfo } from './tree';

type Props = {
  folders: FolderInfo[];
  activeFilter: SidebarFilter | null;
  onSelect: (filter: SidebarFilter) => void;
  onClear: () => void;
};

export function FilterMenu({ folders, activeFilter, onSelect, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const active = activeFilter?.kind === 'folder';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.path.toLowerCase().includes(q));
  }, [folders, query]);

  // DropdownMenu focuses its content (no menu items to land on); move focus
  // to the search field once it's mounted so you can type immediately.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Tooltip label="Filter">
        <DropdownMenu.Trigger asChild>
          <IconButton
            size="sm"
            className={`icon-button${active ? ' active' : ''}`}
            aria-label="Filter documents"
          >
            <IconFilter size={16} />
          </IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="filter-menu" align="end" sideOffset={4}>
          <div className="filter-menu__search">
            <span className="filter-menu__search-icon">
              <IconSearch size={16} />
            </span>
            <input
              ref={inputRef}
              className="filter-menu__input"
              type="text"
              placeholder="Filter by folder…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="filter-menu__scroll">
            <div className="filter-menu__group-label">Folders</div>
            {filtered.length === 0 ? (
              <div className="filter-menu__empty">No folders</div>
            ) : (
              filtered.map((folder) => {
                const isActive = active && activeFilter.value === folder.path;
                return (
                  <button
                    key={folder.path}
                    type="button"
                    className={`filter-menu__item${isActive ? ' active' : ''}`}
                    title={folder.path}
                    onClick={() =>
                      isActive
                        ? onClear()
                        : onSelect({ kind: 'folder', value: folder.path })
                    }
                  >
                    <span className="filter-menu__item-icon">
                      <IconFolder size={16} />
                    </span>
                    <span className="filter-menu__item-name">{folder.name}</span>
                    {isActive ? (
                      <span className="filter-menu__check">
                        <IconCheck size={16} />
                      </span>
                    ) : (
                      <span className="filter-menu__item-count">
                        {folder.count}
                      </span>
                    )}
                  </button>
                );
              })
            )}
            {/* Tags group — deferred (SKR-245). When the Tags facet lands, a
                second labelled group renders here from the frontmatter tag
                index, selecting into a { kind: 'tag' } filter. */}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
