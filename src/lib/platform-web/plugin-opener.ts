// Web shim for @tauri-apps/plugin-opener.
//
// `revealItemInDir` is a no-op because there's no host filesystem to reveal.
// `openUrl` delegates to `window.open` so external links from the preview
// pane still open in a new tab — the user-visible behavior is the same as
// the desktop "open in default browser" path.

export async function revealItemInDir(_path: string): Promise<void> {
  // Intentionally empty.
}

export async function openUrl(href: string): Promise<void> {
  if (typeof window === "undefined") return;
  window.open(href, "_blank", "noopener,noreferrer");
}
