// In-app reporter (SKR-130). One dialog, two kinds: a bug report or customer
// feedback. `kind` drives the copy; the relay routes by the `type` we send
// (label + priority + assignee). Same DialogShell sheet as the new-project /
// rename modals, scaled up via the .report-modal content class.
//
// Privacy: nothing is sent until the writer hits the button, and the optional
// diagnostics are off by default and shown in full before they're attached —
// never document content. See lib/report.ts and Linear SKR-130.

import * as Dialog from '@radix-ui/react-dialog';
import { DialogShell } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { useEffect, useRef, useState } from 'react';
import { notify } from '../../lib/notify';
import {
  gatherDiagnostics,
  submitReport,
  type ReportDiagnostics,
  type ReportType
} from '../../lib/report';

const SUBJECT_MAX = 200;
const BODY_MAX = 8000;

type Copy = {
  eyebrow: string;
  title: string;
  desc: string;
  bodyLabel: string;
  bodyPlaceholder: string;
  submit: string;
  submitting: string;
  success: string;
};

const COPY: Record<ReportType, Copy> = {
  bug: {
    eyebrow: 'Bug report',
    title: 'Report a bug',
    desc: 'Goes straight to our tracker. Only what you write here is sent — never your documents.',
    bodyLabel: 'What happened?',
    bodyPlaceholder: 'What you did, what you expected, and what happened instead.',
    submit: 'Send report',
    submitting: 'Sending…',
    success: 'Bug report sent'
  },
  feedback: {
    eyebrow: 'Feedback',
    title: 'Send feedback',
    desc: 'Ideas, requests, or what could be better. Goes straight to our tracker — only what you write here is sent.',
    bodyLabel: 'Your feedback',
    bodyPlaceholder: "What you'd love to see, or what's getting in your way.",
    submit: 'Send feedback',
    submitting: 'Sending…',
    success: 'Feedback sent — thank you'
  }
};

type Props = {
  open: boolean;
  kind: ReportType;
  onClose: () => void;
};

export function ReportDialog({ open, kind, onClose }: Props) {
  const copy = COPY[kind];

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ReportDiagnostics | null>(null);
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
        console.error('[report] gatherDiagnostics failed', err);
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
          ? 'A description is required.'
          : trimmedBody.length > BODY_MAX
            ? `Description must be ${BODY_MAX} characters or fewer.`
            : null;

  const canSend = !busy && validation === null;

  async function handleSend() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await submitReport({
        type: kind,
        subject: trimmedSubject,
        body: trimmedBody,
        diagnostics: includeDiagnostics ? (diagnostics ?? undefined) : undefined
      });
      onClose();
      notify.success(copy.success);
    } catch (err) {
      // Keep the writer's text so they can retry; never lose a report silently.
      notify.error(
        kind === 'bug' ? "Couldn't send bug report" : "Couldn't send feedback",
        err
      );
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
    <DialogShell
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      className="report-modal"
      aria-label={copy.title}
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
          <div className="modal-eyebrow">{copy.eyebrow}</div>
          <Dialog.Title className="modal-title">{copy.title}</Dialog.Title>
          <Dialog.Description className="modal-desc">{copy.desc}</Dialog.Description>

          <div className="report-field">
            <label htmlFor="report-subject">Subject</label>
            <Input
              ref={subjectRef}
              id="report-subject"
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

          <div className="report-field">
            <label htmlFor="report-body">{copy.bodyLabel}</label>
            <Textarea
              id="report-body"
              value={body}
              maxLength={BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              rows={6}
              placeholder={copy.bodyPlaceholder}
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
            <pre className="report-diagnostics-preview">
              {JSON.stringify(diagnostics, null, 2)}
            </pre>
          )}

          {validation !== null && (trimmedSubject.length > 0 || trimmedBody.length > 0) && (
            <p className="modal-error">{validation}</p>
          )}
          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <Button
              className="report-send"
              variant="primary"
              onClick={() => void handleSend()}
              disabled={!canSend}
            >
              {busy ? copy.submitting : copy.submit}
            </Button>
          </div>
    </DialogShell>
  );
}
