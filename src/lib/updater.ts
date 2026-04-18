// Auto-updater glue. Talks to `tauri-plugin-updater`, surfaces results
// through the toast system, and owns the install-and-restart flow.
//
// Two entry points:
//
//   - `checkForUpdatesOnStartup`  — silent on "up to date" and on errors
//     (offline, endpoint misconfigured, etc.). Only surfaces a toast when
//     a newer version is available, so the happy path doesn't spam the
//     user on every launch.
//
//   - `checkForUpdatesManual`     — invoked from the project menu, so the
//     user expects feedback. Toasts on all three outcomes: update found,
//     already up to date, or error.
//
// The update bundle verification (signature + public key) is handled by
// the plugin before `update.download()` returns. We only have to decide
// whether to install + relaunch once it's downloaded.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { notify } from "$lib/stores/notifications.svelte";
import { formatError } from "$lib/errors";

async function installUpdate(update: {
  version: string;
  downloadAndInstall: () => Promise<void>;
}): Promise<void> {
  try {
    await update.downloadAndInstall();
    // `relaunch()` exits the current process and starts the new one.
    // The autosave close-requested handler already flushes dirty tabs
    // on exit, so the restart is safe.
    await relaunch();
  } catch (err) {
    notify.error(
      `Couldn't install Skrive ${update.version}: ${formatError(err)}`,
      err,
    );
  }
}

/**
 * Fire-and-forget check called on app mount. Never toasts an error —
 * failing to reach the update endpoint is a normal condition (offline,
 * first run of a dev build with no key configured, private-network
 * block) that shouldn't alarm the user.
 */
export async function checkForUpdatesOnStartup(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    notify.prompt(
      `Skrive ${update.version} is available.`,
      {
        label: "Install & restart",
        onClick: () => installUpdate(update),
      },
      "info",
    );
  } catch (err) {
    // Swallow — see block comment above. Keep the console breadcrumb
    // for developer diagnostics.
    console.debug("Startup update check failed:", err);
  }
}

/**
 * User-invoked check from the project menu. Always toasts — including
 * "already up to date" — so the click produces visible feedback.
 */
export async function checkForUpdatesManual(): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      notify.success("Skrive is up to date.");
      return;
    }
    notify.prompt(
      `Skrive ${update.version} is available.`,
      {
        label: "Install & restart",
        onClick: () => installUpdate(update),
      },
      "info",
    );
  } catch (err) {
    notify.error(`Couldn't check for updates: ${formatError(err)}`, err);
  }
}
