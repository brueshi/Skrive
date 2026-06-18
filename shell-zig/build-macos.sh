#!/usr/bin/env bash
# Stage 1 macOS spike build pipeline. Orders the four moving parts and
# folds in the one toolchain workaround the spike turned up (re-archiving
# the Zig static lib so Apple's ld64 accepts its alignment).
#
# Output: shell-zig/macos/.build/Skrive.app
#
# See shell-zig/README.md for what each step is and why this order.
set -euo pipefail

ZIG_MACOS_MIN="14.0"          # match Package.swift's .macOS(.v14)
CONFIG="${1:-debug}"          # debug | release

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$SCRIPT_DIR/core"
MACOS_DIR="$SCRIPT_DIR/macos"
WEB_DIR="$SCRIPT_DIR/web"
RENDERER_DIR="$REPO_ROOT/out/renderer"

echo "==> 1/6 renderer bundle"
if [[ ! -f "$RENDERER_DIR/index.html" ]]; then
    echo "    out/renderer missing; running bun run start:build"
    (cd "$REPO_ROOT" && bun run start:build)
else
    echo "    found $RENDERER_DIR/index.html (run 'bun run start:build' to refresh)"
fi

echo "==> 2/6 native bridge bundle"
bun build "$WEB_DIR/native-bridge.ts" \
    --outfile "$WEB_DIR/dist/native-bridge.js" \
    --format iife --target browser

echo "==> 3/6 zig core static lib"
(cd "$CORE_DIR" && zig build "-Dtarget=aarch64-macos.$ZIG_MACOS_MIN")

echo "==> 4/6 re-archive core for ld64 alignment"
# Zig's archiver writes members ld64 rejects ("not 8-byte aligned"); Apple's
# libtool rewrites the archive with the alignment ld64 wants. Single member.
LIB="$CORE_DIR/zig-out/lib/libskrive_core.a"
WORK="$(mktemp -d)"
( cd "$WORK" && ar x "$LIB" && chmod u+rw ./*.o \
    && libtool -static -o libfixed.a ./*.o )
cp "$WORK/libfixed.a" "$LIB"
rm -rf "$WORK"

echo "==> 5/6 swift host"
SWIFT_ARGS=(build)
[[ "$CONFIG" == "release" ]] && SWIFT_ARGS+=(-c release)
(cd "$MACOS_DIR" && swift "${SWIFT_ARGS[@]}")
BIN="$(cd "$MACOS_DIR" && swift build "${SWIFT_ARGS[@]:1}" --show-bin-path)/SkriveShell"

echo "==> 6/6 assemble Skrive.app"
APP="$MACOS_DIR/.build/Skrive.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer" \
    "$APP/Contents/Resources/project"
cp "$MACOS_DIR/Info.plist" "$APP/Contents/Info.plist"
# App icon (CFBundleIconFile=skrive -> Resources/skrive.icns); the dark
# brand mark, distinct from the Electron build's build/icon.icns.
cp "$MACOS_DIR/skrive.icns" "$APP/Contents/Resources/skrive.icns"
cp "$BIN" "$APP/Contents/MacOS/SkriveShell"
cp "$WEB_DIR/dist/native-bridge.js" "$APP/Contents/Resources/native-bridge.js"
cp -R "$RENDERER_DIR/." "$APP/Contents/Resources/renderer/"
# Sample project supplies images for the skrive-asset:// origin (1.2).
cp -R "$SCRIPT_DIR/fixtures/sample-project/." "$APP/Contents/Resources/project/"

echo ""
echo "Built $APP"
echo "Run: open '$APP'   (or: '$APP/Contents/MacOS/SkriveShell' for console logs)"
