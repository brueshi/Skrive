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
cp -R "$APP" "$STAGE/Skrive.app"
ln -s /Applications "$STAGE/Applications"   # drag-to-install affordance

# Branded chrome (SKR-122): a HiDPI background image and a custom volume icon.
# The background is bundled from the committed @1x/@2x PNGs into one multi-rep
# TIFF (tiffutil) so Finder renders it crisply on Retina without needing a
# rasterizer at release time. Both touches are absent-safe: with no PNGs we ship
# the plain — still correctly laid-out — window, and with no icns the disk keeps
# the generic icon. The icns is the existing app mark, reused as the disk icon.
DMG_DIR="$MACOS_DIR/dmg"
VOL_ICNS="$MACOS_DIR/skrive.icns"
BACKGROUND_HFS=""   # HFS path handed to the layout script; empty => no background
if [[ -f "$DMG_DIR/background.png" && -f "$DMG_DIR/background@2x.png" ]]; then
    mkdir -p "$STAGE/.background"
    tiffutil -cathidpicheck "$DMG_DIR/background.png" \
        "$DMG_DIR/background@2x.png" -out "$STAGE/.background/background.tiff" >/dev/null
    BACKGROUND_HFS=".background:background.tiff"
fi
[[ -f "$VOL_ICNS" ]] && cp "$VOL_ICNS" "$STAGE/.VolumeIcon.icns"

# Lay the install window out so the drag reads left -> right: Skrive.app on the
# left, the Applications symlink on the right. A bare `hdiutil create` ships no
# icon positions, so Finder sorts the two items alphabetically — "Applications"
# (A) lands on the left and "Skrive" (S) on the right, the wrong direction to
# drag. Positioned icons live in the volume's .DS_Store, which only Finder can
# write, so we build a read-write image, mount it, lay it out via Finder, then
# convert to the compressed read-only image we ship.
VOLNAME="Skrive"
RW_DMG="$(mktemp -u).dmg"
hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -fs HFS+ \
    -format UDRW -ov "$RW_DMG" >/dev/null
rm -rf "$STAGE"

# Mount read-write and resolve the real mount point (a stale "Skrive" volume
# would push this to "/Volumes/Skrive 1"); derive the volume name Finder
# scripts against from it so the layout targets the image we just mounted.
ATTACH_OUT="$(hdiutil attach "$RW_DMG" -readwrite -noverify -noautoopen)"
MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUT" | grep -Eo '/Volumes/.*' | head -1)"
MOUNT_VOL="$(basename "$MOUNT_DIR")"

# Non-fatal: if Finder scripting is unavailable (some headless CI sessions) we
# ship the un-positioned DMG rather than failing the release — at worst the
# layout reverts to today's behavior, never a broken artifact.
if ! osascript - "$MOUNT_VOL" "$BACKGROUND_HFS" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set volName to item 1 of argv
  set bgPath to item 2 of argv
  tell application "Finder"
    tell disk volName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 150, 960, 620}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to 128
      if bgPath is not "" then
        set background picture of opts to file bgPath
      end if
      set position of item "Skrive.app" of container window to {170, 252}
      set position of item "Applications" of container window to {640, 252}
      update without registering applications
      delay 1
      close
    end tell
  end tell
end run
APPLESCRIPT
then
    echo "    WARN: Finder layout step failed; shipping un-positioned DMG"
fi

# Activate the custom volume icon: the .VolumeIcon.icns staged at the volume
# root only takes effect once the volume's custom-icon attribute bit is set,
# which must happen while it's still mounted.
if [[ -f "$MOUNT_DIR/.VolumeIcon.icns" ]]; then
    SetFile -a C "$MOUNT_DIR" || echo "    WARN: couldn't set volume icon bit"
fi

sync
hdiutil detach "$MOUNT_DIR" >/dev/null \
    || hdiutil detach "$MOUNT_DIR" -force >/dev/null

rm -f "$DMG"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
rm -f "$RW_DMG"
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
# A bare `[[ cond ]] && echo` as the final statement would return the test's
# exit status — non-zero (and so fail the whole script under the CI runner)
# whenever notarization DID run. Use an explicit if so success exits 0.
if [[ ${#notarize_args[@]} -eq 0 ]]; then
    echo "NOTE: not notarized — Gatekeeper will warn on first launch until you notarize."
fi
