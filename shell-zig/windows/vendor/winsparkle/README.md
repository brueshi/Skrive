# Vendored WinSparkle

`WinSparkle.dll` per arch, extracted from the official release
**WinSparkle v0.9.3** (`vslavik/winsparkle`, the macOS-Sparkle-inspired Windows
auto-updater): `x64/Release/WinSparkle.dll` and `ARM64/Release/WinSparkle.dll`
from `WinSparkle-0.9.3.zip`.

WinSparkle is the locked Windows updater engine (master plan §6.1 / Stage 6
M3): native, battle-proven, no managed runtime — the C twin of the macOS host's
Sparkle. It verifies updates with **EdDSA over Ed25519** (the same scheme and
the same key pair as the macOS appcast), reading the `sparkle:edSignature`
attribute off its RSS appcast.

The host loads it **dynamically** at startup (`LoadLibraryW` +
`GetProcAddress`), exactly like `WebView2Loader.dll` — so nothing links the
MSVC import lib at build time and the cross-compile from macOS needs no Windows
SDK. The C API used by `src/updater.zig` is hand-declared from the release's
`include/winsparkle.h` (all `__cdecl`); the DLL ships next to `Skrive.exe`.

Bumping the version: download the new `WinSparkle-<ver>.zip`, replace both
DLLs, and diff `include/winsparkle.h` against the hand-declared signatures in
`src/updater.zig` before relying on any new entry point.
