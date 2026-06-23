#!/usr/bin/env bash
# Stage 5.1 Windows host build + assembly. Cross-compiles from macOS by default
# (Zig needs no MSVC/Windows SDK); also runs natively on Windows. Produces
# shell-zig/windows/dist/ — a self-contained, runnable bundle (Skrive.exe +
# renderer assets + injected bridge + WebView2Loader.dll) to copy to a Windows
# machine and launch. The seed of Stage 5.3 packaging.
#
# Usage: ./build-windows.sh [x64|arm64] [debug|release]
set -euo pipefail

ARCH="${1:-x64}"
CONFIG="${2:-debug}"

case "$ARCH" in
    x64)   ZIG_TARGET="x86_64-windows-gnu" ;;
    arm64) ZIG_TARGET="aarch64-windows-gnu" ;;
    *) echo "unknown arch: $ARCH (expected x64|arm64)"; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WIN_DIR="$SCRIPT_DIR/windows"
WEB_DIR="$SCRIPT_DIR/web"
RENDERER_DIR="$REPO_ROOT/out/renderer"
DIST="$WIN_DIR/dist"

echo "==> 1/4 renderer bundle"
if [[ ! -f "$RENDERER_DIR/index.html" ]]; then
    echo "    out/renderer missing; running bun run start:build"
    (cd "$REPO_ROOT" && bun run start:build)
else
    echo "    found $RENDERER_DIR/index.html (run 'bun run start:build' to refresh)"
fi

echo "==> 2/4 native bridge bundle (Windows / chrome.webview)"
bun build "$WEB_DIR/native-bridge-win.ts" \
    --outfile "$WEB_DIR/dist/native-bridge-win.js" \
    --format iife --target browser

echo "==> 3/4 zig host ($ZIG_TARGET, $CONFIG)"
if [[ "$CONFIG" == "release" ]]; then
    (cd "$WIN_DIR" && zig build -Dtarget="$ZIG_TARGET" -Doptimize=ReleaseFast)
else
    (cd "$WIN_DIR" && zig build -Dtarget="$ZIG_TARGET")
fi

echo "==> 4/4 assemble dist/"
# Layout the host expects next to Skrive.exe: renderer/ (served via the
# skrive.localhost virtual-host mapping), native-bridge.js (read + injected at
# document-create), WebView2Loader.dll (loaded dynamically at startup).
rm -rf "$DIST"
mkdir -p "$DIST/renderer"
cp "$WIN_DIR/zig-out/bin/Skrive.exe" "$DIST/Skrive.exe"
cp "$WEB_DIR/dist/native-bridge-win.js" "$DIST/native-bridge.js"
cp -R "$RENDERER_DIR/." "$DIST/renderer/"
cp "$WIN_DIR/vendor/webview2/$ARCH/WebView2Loader.dll" "$DIST/WebView2Loader.dll"

echo ""
echo "Built $DIST"
echo "Copy the whole folder to a Windows machine and run Skrive.exe"
echo "(a recent Edge WebView2 Runtime must be installed — it is by default on Windows 11)."
