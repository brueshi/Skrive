// Rename-with-references confirmation modal.
//
// Shown when the user invokes rename via F2 on the active tab, the
// "Rename file…" command in the palette, or the sidebar's right-click
// "Rename…" item. The modal displays:
//
//   - The directory prefix (read-only) plus an editable basename.
//   - A live preview of every reference the commit will rewrite.
//   - Cancel + Rename buttons.
//
// The preview debounces 120ms; a monotonic seq counter discards
// stale responses. The basename input accepts forward slashes:
// typing `docs/foo.md` moves the file into a `docs/` subdirectory
// and the backend rewrites inbound references to the new path.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { useEffect, useRef, useState } from 'react';
import type { Reference, RenamePreview } from '@skrive/shared';
import { logProjectError, useProjectStore } from '../../stores/project';
import { notify } from '../../lib/notify';
import { projectModel } from '../../lib/project-model/client';

const DEBOUNCE_MS = 120;

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

function leafOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function validateBasename(b: string): string | null {
  const trimmed = b.trim();
  if (trimmed.length === 0) return "Name can't be empty.";
  if (trimmed.includes('\\')) return "Name can't contain backslashes.";
  if (trimmed.startsWith('/')) return "Name can't start with /.";
  const segs = trimmed.split('/');
  if (segs.some((s) => s.length === 0)) {
    return "Name can't contain empty path segments.";
  }
  if (segs.some((s) => s === '.' || s === '..')) {
    return "Name can't contain . or .. segments.";
  }
  const last = segs[segs.length - 1] ?? '';
  if (!last.endsWith('.md') && !last.endsWith('.markdown')) {
    return 'Name must end with .md or .markdown.';
  }
  return null;
}

function kindLabel(kind: Reference['kind']): string {
  switch (kind) {
    case 'inline':
      return 'inline';
    case 'wiki':
      return 'wiki';
    case 'referenceUse':
      return 'ref use';
    case 'referenceDefinition':
      return 'ref def';
  }
}

export function RenameModal() {
  const oldPath = useProjectStore((s) => s.renameModalPath);
  const close = useProjectStore((s) => s.closeRenameModal);
  const commit = useProjectStore((s) => s.commitRename);

  // Lifecycle: on every open (oldPath transition null→string), reset
  // the input + preview. Selecting the stem on focus is wired below.
  const [basename, setBasename] = useState('');
  const [preview, setPreview] = useState<RenamePreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = oldPath !== null;
  const dirPrefix = oldPath ? dirOf(oldPath) : '';
  const initialBasename = oldPath ? leafOf(oldPath) : '';
  const newPath = dirPrefix + basename.trim();
  const validation = oldPath ? validateBasename(basename) : null;

  useEffect(() => {
    if (!open) {
      setBasename('');
      setPreview(null);
      setPreviewPending(false);
      setInputError(null);
      setCommitting(false);
      return;
    }
    setBasename(initialBasename);
    setPreview(null);
    setInputError(null);
    setCommitting(false);
    // Focus + select-stem after render.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = initialBasename.lastIndexOf('.');
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, oldPath]);

  // Debounced preview. Skip the IPC entirely if the input is invalid.
  useEffect(() => {
    if (!oldPath) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (validation !== null) {
      setPreview(null);
      setPreviewPending(false);
      return;
    }
    setPreviewPending(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      seqRef.current += 1;
      const issued = seqRef.current;
      const client = projectModel();
      if (!client) {
        setPreviewPending(false);
        return;
      }
      client
        .previewRename(oldPath, newPath)
        .then((result) => {
          if (issued !== seqRef.current) return;
          setPreview(result);
          setInputError(null);
          setPreviewPending(false);
        })
        .catch((err) => {
          if (issued !== seqRef.current) return;
          setPreview(null);
          setInputError(err instanceof Error ? err.message : String(err));
          setPreviewPending(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [oldPath, newPath, validation]);

  const canRename =
    !!oldPath &&
    validation === null &&
    preview !== null &&
    !preview.targetExists &&
    !previewPending &&
    !committing &&
    newPath !== oldPath;

  async function handleCommit() {
    if (!canRename || !oldPath) return;
    setCommitting(true);
    try {
      await commit(oldPath, newPath);
      close();
    } catch (err) {
      logProjectError('commitRename', err);
      notify.error("Couldn't rename", err);
      setCommitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && canRename) {
      e.preventDefault();
      void handleCommit();
    }
  }

  if (!oldPath) return null;

  const refCount = preview?.references.length ?? 0;
  const defCount = preview?.definitionUpdates.length ?? 0;
  const fileCount = preview
    ? new Set(preview.references.map((r) => r.path)).size
    : 0;
  const showsMoves = basename.includes('/') && validation === null;

  return (
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o && !committing) close();
      }}
      className="rename-modal"
      aria-label="Rename file"
    >
          <Dialog.Title className="rename-title">Rename</Dialog.Title>
          <p className="rename-old" title={oldPath}>
            {oldPath}
          </p>

          <div className="rename-input-row">
            <span className="rename-prefix" title={dirPrefix || '(project root)'}>
              {dirPrefix}
            </span>
            <input
              ref={inputRef}
              className="rename-basename"
              type="text"
              value={basename}
              onChange={(e) => setBasename(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="New basename"
              spellCheck={false}
              autoComplete="off"
              disabled={committing}
            />
          </div>

          {validation !== null ? (
            <p className="rename-error">{validation}</p>
          ) : preview?.targetExists ? (
            <p className="rename-error">A file already exists at {newPath}.</p>
          ) : inputError ? (
            <p className="rename-error">{inputError}</p>
          ) : showsMoves ? (
            <p className="rename-moves-to">
              Moves to <span>{newPath}</span>
            </p>
          ) : null}

          <div className="rename-summary">
            {previewPending ? (
              <span className="rename-count-pending">Computing preview…</span>
            ) : preview ? (
              <>
                <span className="rename-count">
                  {refCount} {refCount === 1 ? 'reference' : 'references'} across{' '}
                  {fileCount} {fileCount === 1 ? 'file' : 'files'}
                </span>
                {defCount > 0 && (
                  <>
                    <span className="rename-count-sep">·</span>
                    <span className="rename-count-self">
                      {defCount}{' '}
                      {defCount === 1
                        ? 'self-reference'
                        : 'self-references'}{' '}
                      inside the renamed file
                    </span>
                  </>
                )}
              </>
            ) : null}
          </div>

          {preview &&
            (preview.references.length > 0 ||
              preview.definitionUpdates.length > 0) && (
              <div className="rename-preview">
                <ul className="rename-rows">
                  {preview.references.map((row) => (
                    <li
                      key={`${row.path}:${row.line}:${row.column}`}
                      className="rename-row"
                    >
                      <span className="rename-row-kind">{kindLabel(row.kind)}</span>
                      <span className="rename-row-path">
                        {row.path}
                        <span className="rename-row-line">:{row.line}</span>
                      </span>
                      <span className="rename-row-snippet">{row.snippet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-button secondary"
              onClick={close}
              disabled={committing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="modal-button primary"
              onClick={() => void handleCommit()}
              disabled={!canRename}
            >
              {committing ? 'Renaming…' : 'Rename'}
            </button>
          </div>
    </DialogShell>
  );
}
