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

# Single source of truth for the app version: the repo root package.json.
# Stamped into the bundled Info.plist below so Sparkle compares the right
# version against the appcast. Parsed without node/bun to keep this dependency-
# free; falls back to the Info.plist template's value if the parse fails.
APP_VERSION="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    "$REPO_ROOT/package.json" | head -1)"

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
# Build only the static lib (`lib` step), not the native fixture harness: the
# harness is host-only tooling and links FSEvents directly, which Zig can't
# resolve under this explicit cross-target. The host links the frameworks.
#
# --sysroot hands Zig the macOS SDK: with an explicit `-Dtarget=...macos` Zig
# cross-compiles and won't auto-detect it, but the vendored watcher's C++
# includes need the SDK's framework + usr/include headers (build.zig wires
# those paths from b.sysroot).
MACOS_SDK="$(xcrun --show-sdk-path)"
(cd "$CORE_DIR" && zig build lib "-Dtarget=aarch64-macos.$ZIG_MACOS_MIN" --sysroot "$MACOS_SDK")

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
# Force a relink every build. SwiftPM does NOT track the Zig static lib
# (linked via unsafeFlags -L/-l) as an input, and it content-hashes sources,
# so when only the core changes neither `swift build` nor `touch`-ing sources
# triggers a relink: the OLD binary, linked against a STALE
# libskrive_core.a, is silently reused — a very confusing failure mode.
# Removing the linked product makes `swift build` relink (the object files
# stay cached, so this is ~1s, not a full rebuild) against the fresh .a.
SWIFT_ARGS=(build)
[[ "$CONFIG" == "release" ]] && SWIFT_ARGS+=(-c release)
BIN="$(cd "$MACOS_DIR" && swift build "${SWIFT_ARGS[@]:1}" --show-bin-path)/SkriveShell"
rm -f "$BIN"
(cd "$MACOS_DIR" && swift "${SWIFT_ARGS[@]}")

echo "==> 6/7 assemble Skrive.app"
APP="$MACOS_DIR/.build/Skrive.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer" \
    "$APP/Contents/Resources/project" "$APP/Contents/Frameworks"
cp "$MACOS_DIR/Info.plist" "$APP/Contents/Info.plist"
# Stamp the real version (package.json) over the Info.plist template values.
if [[ -n "$APP_VERSION" ]]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" \
        "$APP/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" \
        "$APP/Contents/Info.plist"
    echo "    stamped version $APP_VERSION"
else
    echo "    WARN: could not read version from package.json; using Info.plist default" >&2
fi
# App icon (CFBundleIconFile=skrive -> Resources/skrive.icns); the dark
# brand mark, distinct from the Electron build's build/icon.icns.
cp "$MACOS_DIR/skrive.icns" "$APP/Contents/Resources/skrive.icns"
# Dock-tile light/dark variants (same source PNGs the Electron build swaps).
# macOS never swaps a flat .icns for dark mode, so the host swaps the running
# dock tile itself per system appearance — see AppDelegate.applyDockIcon.
cp "$REPO_ROOT/build/icon.png" "$APP/Contents/Resources/icon.png"
cp "$REPO_ROOT/build/icon-dark.png" "$APP/Contents/Resources/icon-dark.png"
cp "$BIN" "$APP/Contents/MacOS/SkriveShell"
cp "$WEB_DIR/dist/native-bridge.js" "$APP/Contents/Resources/native-bridge.js"
cp -R "$RENDERER_DIR/." "$APP/Contents/Resources/renderer/"
# Sample project supplies images for the skrive-asset:// origin (1.2).
cp -R "$SCRIPT_DIR/fixtures/sample-project/." "$APP/Contents/Resources/project/"

echo "==> 7/7 embed Sparkle.framework"
# SwiftPM links Sparkle but doesn't bundle it into our hand-assembled .app.
# Copy the macOS slice of the resolved XCFramework into Contents/Frameworks
# (the executable's @rpath points there). ditto preserves the framework's
# versioned-bundle symlinks and its pre-signed nested XPC services / helper
# apps; the release script re-signs them under Developer ID.
SPARKLE_FW="$(find "$MACOS_DIR/.build/artifacts" \
    -path '*Sparkle.xcframework/macos*/Sparkle.framework' -type d -prune \
    2>/dev/null | head -1)"
if [[ -z "$SPARKLE_FW" ]]; then
    echo "    ERROR: Sparkle.framework not found under .build/artifacts." >&2
    echo "    Run 'swift package resolve' in $MACOS_DIR first." >&2
    exit 1
fi
ditto "$SPARKLE_FW" "$APP/Contents/Frameworks/Sparkle.framework"
echo "    embedded $(basename "$(dirname "$SPARKLE_FW")")/Sparkle.framework"

echo ""
echo "Built $APP"
echo "Run: open '$APP'   (or: '$APP/Contents/MacOS/SkriveShell' for console logs)"
