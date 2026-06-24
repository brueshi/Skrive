#!/usr/bin/env bash
# Generate + EdDSA-sign appcast-win.xml — WinSparkle's RSS update feed (Stage 6
# M3). Signs Setup.exe with the SAME Sparkle EdDSA key as the macOS appcast (one
# crown-jewel key), since WinSparkle and Sparkle share the Ed25519 scheme and
# the sparkle:edSignature attribute; WinSparkle verifies it with the matching
# public key shipped in the host (updater.zig).
#
# Reuses Sparkle's `sign_update` (already on disk once the macOS host is built)
# rather than the Windows-only winsparkle-tool, so signing stays mac-side with a
# single key + single tool.
#
# Usage: make-appcast.sh <Setup.exe> <version> <enclosure-url> [out.xml]
# Key: SPARKLE_ED_PRIVATE_KEY (CI secret, via a temp file deleted on exit) or,
# if unset, the login Keychain (local).
set -euo pipefail

SETUP="${1:?usage: make-appcast.sh <Setup.exe> <version> <enclosure-url> [out.xml]}"
VERSION="${2:?version required}"
URL="${3:?enclosure url required}"
OUT="${4:-appcast-win.xml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_ZIG="$(cd "$SCRIPT_DIR/../.." && pwd)"
SIGN_UPDATE="$(find "$SHELL_ZIG/macos/.build" -name sign_update -path '*Sparkle*/bin/*' 2>/dev/null | head -1)"
[[ -n "$SIGN_UPDATE" ]] || { echo "sign_update not found — build the macOS host first"; exit 1; }

keyfile=""
keyargs=()
cleanup() { [[ -n "$keyfile" ]] && rm -f "$keyfile"; }
trap cleanup EXIT
if [[ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]]; then
    keyfile="$(mktemp)"
    chmod 600 "$keyfile"
    printf '%s' "$SPARKLE_ED_PRIVATE_KEY" > "$keyfile"
    keyargs=(--ed-key-file "$keyfile")
fi

# Without -p, sign_update prints the appcast enclosure attributes verbatim:
#   sparkle:edSignature="<base64>" length="<bytes>"
ATTRS="$("$SIGN_UPDATE" "${keyargs[@]}" "$SETUP")"

PUBDATE="$(date -u +'%a, %d %b %Y %H:%M:%S +0000')"

cat > "$OUT" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Skrive</title>
    <description>Skrive updates</description>
    <language>en</language>
    <item>
      <title>Version ${VERSION}</title>
      <pubDate>${PUBDATE}</pubDate>
      <sparkle:version>${VERSION}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <enclosure url="${URL}" sparkle:version="${VERSION}" type="application/octet-stream" ${ATTRS} />
    </item>
  </channel>
</rss>
EOF

echo "wrote $OUT"
