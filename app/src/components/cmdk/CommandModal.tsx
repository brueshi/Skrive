// Shared modal shell for the command palette + file switcher.
//
// Both surfaces use the same outer chrome — Radix Dialog for focus
// trap + portal + ESC handling, and cmdk for the search-driven list.
// They differ only in what they render inside (group headers + command
// rows for the palette; document rows for the switcher).

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { Command as Cmd } from 'cmdk';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { chordMatches, type Chord } from '../../lib/commands/registry';

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
  /** While open, this chord steps the highlight down one row (wrapping)
   *  instead of reaching the window bindings — the quick-open convention:
   *  the gesture that summoned the surface keeps walking it. Escape /
   *  Enter / click-away close. */
  cycleChord?: Chord;
  /** Forwarded to the Radix Dialog content — lets a surface own where
   *  focus lands when the modal closes (e.g. back into the editor). */
  onCloseAutoFocus?: (event: Event) => void;
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
  filter,
  cycleChord,
  onCloseAutoFocus
}: Props) {
  // Re-enter cmdk's own list navigation: the chord becomes an ArrowDown
  // on the input, so stepping shares cmdk's selection/scroll logic (and
  // its `loop` wrap) instead of duplicating it. preventDefault also keeps
  // the chord from falling through to the window dispatcher.
  function handleCycleKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!cycleChord || e.defaultPrevented) return;
    if (!chordMatches(e.nativeEvent, cycleChord)) return;
    e.preventDefault();
    const input = e.currentTarget.querySelector('[cmdk-input]');
    input?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        bubbles: true
      })
    );
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      variant="palette"
      className="cmdk-palette"
      aria-label={ariaLabel}
      onCloseAutoFocus={onCloseAutoFocus}
    >
          <Dialog.Title className="visually-hidden">{ariaLabel}</Dialog.Title>
          <Cmd
            label={ariaLabel}
            loop
            shouldFilter={filter !== undefined ? false : true}
            filter={filter}
            onKeyDown={handleCycleKey}
          >
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
    </DialogShell>
  );
}
