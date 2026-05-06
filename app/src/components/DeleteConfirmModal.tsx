// Delete confirmation modal for the sidebar.
//
// Built on Radix Dialog so focus trap, ESC handling, scroll lock, and
// portal placement come out of the box. The "Don't ask again" preference
// (per A3 schema) lands when settings ship in Phase 9; for now the
// checkbox is decorative — the modal always shows. Phase 9 wires it
// through to AppUiState.skipDeleteConfirmation.

import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

type Props = {
  open: boolean;
  name: string;
  isDirectory?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
};

export function DeleteConfirmModal({
  open,
  name,
  isDirectory = false,
  onConfirm,
  onClose
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // TODO Phase 9: persist `dontAskAgain` into AppUiState.skipDeleteConfirmation.
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal-dialog"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              void handleConfirm();
            }
          }}
        >
          <Dialog.Title className="modal-title">
            Move {isDirectory ? 'folder' : 'file'} to trash?
          </Dialog.Title>
          <Dialog.Description className="modal-desc">
            <code>{name}</code>
            {isDirectory
              ? ' and everything inside it will be moved to the system trash. You can restore it from there.'
              : ' will be moved to the system trash. You can restore it from there.'}
          </Dialog.Description>

          {error && <p className="modal-error">{error}</p>}

          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              disabled={busy}
            />
            <span>Don&apos;t ask again</span>
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="modal-button secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-button primary destructive"
              onClick={() => void handleConfirm()}
              disabled={busy}
            >
              {busy ? 'Moving…' : 'Move to trash'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
