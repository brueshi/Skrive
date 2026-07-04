// Create-new-project modal. Same shell as the rename + delete modals
// (Radix Dialog → focus trap, ESC, scroll lock).
//
// User picks a parent directory via the system folder picker, types a
// name, optionally toggles git-init, and Skrive creates the directory
// + a starter README.md, runs `git init` if requested, and opens the
// new project. git-init failures (e.g. user has no git installed)
// degrade silently — the project still opens, just in checkpoint
// history mode.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useEffect, useRef, useState } from 'react';
import { logProjectError, useProjectStore } from '../../stores/project';
import { notify } from '../../lib/notify';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function NewProjectDialog({ open, onClose }: Props) {
  const openProject = useProjectStore((s) => s.openProject);

  const [name, setName] = useState('Untitled');
  const [parent, setParent] = useState<string | null>(null);
  const [gitInit, setGitInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setName('Untitled');
      setParent(null);
      setGitInit(true);
      setBusy(false);
      setError(null);
      return;
    }
    requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
  }, [open]);

  async function browseLocation() {
    try {
      const picked = await window.skrive.project.openDialog();
      if (picked) {
        setParent(picked);
        setError(null);
      }
    } catch (err) {
      logProjectError('newProject:browse', err);
    }
  }

  const trimmedName = name.trim();
  const validation =
    trimmedName.length === 0
      ? 'Name is required.'
      : /[\\/]/.test(trimmedName) || trimmedName === '.' || trimmedName === '..'
        ? "Name can't contain path separators."
        : null;

  const canCreate =
    !busy && parent !== null && validation === null;

  async function handleCreate() {
    if (!canCreate || !parent) return;
    setBusy(true);
    setError(null);
    try {
      const target = await window.skrive.project.create(parent, trimmedName, {
        gitInit
      });
      onClose();
      await openProject(target);
    } catch (err) {
      logProjectError('newProject:create', err);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canCreate) {
      e.preventDefault();
      void handleCreate();
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      className="new-project-modal"
      aria-label="Create new project"
      onKeyDown={handleKeyDown}
    >
          <Dialog.Title className="modal-title">
            Create new project
          </Dialog.Title>
          <Dialog.Description className="modal-desc">
            Pick a location and a name. Skrive will create the folder and
            open it.
          </Dialog.Description>

          <div className="np-field">
            <label htmlFor="np-name">Name</label>
            <Input
              ref={nameRef}
              id="np-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="np-field">
            <label htmlFor="np-location">Location</label>
            <div className="np-location-row">
              <Input
                id="np-location"
                type="text"
                readOnly
                value={parent ?? ''}
                placeholder="Click Browse to choose…"
              />
              <Button
                size="sm"
                onClick={() => void browseLocation()}
                disabled={busy}
              >
                Browse…
              </Button>
            </div>
          </div>

          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={gitInit}
              onChange={(e) => setGitInit(e.target.checked)}
              disabled={busy}
            />
            <span>
              Initialize as a git repository (enables git-backed history)
            </span>
          </label>

          {validation !== null && parent !== null && (
            <p className="modal-error">{validation}</p>
          )}
          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <Button
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={!canCreate}
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </div>
    </DialogShell>
  );
}
