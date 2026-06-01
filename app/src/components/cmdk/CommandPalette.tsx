// ⌘⇧P command palette. Shell wraps cmdk + Radix Dialog (see
// CommandModal). The haystack is the Phase 11 command registry,
// filtered to whatever's currently runnable via each command's
// `when` predicate.
//
// Empty query: groups headers in registry order. Typed query:
// cmdk's flat filter does the ranking — no custom fuzzy ranker
// needed (the v0.1.6 hand-rolled `rankItems` retired here).

import { Command as Cmd } from 'cmdk';
import { useEffect, useState } from 'react';
import { CommandModal } from './CommandModal';
import {
  buildCommands,
  COMMAND_GROUP_ORDER,
  type Command,
  type CommandDeps,
  type CommandGroup
} from '../../lib/commands/registry';
import { useProjectStore } from '../../stores/project';

type Props = {
  open: boolean;
  onClose: () => void;
  deps: CommandDeps;
};

export function CommandPalette({ open, onClose, deps }: Props) {
  // Re-render on any state change that could affect `when` predicates.
  // Subscribing to a coarse hash is enough — the list is small and the
  // rebuild is cheap.
  useProjectStore((s) =>
    [
      s.manifest === null ? '' : s.manifest.root,
      s.activeView,
      s.activeTabIndex,
      s.tabs.map((t) => `${t.path}:${t.dirty ? '1' : '0'}`).join('|')
    ].join('§')
  );

  const [query, setQuery] = useQueryState(open);

  // Don't memoize — `when` predicates read live state, and the list
  // is small enough that rebuilding per render is free.
  const available = buildCommands(deps).filter((c) =>
    c.when ? c.when() : true
  );

  const grouped: Record<CommandGroup, Command[]> = {
    File: [],
    Tabs: [],
    View: [],
    Insert: [],
    Project: [],
    Settings: [],
    Help: []
  };
  for (const cmd of available) grouped[cmd.group].push(cmd);

  function handleSelect(cmd: Command) {
    onClose();
    Promise.resolve(cmd.run()).catch((err) => {
      console.error(`[skrive command ${cmd.id}] failed`, err);
    });
  }

  return (
    <CommandModal
      open={open}
      onClose={onClose}
      ariaLabel="Command palette"
      placeholder="Type a command…"
      query={query}
      onQueryChange={setQuery}
      emptyState={<span>No matching commands.</span>}
    >
      {COMMAND_GROUP_ORDER.map((group) => {
        const items = grouped[group];
        if (items.length === 0) return null;
        return (
          <Cmd.Group key={group} heading={group} className="cmdk-group">
            {items.map((cmd) => (
              <Cmd.Item
                key={cmd.id}
                value={`${cmd.label} ${cmd.id}`}
                onSelect={() => handleSelect(cmd)}
                className="cmdk-item"
              >
                <span className="cmdk-item-label">{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="cmdk-item-shortcut">{cmd.shortcut}</span>
                )}
              </Cmd.Item>
            ))}
          </Cmd.Group>
        );
      })}
    </CommandModal>
  );
}

// Reset the query each time the palette closes so the next open
// starts blank. Resetting on close (rather than on open) avoids a
// flash of stale results during the open animation.
function useQueryState(open: boolean): [string, (next: string) => void] {
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  return [q, setQ];
}
