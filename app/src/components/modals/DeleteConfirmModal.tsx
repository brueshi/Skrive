// Delete confirmation modal for the sidebar.
//
// Built on the DialogShell sheet (Radix Dialog inside), so focus trap, ESC
// handling, scroll lock, and portal placement come out of the box. The
// "Don't ask again" checkbox flips `AppUiState.skipDeleteConfirmation` on
// confirm; subsequent deletes go straight to trash (the Sidebar's
// `requestDelete*` helpers short-circuit when the pref is set).

import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { usePreferencesStore } from '../../stores/preferences';
import { DialogShell } from '../ui/Dialog';
import { Button } from '../ui/Button';

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
  const setSkipDeleteConfirmation = usePreferencesStore(
    (s) => s.setSkipDeleteConfirmation
  );

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      if (dontAskAgain) setSkipDeleteConfirmation(true);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
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
        <Button
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          tone="danger"
          onClick={() => void handleConfirm()}
          disabled={busy}
        >
          {busy ? 'Moving…' : 'Move to trash'}
        </Button>
      </div>
    </DialogShell>
  );
}
