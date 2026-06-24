// Global renderer-error capture (Stage 6.5 crash logs). Uncaught errors and
// unhandled promise rejections are forwarded to the host's local crash log via
// the host-owned `log:append` command — the sandboxed renderer can't write
// files itself. Best-effort by design: failures are swallowed so a shell that
// doesn't implement log:append degrades silently. Local only, never uploaded
// (Skrive's no-telemetry posture).

function send(line: string): void {
  try {
    void window.skrive?.log?.append(line).catch(() => undefined);
  } catch {
    // Host without a log capability — nothing to do.
  }
}

export function installCrashLog(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    const where = `${event.filename}:${event.lineno}:${event.colno}`;
    const stack =
      event.error instanceof Error && event.error.stack
        ? `\n${event.error.stack}`
        : '';
    send(`error: ${event.message} @ ${where}${stack}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const detail =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
    send(`unhandledrejection: ${detail}`);
  });
}
