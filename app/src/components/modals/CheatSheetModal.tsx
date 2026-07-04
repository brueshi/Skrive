// Keyboard-shortcuts cheat sheet (⌘/). Phase 13a.
//
// The migration plan calls this out explicitly: "what does ⌘⇧B do
// again?" should be answerable without digging in docs. This modal
// renders straight from the registry's binding table — same source of
// truth the dispatcher reads — so the displayed shortcut and the
// actually-bound key can never disagree.
//
// Toggle behavior is owned by App.tsx (so pressing ⌘/ again closes
// the modal). Radix Dialog handles focus trap + Escape dismissal.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import {
  COMMAND_GROUP_ORDER,
  type Binding,
  type CommandGroup
} from '../../lib/commands/registry';
import { platformShortcut } from '../../lib/commands/shortcut-display';

type Props = {
  open: boolean;
  onClose: () => void;
  bindings: readonly Binding[];
};

export function CheatSheetModal({ open, onClose, bindings }: Props) {
  // Group bindings by command group, preserving registry order within
  // each group. Surface bindings (Diff nav, panel Escape, etc.) drop
  // into the same groups they semantically belong to.
  const grouped = new Map<CommandGroup, Binding[]>();
  for (const g of COMMAND_GROUP_ORDER) grouped.set(g, []);
  for (const b of bindings) grouped.get(b.group)?.push(b);

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      className="cheatsheet-modal"
      aria-label="Keyboard shortcuts"
    >
          <Dialog.Title className="modal-title">
            Keyboard shortcuts
          </Dialog.Title>
          <Dialog.Description className="visually-hidden">
            Every keyboard shortcut available in Skrive, grouped by area.
          </Dialog.Description>

          <div className="cheatsheet-body">
            {COMMAND_GROUP_ORDER.map((group) => {
              const items = grouped.get(group) ?? [];
              if (items.length === 0) return null;
              return (
                <section key={group} className="cheatsheet-group">
                  <h3 className="cheatsheet-group-heading">{group}</h3>
                  <ul className="cheatsheet-list">
                    {items.map((b, i) => (
                      <li
                        key={`${b.commandId ?? b.label}-${i}`}
                        className="cheatsheet-row"
                      >
                        <span className="cheatsheet-label">{b.label}</span>
                        <kbd className="cheatsheet-chord">
                          {platformShortcut(b.display)}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          <p className="cheatsheet-foot">
            Press <kbd>Esc</kbd> to close, or{' '}
            <kbd>{platformShortcut('⌘/')}</kbd> to toggle.
          </p>
    </DialogShell>
  );
}
