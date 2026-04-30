// Web shim for @tauri-apps/plugin-dialog.
//
// The only consumer is `pickProjectDirectory` (open project flow). The web
// demo runs a single bootstrapped project and doesn't expose project
// switching, so the shim returns `null` — the wrapper treats that as
// "user cancelled" and the call site stays inert.

type OpenOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
};

export async function open(_options?: OpenOptions): Promise<string | null> {
  return null;
}
