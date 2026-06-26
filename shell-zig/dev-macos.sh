#!/usr/bin/env bash
# Native HMR dev loop (replaces `electron-vite dev` post-graduation): the Vite
# dev server plus the Swift host pointed at it via SKRIVE_DEV_URL, so renderer
# edits hot-reload in the real WKWebView with the real native bridge.
#
#   bun run start          # or: bash shell-zig/dev-macos.sh
#
# The host's bundled renderer is ignored in dev — SKRIVE_DEV_URL wins — but we
# still assemble the .app because that is the simplest way to get a linked,
# runnable binary with the bridge + Info.plist + Sparkle in place.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_URL="${SKRIVE_DEV_URL:-http://localhost:5173}"

echo "==> building native host (debug)"
bash "$SCRIPT_DIR/build-macos.sh" debug

echo "==> starting Vite dev server"
( cd "$REPO_ROOT" && bun run dev ) &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

echo "==> waiting for $DEV_URL"
until curl -sf -o /dev/null "$DEV_URL"; do sleep 0.3; done

echo "==> launching host against $DEV_URL"
BIN="$SCRIPT_DIR/macos/.build/Skrive.app/Contents/MacOS/SkriveShell"
SKRIVE_DEV_URL="$DEV_URL" "$BIN"
