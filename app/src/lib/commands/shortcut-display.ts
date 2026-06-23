// Shortcut display strings are authored with macOS symbols (⌘ ⇧ ⌥ ⌃) as the
// single source of truth. On non-macOS platforms (Windows, Linux) we render
// them in the local convention (Ctrl+/Alt+/Shift+) so a Windows user never
// sees ⌘. Pure no-op on macOS, so the macOS and Electron builds are unchanged.

const isMac =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** Convert a macOS-symbol shortcut string to the current platform's idiom.
 *  e.g. "⌘⇧E" -> "Ctrl+Shift+E" on Windows; unchanged on macOS. Works on
 *  whole strings too ("Raw  ⌘1" -> "Raw  Ctrl+1"). */
export function platformShortcut(display: string): string {
  if (isMac) return display;
  return display
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+');
}
