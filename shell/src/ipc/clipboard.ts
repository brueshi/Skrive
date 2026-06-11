// Clipboard commands (Stage 0.3 of the Zig shell plan). The renderer
// must not depend on `navigator.clipboard` — it requires a secure
// context, which native-webview custom schemes don't provide — so
// clipboard access is a shell capability like any other. Electron's
// clipboard module writes both flavors atomically; the Zig shell's
// hosts implement the same three commands via NSPasteboard / the
// Windows clipboard.

import { clipboard } from 'electron';
import { IpcError, registerCommand } from '../main/dispatch';

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new IpcError('INVALID_PAYLOAD', `${field} must be a string`);
  }
  return value;
}

export function registerClipboardHandlers(): void {
  registerCommand('clipboard:writeRich', (payload) => {
    const html = requireString(payload, 'html');
    const text = requireString(payload, 'text');
    clipboard.write({ text, html });
    return {};
  });

  registerCommand('clipboard:writeText', (payload) => {
    clipboard.writeText(requireString(payload, 'text'));
    return {};
  });

  registerCommand('clipboard:readText', () => {
    return { text: clipboard.readText() };
  });
}
