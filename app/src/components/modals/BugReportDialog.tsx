// In-app bug reporter (SKR-130). A subject + body go to the backend relay,
// which creates a `Bug`-labeled issue in our tracker. Same Radix-dialog shell
// as the new-project / rename modals (focus trap, ESC, scroll lock).
//
// Privacy: nothing is sent until the writer hits Send, and the optional
// diagnostics are off by default and shown in full before they're attached —
// never document content. See lib/bug-report.ts and Linear SKR-130.

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { notify } from '../../lib/notify';
import {
  gatherDiagnostics,
  submitBugReport,
  type BugReportDiagnostics
} from '../../lib/bug-report';

const SUBJECT_MAX = 200;
const BODY_MAX = 8000;

type Props = {
  open: boolean;
  onClose: () => void;
};

export function BugReportDialog({ open, onClose }: Props) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<BugReportDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setSubject('');
      setBody('');
      setIncludeDiagnostics(false);
      setDiagnostics(null);
      setBusy(false);
      setError(null);
      return;
    }
    requestAnimationFrame(() => subjectRef.current?.focus());
  }, [open]);

  // Gather diagnostics the first time the writer opts in, so the preview shows
  // exactly what would be attached. Cached for the dialog's lifetime. A gather
  // failure is non-fatal — drop back to opted-out rather than block the report.
  useEffect(() => {
    if (!includeDiagnostics || diagnostics) return;
    void gatherDiagnostics()
      .then(setDiagnostics)
      .catch((err) => {
        console.error('[bug-report] gatherDiagnostics failed', err);
        setIncludeDiagnostics(false);
      });
  }, [includeDiagnostics, diagnostics]);

  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();
  const validation =
    trimmedSubject.length === 0
      ? 'Subject is required.'
      : trimmedSubject.length > SUBJECT_MAX
        ? `Subject must be ${SUBJECT_MAX} characters or fewer.`
        : trimmedBody.length === 0
          ? 'Description is required.'
          : trimmedBody.length > BODY_MAX
            ? `Description must be ${BODY_MAX} characters or fewer.`
            : null;

  const canSend = !busy && validation === null;

  async function handleSend() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await submitBugReport({
        subject: trimmedSubject,
        body: trimmedBody,
        diagnostics: includeDiagnostics ? (diagnostics ?? undefined) : undefined
      });
      onClose();
      notify.success('Bug report sent');
    } catch (err) {
      // Keep the writer's text so they can retry; never lose a report silently.
      notify.error("Couldn't send bug report", err);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // ⌘/Ctrl+Enter sends; plain Enter inserts a newline in the textarea.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
      e.preventDefault();
      void handleSend();
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
          className="modal-dialog modal-sheet bug-report-modal"
          aria-label="Report a bug"
          onKeyDown={handleKeyDown}
        >
          <button
            type="button"
            className="modal-dismiss"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
          <div className="modal-eyebrow">Feedback</div>
          <Dialog.Title className="modal-title">Report a bug</Dialog.Title>
          <Dialog.Description className="modal-desc">
            Goes straight to our tracker. Only what you write here is sent —
            never your documents.
          </Dialog.Description>

          <div className="bug-field">
            <label htmlFor="bug-subject">Subject</label>
            <input
              ref={subjectRef}
              id="bug-subject"
              type="text"
              value={subject}
              maxLength={SUBJECT_MAX}
              onChange={(e) => setSubject(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder="A short summary"
            />
          </div>

          <div className="bug-field">
            <label htmlFor="bug-body">What happened?</label>
            <textarea
              id="bug-body"
              value={body}
              maxLength={BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              rows={6}
              placeholder="What you did, what you expected, and what happened instead."
            />
          </div>

          <label className="modal-checkbox">
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(e) => setIncludeDiagnostics(e.target.checked)}
              disabled={busy}
            />
            <span>Include diagnostics (version, OS, build) — no document content</span>
          </label>

          {includeDiagnostics && diagnostics && (
            <pre className="bug-diagnostics-preview">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          )}

          {validation !== null && (trimmedSubject.length > 0 || trimmedBody.length > 0) && (
            <p className="modal-error">{validation}</p>
          )}
          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-button primary"
              onClick={() => void handleSend()}
              disabled={!canSend}
            >
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
