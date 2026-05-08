// Shared modal shell for the command palette + file switcher.
//
// Both surfaces use the same outer chrome — Radix Dialog for focus
// trap + portal + ESC handling, and cmdk for the search-driven list.
// They differ only in what they render inside (group headers + command
// rows for the palette; flat file rows for the switcher).

import * as Dialog from '@radix-ui/react-dialog';
import { Command as Cmd } from 'cmdk';
import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Aria label on the dialog. The Cmdk input has its own placeholder. */
  ariaLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (next: string) => void;
  emptyState?: ReactNode;
  children: ReactNode;
  /** Optional cmdk filter override. Default disables cmdk's built-in
   *  filtering (so the parent can do its own — useful when the
   *  haystack is huge and we want a faster ranker). */
  filter?: (value: string, search: string, keywords?: string[]) => number;
};

export function CommandModal({
  open,
  onClose,
  ariaLabel,
  placeholder,
  query,
  onQueryChange,
  emptyState,
  children,
  filter
}: Props) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="cmdk-backdrop" />
        <Dialog.Content className="cmdk-palette" aria-label={ariaLabel}>
          <Dialog.Title className="visually-hidden">{ariaLabel}</Dialog.Title>
          <Cmd label={ariaLabel} shouldFilter={filter !== undefined ? false : true} filter={filter}>
            <Cmd.Input
              autoFocus
              value={query}
              onValueChange={onQueryChange}
              placeholder={placeholder}
              className="cmdk-input"
            />
            <Cmd.List className="cmdk-list">
              {emptyState !== undefined && (
                <Cmd.Empty className="cmdk-empty">{emptyState}</Cmd.Empty>
              )}
              {children}
            </Cmd.List>
          </Cmd>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
