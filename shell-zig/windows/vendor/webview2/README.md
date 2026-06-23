# Vendored WebView2 loader

`WebView2Loader.dll` per arch, extracted from the official NuGet package
**`Microsoft.Web.WebView2` v1.0.3351.48** (`runtimes/win-<arch>/native/`).

It is a small Microsoft redistributable shim whose only job is to find the
installed Evergreen WebView2 runtime and hand back the COM environment. We
vendor it in-tree (like `core/vendor/watcher`) so the build is self-contained
and cross-builds from macOS with no NuGet step.

The host loads it **dynamically** at startup (`LoadLibraryW` +
`GetProcAddress` for `CreateCoreWebView2EnvironmentWithOptions`), per the
master plan — so nothing links the MSVC import lib at build time, and the
cross-compile needs no Windows SDK. The DLL ships next to `Skrive.exe`.

The COM interface ABI (vtable layouts + IIDs) used by `src/webview2.zig` is
hand-declared from the same SDK's `WebView2.h`; those are frozen COM contracts
and do not change across SDK versions (newer SDKs only add `_4`/`_5`/...).
