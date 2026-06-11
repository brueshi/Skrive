// System-clipboard writes, routed through the shell bridge. The bridge
// is the primary path because `navigator.clipboard` only exists in
// secure contexts — Electron qualifies today, but native-webview custom
// schemes do not (Zig shell plan, Stage 0.3), and the OS clipboard has
// no such constraint. `navigator.clipboard` remains solely as the
// fallback for running the editor in a plain browser page with no
// shell bridge at all (the website-embed case).

export async function writeRichToClipboard(
  html: string,
  text: string
): Promise<void> {
  if (window.skrive !== undefined) {
    await window.skrive.clipboard.writeRich(html, text);
    return;
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' })
    })
  ]);
}

export async function writeTextToClipboard(text: string): Promise<void> {
  if (window.skrive !== undefined) {
    await window.skrive.clipboard.writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
