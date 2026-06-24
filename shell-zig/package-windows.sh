#!/usr/bin/env bash
# Stage 6 M3 Windows installer packaging. Builds the release dist, then compiles
# the hand-written NSIS installer with Homebrew `makensis` on macOS (no rc.exe /
# Windows SDK). Produces shell-zig/windows/installer/Skrive-{version}-Setup.exe —
# a per-user installer (no admin) that bootstraps the WebView2 runtime if absent.
#
# Mirrors the build/package split of release-macos.sh: build-windows.sh assembles
# the runnable bundle; this script wraps it in an installer.
#
# Usage: ./package-windows.sh [x64|arm64]   (default x64, the dogfood arch)
set -euo pipefail

ARCH="${1:-x64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WIN_DIR="$SCRIPT_DIR/windows"
INSTALLER_DIR="$WIN_DIR/installer"
DIST="$WIN_DIR/dist"

command -v makensis >/dev/null || { echo "makensis not found — run: brew install makensis"; exit 1; }

VERSION="$(grep '"version"' "$REPO_ROOT/package.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
OUTFILE="$INSTALLER_DIR/Skrive-${VERSION}-Setup.exe"

echo "==> 1/2 release dist ($ARCH, version $VERSION)"
"$SCRIPT_DIR/build-windows.sh" "$ARCH" release

# Just a vendored file path; the secret scanner mis-flags it as high-entropy.
BOOTSTRAPPER="$WIN_DIR/vendor/webview2/MicrosoftEdgeWebview2Setup.exe" # noscan

echo "==> 2/2 makensis -> $(basename "$OUTFILE")"
makensis \
    "-DVERSION=$VERSION" \
    "-DDIST=$DIST" \
    "-DBOOTSTRAPPER=$BOOTSTRAPPER" \
    "-DICON=$WIN_DIR/skrive.ico" \
    "-DOUTFILE=$OUTFILE" \
    "$INSTALLER_DIR/skrive.nsi"

echo ""
echo "Built $OUTFILE"
echo "Copy to a Windows machine and run it (per-user install, no admin)."
