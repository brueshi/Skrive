// Sort control for the "All" tree. Currently offers Name + Recently
// modified; Recently created joins once the native scanner supplies a
// birthtime. Persists via the store's setSortKey.

import type { SidebarSortKey } from '@skrive/shared';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { IconSort } from '../icons/IconSort';

export const SORT_LABELS: Record<SidebarSortKey, string> = {
  name: 'Name',
  modified: 'Recently modified',
  created: 'Recently created'
};

export function SortMenu({
  sortKey,
  onChange
}: {
  sortKey: SidebarSortKey;
  onChange: (key: SidebarSortKey) => void;
}) {
  const options: SidebarSortKey[] = ['name', 'modified'];
  return (
    <DropdownMenu.Root>
      <Tooltip label={`Sort: ${SORT_LABELS[sortKey]}`}>
        <DropdownMenu.Trigger asChild>
          <IconButton size="sm" className="icon-button" aria-label="Sort files">
            <IconSort size={16} />
          </IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ctx-menu" align="end" sideOffset={4}>
          {options.map((key) => (
            <DropdownMenu.Item
              key={key}
              className="ctx-item"
              onSelect={() => onChange(key)}
            >
              <span className="ctx-label">{SORT_LABELS[key]}</span>
              {sortKey === key && <span className="ctx-shortcut">✓</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
