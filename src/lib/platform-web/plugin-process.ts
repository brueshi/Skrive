// Web shim for @tauri-apps/plugin-process.
//
// `relaunch` is called from the updater after install. On web there's no
// process to restart — and `check` already returns null on web — so this
// shouldn't fire in practice. If it ever does (defensive fallback), reload
// the tab so the user lands on a fresh state.

export async function relaunch(): Promise<void> {
  if (typeof window !== "undefined") window.location.reload();
}
