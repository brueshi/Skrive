// Local diagnostics log commands. The renderer's global error handlers
// (window.onerror / unhandledrejection) forward here via `log:append` because
// the sandboxed renderer can't touch the filesystem; `log:reveal` opens the
// folder for the Settings "Reveal diagnostics" button. Local only — nothing is
// ever uploaded (Skrive's no-telemetry posture). Mirrors the Zig hosts'
// host-owned log:* commands so the shared renderer behaves the same on every
// shell.

import { app, shell } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { registerCommand } from '../main/dispatch';

function crashesDir(): string {
  return join(app.getPath('userData'), 'crashes');
}

export function registerLogHandlers(): void {
  registerCommand('log:append', async (payload) => {
    const line = typeof payload.line === 'string' ? payload.line : '';
    const dir = crashesDir();
    await mkdir(dir, { recursive: true });
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    await appendFile(join(dir, 'renderer.log'), stamped, 'utf8');
    return {};
  });

  registerCommand('log:reveal', async () => {
    const dir = crashesDir();
    await mkdir(dir, { recursive: true });
    await shell.openPath(dir);
    return {};
  });
}
