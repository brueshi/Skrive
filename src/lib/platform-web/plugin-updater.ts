// Web shim for @tauri-apps/plugin-updater.
//
// Auto-update is a desktop-binary concern; the website is updated via its
// own deploy pipeline. `check` returns null (no update available) so both
// the startup and manual check paths fall through cleanly.

type Update = {
  version: string;
  downloadAndInstall: () => Promise<void>;
};

export async function check(): Promise<Update | null> {
  return null;
}
