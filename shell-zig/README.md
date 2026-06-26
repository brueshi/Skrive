# shell-zig

A second Skrive shell — a Zig core behind a per-platform native host —
driving the system webview with the existing React renderer, byte-for-byte.
The Electron shell in `shell/` remains the shipping product; this is the
labs experiment tracked in `docs/Zig shell master plan.md` and
`docs/zig-shell-log.md`.

Status: **Stage 1 (macOS spike)**. The code here is allowed to be rough;
its findings are the deliverable.

## Layout

```
core/        Zig static library exposing the Part I C ABI (dispatch, fs, ...)
macos/       Swift host: NSWindow + WKWebView + the native bridge (SwiftPM)
windows/     C++ host (Stage 5; not present yet)
web/         renderer-side native transport, bundled and injected by the host
fixtures/    parity corpus (Stage 0.6) — the contract made concrete
```

The IPC contract is the source of truth in `shared/src/ipc-contracts.ts`
(envelope, error-code set, command table) and `shared/src/bridge.ts`
(`createSkriveBridge`). This shell implements a transport under that one
tested mapping; `app/` and `shared/` are read-only from here.

## Build order (macOS)

One script runs the whole pipeline:

```sh
./shell-zig/build-macos.sh          # debug
./shell-zig/build-macos.sh release  # release
```

It performs, in order (each step depends on the previous):

1. **Renderer bundle** — ensures `out/renderer/` exists; runs
   `bun run start:build` if missing. Refresh it yourself when the
   frontend changes.
2. **Native bridge** — `bun build web/native-bridge.ts` to a single IIFE
   (`web/dist/native-bridge.js`) the host injects at document start.
3. **Zig core** — `zig build` in `core/` →
   `core/zig-out/lib/libskrive_core.a` (pinned to Zig 0.16.0, macOS 14
   deployment target).
4. **ld64 re-archive** — Apple's `ld64` rejects Zig's archive member
   alignment ("not 8-byte aligned"); the script re-archives the lib with
   Apple's `libtool -static`. Required until Zig fixes this upstream.
5. **Swift host** — `swift build` in `macos/`, linking the core archive
   by absolute path.
6. **Assemble** — lays out `macos/.build/Skrive.app` with `Info.plist`,
   the renderer bundle, and the bridge under `Contents/Resources`.

Run it:

```sh
open shell-zig/macos/.build/Skrive.app
# or, for console logs:
shell-zig/macos/.build/Skrive.app/Contents/MacOS/SkriveShell
```

## Environment switches

| Variable | Values | Purpose |
|---|---|---|
| `SKRIVE_SERVE` | `scheme` (default), `file` | 1.2 serving-mode bake-off. `scheme` serves the bundle over a `skrive-app://` custom origin (ES modules + workers load); `file` uses `loadFileURL` (the 1.1 spike found it cannot execute the module bundle — blank window). |
| `SKRIVE_DIAG` | `1` | Relays the webview console to stdout and runs a post-load self-test (round-trips `app:version`/`app:platform`, probes the DOM). Headless evidence for the done-criteria. |
| `SKRIVE_RENDERER_DIR` | path | Dev override: load the renderer from a directory instead of the app bundle. |
| `SKRIVE_BRIDGE_JS` | path | Dev override: inject the bridge from a file instead of the app bundle. |
| `SKRIVE_DEV_URL` | url | Native HMR: load the renderer from a Vite dev server (e.g. `http://localhost:5173`) instead of the bundle, so renderer edits hot-reload in the real webview. Drives `bun run start` via `dev-macos.sh`. The bridge is still injected at document-create, so `window.skrive` works against it. Never set in release builds. |

## Tests

```sh
cd shell-zig/core && zig build test     # Zig core (dispatch, diag:poison)
cd shell-zig/macos && swift test        # JSEscape delivery-rule escaper
```

The serving-mode matrix and the 1.4 injection/worker checks are scripted
through the diagnostics harness: build, then run the binary with
`SKRIVE_DIAG=1` (optionally `SKRIVE_SERVE=file`) and read the `SELFTEST`
JSON line on stdout (`injectionByteIdentical`, `injectionNoExec`,
`lintWorkerLoaded`, etc.).

## Conventions

- Branch `labs/zig-shell-<stage>`; conventional commits; one concern per
  commit; no emojis anywhere.
- Zig version pinned in `core/build.zig.zon`; a compiler upgrade is its
  own commit, never mixed with features.
- The renderer-facing transport must not import the `@skrive/shared`
  barrel's value surface (sandboxed-preload rule, carried over from the
  Electron shell — see the Stage 0.1 log entry).
- The renderer delivery rule (Part I) is security-normative: responses and
  events reach the renderer only as `window.__skriveDispatch(<JSON string
  literal>)`, escaped in `macos/Sources/SkriveShellKit/JSEscape.swift`
  (unit-tested). Never interpolate payload fields into a script.
