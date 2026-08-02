// Confirmation for a document opened from outside every project Skrive knows
// about (Finder double-click on a file in, say, ~/Downloads).
//
// Why a prompt at all: Skrive opens FOLDERS, so honouring the open means
// adopting the file's containing folder as a project — reading everything in
// it and putting aside whatever was open. That is too much to do to someone
// who just double-clicked one file, so the folder is named and agreed to.
// A file already inside the open project, or inside one opened before, skips
// this entirely; see open-external-file.ts.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { Button } from '../ui/Button';

type Props = {
  open: boolean;
  /** Absolute folder that becomes the project. */
  root: string;
  /** Documents that open once it does. */
  fileCount: number;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Display form for a folder path: the leaf is what identifies it, but the
 *  parent is what disambiguates two folders with the same name. */
function folderName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || root;
}

export function OpenExternalFileModal({
  open,
  root,
  fileCount,
  onConfirm,
  onCancel
}: Props) {
  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      <Dialog.Title className="modal-title">
        Open {folderName(root)} as a project?
      </Dialog.Title>
      <Dialog.Description className="modal-desc">
        Skrive works on a folder at a time.{' '}
        {fileCount === 1
          ? 'Opening this document'
          : `Opening these ${fileCount} documents`}{' '}
        means opening <code>{root}</code> and everything in it, replacing the
        project you have open now.
      </Dialog.Description>

      <div className="modal-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onConfirm}>
          Open folder
        </Button>
      </div>
    </DialogShell>
  );
}
