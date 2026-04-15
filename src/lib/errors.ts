// Shared error formatter for errors that come back from Tauri commands.
//
// Rust errors are serialized by `src-tauri/src/error.rs` as tagged plain
// objects, e.g. `{ kind: "io", message: "the underlying text" }`. They are
// NOT JavaScript `Error` instances, so the common idiom
//
//   err instanceof Error ? err.message : String(err)
//
// falls through to `String(err)`, which on a plain object prints the useless
// `[object Object]`. This helper unwraps the `{ kind, message }` shape and
// gives callers a readable string regardless of what actually came back.

type RustErrorShape = {
  kind?: string;
  message?: string;
};

function isRustError(e: unknown): e is RustErrorShape {
  return typeof e === "object" && e !== null && "kind" in e;
}

/**
 * Turn anything Tauri or a JS runtime might throw into a readable string.
 * Prefers the human `message` field from Rust errors, then falls back to
 * the `kind` tag, then to `Error.message`, then to `String()`.
 */
export function formatError(e: unknown): string {
  if (isRustError(e)) {
    const rust = e as RustErrorShape;
    if (rust.message && rust.message.length > 0) return rust.message;
    if (rust.kind) return rust.kind;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
