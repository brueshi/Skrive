#!/usr/bin/env bash
# macOS release pipeline for the Zig shell (Stage 6.1 / 6.5): build release ->
# code-sign (Developer ID + hardened runtime, signing Sparkle's nested helpers
# inside-out) -> verify -> DMG -> notarize -> staple -> EdDSA-sign the update +
# refresh the appcast. Produces a signed, notarized, auto-updatable artifact.
#
# This is SEPARATE from build-macos.sh on purpose: build-macos.sh is the fast
# dev/dogfood loop (unsigned, no notarization round-trip); this is the shipping
# path. CI (Stage 6.2, zig-shell.yml) runs the same steps with secrets.
#
# Credentials (the script skips-and-instructs when a step's inputs are absent so
# a partial local run still produces a signed DMG). The same env knobs serve
# both the local run and the zig-shell.yml CI job — one source of truth:
#   SIGN_IDENTITY   Developer ID Application identity (default: Joe's).
#   Notarization (either path):
#     NOTARY_PROFILE  notarytool keychain profile (`notarytool store-credentials`)
#                     — the convenient local path.
#     or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID — the CI path
#                     (same secrets release.yml uses). If neither is set,
#                     notarize+staple are skipped.
#   Appcast:
#     APPCAST_URL     base URL the enclosures resolve under (generate_appcast
#                     --download-url-prefix). If unset, the appcast step is
#                     skipped and the DMG's raw EdDSA signature is printed.
#     SPARKLE_ED_PRIVATE_KEY  the EdDSA private key (CI secret). If unset, the
#                     key is read from the login Keychain (local).
#
# The EdDSA private key is a crown-jewel secret — never exported into the repo;
# locally it lives in the login Keychain (generate_keys put it there), in CI it
# is an injected secret written to a temp file for this run only.
set -euo pipefail

SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application: Joseph Bruechner (Q5Y792924V)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
APPCAST_URL="${APPCAST_URL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$SCRIPT_DIR/macos"
APP="$MACOS_DIR/.build/Skrive.app"
OUT_DIR="$MACOS_DIR/.build/release"

APP_VERSION="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    "$REPO_ROOT/package.json" | head -1)"
ARCH="$(uname -m)"   # arm64
DMG="$OUT_DIR/Skrive-$APP_VERSION-$ARCH.dmg"

echo "==> 1/7 release build"
bash "$SCRIPT_DIR/build-macos.sh" release

echo "==> 2/7 code-sign (Developer ID + hardened runtime)"
FW="$APP/Contents/Frameworks/Sparkle.framework"
# Sign inside-out: Sparkle's helpers and XPC services first, then the
# framework, then the app last (codesign seals nested code, so the order
# matters; --force replaces Sparkle's own signatures with ours). Hardened
# runtime (-o runtime) is required for notarization; the app is not sandboxed,
# so Sparkle needs no extra entitlements.
sign() { codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$1"; }
sign "$FW/Versions/B/Autoupdate"
sign "$FW/Versions/B/Updater.app"
sign "$FW/Versions/B/XPCServices/Downloader.xpc"
sign "$FW/Versions/B/XPCServices/Installer.xpc"
sign "$FW"
sign "$APP"

echo "==> 3/7 verify signature"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "    signature valid"

echo "==> 4/7 build DMG"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"   # drag-to-install affordance
rm -f "$DMG"
hdiutil create -volname "Skrive" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
sign "$DMG"
echo "    built $DMG"

notarize_args=()
if [[ -n "$NOTARY_PROFILE" ]]; then
    notarize_args=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" \
        && -n "${APPLE_TEAM_ID:-}" ]]; then
    notarize_args=(--apple-id "$APPLE_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi
if [[ ${#notarize_args[@]} -eq 0 ]]; then
    echo "==> 5/7 notarize — SKIPPED (no NOTARY_PROFILE and no APPLE_ID creds)"
    echo "    local one-time: xcrun notarytool store-credentials <profile> \\"
    echo "        --apple-id <id> --team-id Q5Y792924V --password <app-specific-pw>"
    echo "==> 6/7 staple — SKIPPED (needs notarization)"
else
    echo "==> 5/7 notarize (uploads the DMG to Apple — may take minutes)"
    xcrun notarytool submit "$DMG" "${notarize_args[@]}" --wait
    echo "==> 6/7 staple"
    xcrun stapler staple "$DMG"
    xcrun stapler staple "$APP"
fi

# EdDSA-sign the update + refresh the appcast. generate_appcast scans a
# directory of update archives and writes appcast.xml with each enclosure's
# edSignature. The private key comes from a CI secret piped via stdin (so it
# never touches disk) or, locally, the login Keychain.
SIGN_UPDATE="$(find "$MACOS_DIR/.build" -name sign_update -path '*Sparkle*/bin/*' 2>/dev/null | head -1)"
GEN_APPCAST="$(find "$MACOS_DIR/.build" -name generate_appcast -path '*Sparkle*/bin/*' 2>/dev/null | head -1)"
if [[ -z "$APPCAST_URL" ]]; then
    echo "==> 7/7 appcast — SKIPPED (set APPCAST_URL for a feed)"
    if [[ -n "$SIGN_UPDATE" && -z "${SPARKLE_ED_PRIVATE_KEY:-}" ]]; then
        echo "    EdDSA signature for this DMG (Keychain key, for a hand-written feed):"
        "$SIGN_UPDATE" "$DMG" || true
    fi
elif [[ -n "${SPARKLE_ED_PRIVATE_KEY:-}" ]]; then
    echo "==> 7/7 generate appcast (CI key via stdin)"
    printf '%s' "$SPARKLE_ED_PRIVATE_KEY" \
        | "$GEN_APPCAST" --ed-key-file - --download-url-prefix "$APPCAST_URL" "$OUT_DIR"
    echo "    wrote $OUT_DIR/appcast.xml"
else
    echo "==> 7/7 generate appcast (Keychain key)"
    "$GEN_APPCAST" --download-url-prefix "$APPCAST_URL" "$OUT_DIR"
    echo "    wrote $OUT_DIR/appcast.xml"
fi

echo ""
echo "Release artifact: $DMG"
[[ ${#notarize_args[@]} -eq 0 ]] && \
    echo "NOTE: not notarized — Gatekeeper will warn on first launch until you notarize."
