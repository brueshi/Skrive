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
DEPS_DIR="$REPO_ROOT/app/node_modules/.vite/deps"

# shellcheck source=./wait-for-vite.sh
source "$SCRIPT_DIR/wait-for-vite.sh"

echo "==> building native host (debug)"
bash "$SCRIPT_DIR/build-macos.sh" debug

echo "==> starting Vite dev server"
( cd "$REPO_ROOT" && bun run dev ) &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

# NOT just "does it answer" — see wait-for-vite.sh. Launching on the first 200
# races dep pre-bundling and blank-screens the window.
echo "==> waiting for $DEV_URL to be ready (server + dep optimization)"
wait_for_vite "$DEV_URL" "$DEPS_DIR"

echo "==> launching host against $DEV_URL"
BIN="$SCRIPT_DIR/macos/.build/Skrive.app/Contents/MacOS/SkriveShell"
SKRIVE_DEV_URL="$DEV_URL" "$BIN"
