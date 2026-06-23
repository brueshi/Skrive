# Windows app — shipping handoff

Handoff for the next session. Goal: take the Zig Windows host from "runs
end-to-end" to a **polished, installable, shippable Windows app** at parity with
the macOS build. Read this, then the tail of `docs/zig-shell-log.md` (the full
journey) and `docs/Zig shell master plan.md` (Stage 5/6).

---

## Where we are

- **Branch:** `labs/zig-shell-stage-5-windows-host`.
- **Status:** Stages 5.0 (toolchain + skeleton), 5.1 (WebView2 host, bridge,
  serving — first light), and 5.2 (host feature fill) are **done**. The Zig
  Windows host runs Skrive **end-to-end and is usable** (Joe's dogfood: folder
  picker, file ops, delete-to-Recycle-Bin, clipboard, external links,
  Ctrl-not-⌘ shortcuts all work on real Windows).
- **The thesis is proven on both platforms** (one Zig core, thin native hosts,
  system webview, no Electron). What remains is making the Windows build a
  *shippable product*, not a dev artifact.
- **Core invariant:** the Zig core is unchanged throughout — `parity:check`
  stays **26/26**. Any change Windows forces in the core is a design bug to log,
  not absorb.

## The hard constraint (workflow)

**You cannot run the Windows host on the Mac** — WebView2 is Windows-only. You
build here and Joe dogfoods on Windows. Loop:

```
./shell-zig/build-windows.sh x64        # cross-compiles + assembles shell-zig/windows/dist/
cd shell-zig/windows && ditto -c -k --sequesterRsrc --keepParent dist Skrive-win-<tag>.zip
# Joe: python3 -m http.server 8000 in shell-zig/windows, download on Windows, run from PowerShell
```

Because of this, **batch work into dogfood-able milestones** (one complete build
per Joe test), don't drip single checks. `shell-zig/windows/src/diag.zig` is a
libc file logger writing `skrive-diag.log` next to the exe — stderr is
unreliable from a GUI process, so the file log is the triage tool. The
process-tree query (`Get-CimInstance Win32_Process -Filter "Name='Skrive.exe' OR
Name='msedgewebview2.exe'"`) was decisive once.

## Architecture quick-ref

Host: `shell-zig/windows/src/` — `main.zig` (entry, single-instance),
`app.zig` (orchestration + bridge + routing), `win32.zig` (Win32 surface),
`webview2.zig` (hand-declared WebView2 COM ABI), `handlers.zig` (implemented COM
callbacks), `shell.zig` (IFileOpenDialog COM), `host_cmds.zig` (Win32 feature
impls), `paths.zig` (%APPDATA%), `jsescape.zig` (delivery-rule escaper), `diag.zig`.

- The host calls the **native Zig `Core`** directly (not the C ABI; that's
  reserved for the Swift host). Core module exposed via `core/build.zig`
  `addModule("skrive_core")`.
- **Bridge:** renderer→host = `WebMessageReceived` → `routeHostOwned` (dialogs/
  clipboard/links answered in-host) else `Core.handle`. host→renderer = the
  core's `emit` → `WM_SKRIVE_EMIT` (PostMessage to UI thread) → `__skriveDispatch`
  via `ExecuteScript`, escaped per the delivery rule. The `host:` channel
  (trash/reveal) → `WM_SKRIVE_HOSTCMD` → host action → reply via `Core.handle`.
- **COM ABI** is hand-declared from `WebView2.h` (SDK **1.0.3351.48**). Tactic:
  type only the methods you call; every other vtable slot is pointer-sized
  `Slot` filler in array runs whose lengths are **audited against the header slot
  numbers in comments**. Get IIDs/vtable orders from `WebView2.h` (re-fetch the
  NuGet package `Microsoft.Web.WebView2` if needed) and the shobjidl chain.
- **Serving:** `SetVirtualHostNameToFolderMapping` → `http://skrive.localhost/`
  (NOT `.app` — a real HSTS-preloaded TLD that force-upgrades to https and
  breaks the http virtual host; `.localhost` is reserved + HSTS-exempt).
- The macOS host (`shell-zig/macos/Sources/SkriveShell/`) is the **parity
  oracle** — mirror its `CoreBridge.swift`, `ExternalLink.swift`, `AppDelegate`,
  `AppScheme`/`AssetScheme` behavior.

---

## SHIPPING SCOPE — what's left to build

### A. Correctness
- **A1. Navigation backstop.** The macOS host pins the main frame to the app
  origin and routes popups/external links (WKNavigationDelegate + WKUIDelegate +
  `ExternalLink`). The Windows host has no equivalent yet. Add WebView2
  `add_NavigationStarting` (cancel any main-frame nav whose URI isn't
  `http://skrive.localhost/*`; route external schemes to `host_cmds.openExternal`)
  and `add_NewWindowRequested` (set `Handled=true`, route the URI to
  `openExternal`). New handler COM objects + the args interfaces
  (`...NavigationStartingEventArgs`: get_Uri/put_Cancel; `...NewWindowRequested
  EventArgs`: get_Uri/put_Handled) — same pattern as `handlers.zig`. This is the
  one real *functional* gap; do it first.

### B. Native polish
- **B1. App + window icon.** Embed `skrive.ico` as a Win32 resource (a `.rc`
  with `IDI_ICON1 ICON "skrive.ico"`, linked via `exe.addWin32ResourceFile`),
  set `WNDCLASSEXW.hIcon`/`hIconSm` (LoadIconW) so the window + taskbar show it.
  Source the mark from the macOS `skrive.icns` (convert) or the brand assets in
  `build/`.
- **B2. GUI subsystem + diag gating.** Set `exe.subsystem = .Windows` in
  `build.zig` so no console window appears (Zig's WinMain shim still calls
  `pub fn main`). Gate `diag.zig` to debug builds (no-op in ReleaseFast, or a
  `-Ddiag` build option) so a release doesn't write `skrive-diag.log` every run.
- **B3. Custom frameless chrome (the hard one).** Match the macOS inset look
  (transparent titlebar, full-size content). On Windows this is `WM_NCCALCSIZE`
  (remove the standard frame, keep resize borders) + `WM_NCHITTEST` (drag region
  + resize edges). **Caveat:** WebView2 does NOT support Electron's
  `-webkit-app-region: drag`. Investigate WebView2's **non-client region
  support** (recent versions expose `app-region` CSS via a setting / the
  `CoreWebView2` non-client-region API) — if available, it's far cleaner than
  hand-rolling NCHITTEST coordination with the web content. **Research this
  before building B3.** Coordinate the draggable area with the renderer's topbar.
- **B4. Window size/position persistence.** Save window rect + maximized state on
  close, restore on launch (a small file under `%APPDATA%\Skrive`, host-side;
  check whether the macOS host already does this via `setFrameAutosaveName`).
- **B5. DevTools off in release.** `get_Settings` → `ICoreWebView2Settings` →
  `put_AreDevToolsEnabled(false)` in release builds (gate on build mode), mirroring
  the macOS `#if DEBUG` inspector gate.

### C. OS integration
- **C1. File associations + single-instance argv-forward.** Register
  `.md`/`.markdown`/`skrive://` to `Skrive.exe "%1"` (in the installer, D1). The
  host parses `GetCommandLineW` for a path on launch and opens it; the
  single-instance guard (currently just exits the 2nd launch) must instead
  **forward the path to the running instance** (WM_COPYDATA or a named pipe) and
  exit, and the running instance opens it. Needs the renderer's open-file/folder
  path — wire it through the bridge.

### D. Packaging
- **D1. Installer.** NSIS script producing `Skrive-{version}-Setup.exe` (version
  from root `package.json`): install to Program Files, Start Menu shortcut,
  register the C1 associations, **WebView2 runtime detection + Evergreen
  bootstrapper** if absent, uninstaller. (A portable zip is the fallback for
  testing.) Mirror the existing Electron `electron-builder.yml` naming/assoc
  conventions where sensible.

### E. Verification (the formal 5.2/5.3 gates)
- **E1. Watcher on NTFS** — confirm external create/edit/delete/rename reflects in
  the sidebar (the core's e-dant/watcher Windows backend is compiled in but
  compile-only-verified). Part of the next dogfood.
- **E2. Parity corpus on Windows** — run `fixture_main.exe` + the corpus on
  Windows (mainly path-separator/NTFS edge cases; macOS is 26/26). Note the
  friction: the runner is a bun script, so it needs bun + the repo on Windows,
  or a self-contained harness.

---

## DEFERRED — explicitly NOT this push

- **Display DPI** (Per-Monitor-V2 awareness + `WM_DPICHANGED`, Windows) and
  **framerate/animation audit** (renderer rAF/CSS framerate-independence,
  `prefers-reduced-motion`; GPU compositing is already on). Joe wants these
  "baked in" for both shells **eventually**, but deferred to a later pass. macOS
  is largely free for both (Retina/ProMotion via AppKit/WebKit); the real DPI
  work is the Windows host declaring PMv2 + handling `WM_DPICHANGED`.
- **Updater** — Stage 6.
- **The list→codeblock serializer bug** — a shared-renderer (ProseMirror→Markdown)
  bug where a nested bulleted list serializes to a fenced code block; reproduces
  on all shells, unrelated to Windows. Revisit during editor work.

---

## Suggested milestones (one dogfood-able build each)

1. **Correct & native-looking** — A1, B1, B2, B5. Robust nav, real icon, no
   console window, release-clean. Dogfood.
2. **Native feel** — B3 (custom chrome; research first), B4, C1. Looks/integrates
   like a native Windows app. Dogfood.
3. **Packaged** — D1 installer + WebView2 bootstrap. Final dogfood from a clean
   install. Run E1/E2.

## Key gotchas (hard-won this session)

- **Borrowed COM references must be `AddRef`'d.** The controller/environment from
  the completion handlers are borrowed; storing raw pointers destroyed the
  controller on callback return and tore down the whole WebView2 process tree
  (blank window, all calls S_OK). This was the first-light bug. AddRef anything
  you retain; release intermediates after a QI.
- **`CoInitializeEx(STA)`** on the UI thread before WebView2 creation.
- **`skrive.localhost`, never `skrive.app`** (HSTS).
- **Win32 ABI:** Zig 0.16 `std.os.windows` dropped `WINAPI`/`WPARAM`/`LRESULT`;
  declare locally (`callconv(.winapi)`, `WPARAM=usize`, etc.). `extern struct`
  fn-pointer fields need an explicit calling convention.
- **`put_Bounds(RECT)`** (16-byte by-value) lowers correctly under
  `callconv(.winapi)` (verified by asm) — not a bug source.
- Build/transfer/dogfood loop above; can't run on the Mac.
