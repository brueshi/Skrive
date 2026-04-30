// Web shim for @tauri-apps/api/path.
//
// The desktop Settings view uses `appDataDir` + `join` to expose a "Reveal
// settings folder" button. The browser has no app data directory, so the
// shims return synthetic strings. The matching `revealItemInDir` shim is a
// no-op, so the strings are never actually opened.

export async function appDataDir(): Promise<string> {
  return "/skrive-web";
}

export async function join(...parts: string[]): Promise<string> {
  return parts.filter(Boolean).join("/");
}
