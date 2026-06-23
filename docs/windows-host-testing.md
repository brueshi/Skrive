# Testing the Zig Windows host (Stage 5.1)

End-to-end: build the host bundle on the Mac, get it onto a Windows machine,
run it, and confirm first light. The entire build happens on macOS — Windows is
only needed to *run* it, because WebView2 is Windows-only.

**What "pass" means for Stage 5.1:** the Skrive welcome UI renders in a native
window, and `app:version` round-trips renderer -> host -> Zig core -> renderer
with no console errors. That's it. Opening a project, dialogs, clipboard, etc.
are Stage 5.2 — the core answers `UNKNOWN_COMMAND` for those for now, which is
expected and harmless.

---

## 1. Build the bundle (on the Mac)

From the repo root:

```sh
./shell-zig/build-windows.sh x64
```

This bundles the renderer, compiles the Zig host for `x86_64-windows`, and
assembles a self-contained folder:

```
shell-zig/windows/dist/
  Skrive.exe              the host (console build, so diagnostics print)
  WebView2Loader.dll      Microsoft's loader shim (loaded at startup)
  native-bridge.js        the renderer transport, injected at document-create
  renderer/               the app (index.html + assets/), served locally
```

`dist/` is the only thing you copy to Windows. (For Windows-on-ARM, use
`./shell-zig/build-windows.sh arm64`.)

---

## 2. Get it onto Windows

Copy the **entire** `shell-zig/windows/dist/` folder to the Windows machine
(zip it, drop it on a share, USB, whatever). Keep the folder intact — `Skrive.exe`
finds `renderer/`, `native-bridge.js`, and `WebView2Loader.dll` next to itself.

---

## 3. Make sure the WebView2 runtime is installed

The host drives the system's Evergreen WebView2 runtime; it does not bundle one.

- **Windows 11:** already installed by default — skip this step.
- **Windows 10:** if it's missing, install the **Evergreen Bootstrapper** from
  <https://developer.microsoft.com/microsoft-edge/webview2/> (the small
  "Download" under Evergreen Bootstrapper). One click, no reboot.

If the runtime is absent, the host's environment creation fails with a logged
HRESULT (see Troubleshooting) rather than crashing.

---

## 4. Run it

Open **PowerShell** (or `cmd`) in the copied `dist/` folder and run it from the
terminal — not by double-clicking — so the diagnostics are visible:

```powershell
cd path\to\dist
.\Skrive.exe
```

- A Skrive window should open.
- The terminal stays attached; any startup problem prints a line like
  `[skrive] <what> failed: hr=0x...`.
- SmartScreen may warn that the exe is unsigned ("Windows protected your PC").
  That's expected (the Windows build is unsigned for now) — **More info ->
  Run anyway**.

---

## 5. What success looks like

1. The window opens and renders the **Skrive welcome screen** (not a blank white
   page). This alone confirms a lot: assets are being served over
   `http://skrive.localhost/`, the bridge was injected (`window.skrive` exists),
   and the native channel works — the welcome state comes from
   `persistence:loadAppState`, which is handled by the Zig core.

2. **Explicit round-trip check.** WebView2 DevTools are enabled — press **F12**
   (or right-click -> Inspect) and, in the Console, run:

   ```js
   await window.skrive.app.version()
   ```

   Expected: the Zig core's version string, `"0.1.0-zig-spike"` (deliberately
   distinct from the Electron build's version so the round-trip is unambiguous).
   You can also try `await window.skrive.app.platform()` -> `"win32"`.

If both hold, Stage 5.1 passes.

---

## 6. Troubleshooting

Capture the terminal output and (if the window opened) the DevTools Console +
Network tabs — that's what narrows it down.

**Window never opens; terminal prints `startup failed: WebView2LoaderMissing`**
`WebView2Loader.dll` isn't next to `Skrive.exe`. You copied a partial folder —
re-copy all of `dist/`.

**Window never opens; `startup failed: CoreCreateFailed`**
The Zig core failed to init (e.g. the exe's folder isn't writable for the
default user-data dir). Try running from a writable location like your Desktop.

**Window opens but is blank; terminal shows `[skrive] environment created failed: hr=0x...`**
The WebView2 runtime is missing or broken — install the Evergreen runtime
(step 3). Send me the HRESULT.

**Window opens, blank, NO hr error line**
Serving or rendering. Open DevTools (F12):
- *Console errors?* Send them.
- *Network tab:* are the `http://skrive.localhost/...` requests 200 or failing?
  Failing -> the virtual-host mapping; send the failed URLs.
- *Page is there but zero-size / clipped?* That points at `put_Bounds` (the
  RECT-by-value Win64 ABI spot I flagged) — note it and I'll adjust the call.

**UI stuck / Console says "native transport unavailable"**
The bridge didn't inject. Check the terminal for
`[skrive] could not read native-bridge.js` (the bundle wasn't copied), otherwise
it's the document-create injection — tell me and I'll add a diagnostic.

---

## 7. What to send me

- The full terminal output (every `[skrive]` line matters).
- If the window opened: the DevTools **Console** contents and, if assets look
  wrong, the **Network** tab (which `skrive.localhost` requests succeeded/failed).
- A one-line "window opened / stayed blank / never appeared" so I know which
  branch we're in.

From that I can tell whether it's serving, the bridge, the WebView2 runtime, or
one of the compile-verified-but-unrun COM spots, and fix it precisely.
