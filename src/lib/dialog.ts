// Thin wrapper around @tauri-apps/plugin-dialog. Exists so components don't
// import the plugin directly — keeps the "Rust core owns all IO" principle
// consistent at the call site, and gives us one place to add logging or
// telemetry if we ever want it (we won't, per the no-telemetry rule, but the
// indirection costs nothing).

import { open } from "@tauri-apps/plugin-dialog";

/**
 * Present the OS directory picker and return the chosen path, or null if the
 * user cancelled. Always resolves — never throws for cancellation.
 */
export async function pickProjectDirectory(): Promise<string | null> {
  const result = await open({
    directory: true,
    multiple: false,
    title: "Open project",
  });
  return typeof result === "string" ? result : null;
}
