// Auto-update IPC. Wraps electron-updater's autoUpdater to expose a
// status state machine (UpdaterStatus) to the renderer.
//
// Design:
//   - The shell holds a single `current` status (a discriminated union
//     defined in @skrive/shared) and broadcasts every transition to
//     every BrowserWindow that's currently subscribed.
//   - Auto-download is intentionally OFF. The writer should consent
//     before the app fetches a multi-MB artifact in the background.
//     The renderer's "Update available — Download" button calls
//     `updater:downloadAndInstall` to actually pull the bits.
//   - In dev (`!app.isPackaged`), electron-updater can't do its job
//     (no signed app, no real publish feed), so we short-circuit
//     check() with a synthetic 'no-update' so the Settings UI still
//     responds visibly to button presses without spamming logs.
//   - Errors don't bubble — they update `current` to a kind:'error'
//     state with a human-readable message. The Settings UI surfaces
//     it; nothing throws across the IPC boundary.

import { app } from 'electron';
import pkg from 'electron-updater';
import type { UpdaterStatus } from '@skrive/shared';
import { emitEvent, registerCommand } from '../main/dispatch';

const { autoUpdater } = pkg;

let current: UpdaterStatus = { kind: 'idle' };

function broadcast(next: UpdaterStatus): void {
  current = next;
  emitEvent('updater:status', next);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function registerUpdaterHandlers(): void {
  // Auto-download off — the user opts in by clicking Download.
  autoUpdater.autoDownload = false;
  // Quit-and-install on macOS uses a special path; leave the default.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ kind: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    broadcast({
      kind: 'available',
      version: info.version,
      releaseNotes:
        typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    broadcast({
      kind: 'no-update',
      current: info?.version ?? app.getVersion(),
      checkedAtMs: Date.now()
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    // electron-updater holds the version on the autoUpdater instance
    // after update-available, but doesn't include it in the progress
    // event. Pull it from the last broadcast if present.
    const version = current.kind === 'downloading' ? current.version : '';
    broadcast({
      kind: 'downloading',
      version,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ kind: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    broadcast({ kind: 'error', message: errorMessage(err) });
  });

  registerCommand('updater:check', async () => {
    if (!app.isPackaged) {
      // In dev there's no signed app and no publish feed; short-circuit
      // so the Settings UI doesn't spew an opaque error every time the
      // button is clicked during development.
      broadcast({
        kind: 'no-update',
        current: app.getVersion(),
        checkedAtMs: Date.now()
      });
      return {};
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      broadcast({ kind: 'error', message: errorMessage(err) });
    }
    return {};
  });

  // Single handler covers both "Download" (when status is 'available')
  // and "Restart to install" (when status is 'ready'). The renderer
  // labels the button per state but always calls this same channel.
  registerCommand('updater:downloadAndInstall', async () => {
    if (!app.isPackaged) return {};
    if (current.kind === 'ready') {
      // electron's quitAndInstall closes all windows and relaunches
      // into the new app bundle. No further events fire.
      autoUpdater.quitAndInstall();
      return {};
    }
    if (current.kind !== 'available') {
      // Out-of-band call (palette command before a check ran, etc.).
      // Force a check; the renderer can re-invoke when status flips
      // to 'available'.
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        broadcast({ kind: 'error', message: errorMessage(err) });
      }
      return {};
    }
    try {
      // Capture version for the downloading-state labels — the
      // progress event from electron-updater doesn't carry it.
      broadcast({
        kind: 'downloading',
        version: current.version,
        percent: 0,
        bytesPerSecond: 0
      });
      await autoUpdater.downloadUpdate();
      // The 'update-downloaded' event handler flips status to 'ready';
      // the renderer's Restart button re-enters this handler with
      // current.kind === 'ready' and quitAndInstall fires.
    } catch (err) {
      broadcast({ kind: 'error', message: errorMessage(err) });
    }
    return {};
  });

  // Renderer-side `onStatus` subscriptions ask for the current state on
  // mount so the UI can render the right control on first paint without
  // waiting for a transition. `updater:current` is a synchronous query.
  registerCommand('updater:current', () => {
    return current as unknown as Record<string, unknown>;
  });
}
