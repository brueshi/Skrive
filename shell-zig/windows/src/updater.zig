//! WinSparkle auto-updater binding — the Windows twin of the macOS host's
//! Sparkle integration (Stage 6 M3). WinSparkle is a C DLL loaded dynamically
//! at startup (`LoadLibraryW` + `GetProcAddress`), exactly like
//! `WebView2Loader.dll`, so nothing links an MSVC import lib and the
//! cross-compile from macOS stays SDK-free. The C API is hand-declared from the
//! vendored `winsparkle.h`; every entry point is `__cdecl`, which Zig matches
//! with `callconv(.c)` (NOT the `.winapi`/stdcall the COM surface uses).
//!
//! The updater is host-native: WinSparkle does its own HTTPS, shows its own
//! dialog, and rewrites the app — it never touches the renderer's `net:*` seam.
//! The renderer's Settings "Check for updates" button routes here via the
//! host-owned `updater:check` command; status is shown by WinSparkle's UI, not
//! streamed back through the `updater:status` contract (the native shells use
//! the native updater, not the in-app contract flow — `native-bridge-win.ts`
//! sets `__SKRIVE_NATIVE_UPDATER__` so the renderer hides its own updater UI).
//!
//! Verification is EdDSA over Ed25519, the same scheme AND the same key pair as
//! the macOS appcast (one CI-only private signing key; the public half ships
//! here). WinSparkle reads the `sparkle:edSignature` attribute off the feed.

const std = @import("std");
const win32 = @import("win32.zig");
const diag = @import("diag.zig");

// The Windows appcast — the WinSparkle RSS feed, the `appcast-win.xml` twin of
// the macOS `appcast-zig.xml`, behind the same forever-URL `releases/latest`
// alias (resolves to the headline non-prerelease, so the live feed goes hot at
// graduation; the labs window proves the install path via a tagged/local feed).
const APPCAST_URL = "https://github.com/brueshi/Skrive/releases/latest/download/appcast-win.xml";
// The EdDSA public key — byte-identical to the macOS host's SUPublicEDKey
// (Info.plist). PUBLIC by design: it ships in the binary to verify updates;
// only its private half is a secret. noscan: known-safe public key.
const EDDSA_PUBKEY = "/Z4rW21cwvaAKKHcM1BBxY8P84PIuOAPw9hfQh/CYuA="; // noscan
const COMPANY_NAME = "Skrive";
const APP_NAME = "Skrive";
// Background-check cadence, matching the macOS host (SUScheduledCheckInterval).
const CHECK_INTERVAL_SECONDS: c_int = 86400;

// Hand-declared WinSparkle C ABI (all `__cdecl`). Only the entry points the
// host calls are declared.
const SetAppcastUrlFn = *const fn (url: [*:0]const u8) callconv(.c) void;
const SetEddsaPublicKeyFn = *const fn (pubkey: [*:0]const u8) callconv(.c) c_int;
const SetAppDetailsFn = *const fn (company: [*:0]const u16, app: [*:0]const u16, version: [*:0]const u16) callconv(.c) void;
const SetAutomaticCheckFn = *const fn (state: c_int) callconv(.c) void;
const SetIntervalFn = *const fn (interval: c_int) callconv(.c) void;
const InitFn = *const fn () callconv(.c) void;
const CheckWithUiFn = *const fn () callconv(.c) void;
const CleanupFn = *const fn () callconv(.c) void;

const Api = struct {
    set_appcast_url: SetAppcastUrlFn,
    set_eddsa_public_key: SetEddsaPublicKeyFn,
    set_app_details: SetAppDetailsFn,
    set_automatic_check_for_updates: SetAutomaticCheckFn,
    set_update_check_interval: SetIntervalFn,
    init: InitFn,
    check_update_with_ui: CheckWithUiFn,
    cleanup: CleanupFn,
};

/// Resolved on a successful init(); null until then (and if the DLL is
/// missing). `check()` and `shutdown()` no-op when null, so a host built/run
/// without WinSparkle.dll degrades to "no updater" rather than crashing.
var api: ?Api = null;

fn resolve(comptime T: type, dll: win32.HMODULE, name: [*:0]const u8) ?T {
    const proc = win32.GetProcAddress(dll, name) orelse return null;
    return @ptrCast(@alignCast(proc));
}

/// Configure + start WinSparkle. Call once from the UI thread after the window
/// exists. `version` is the running app's version (stamped from package.json via
/// the `-Dversion` build option); WinSparkle compares it against the appcast's
/// `sparkle:version`. Best-effort: a missing DLL or unresolved symbol logs (dev
/// builds) and leaves the updater disabled.
pub fn start(gpa: std.mem.Allocator, version: []const u8) void {
    const dll = win32.LoadLibraryW(std.unicode.utf8ToUtf16LeStringLiteral("WinSparkle.dll")) orelse {
        diag.log("WinSparkle.dll not found; updater disabled", .{});
        return;
    };
    const a: Api = .{
        .set_appcast_url = resolve(SetAppcastUrlFn, dll, "win_sparkle_set_appcast_url") orelse return logMissing(),
        .set_eddsa_public_key = resolve(SetEddsaPublicKeyFn, dll, "win_sparkle_set_eddsa_public_key") orelse return logMissing(),
        .set_app_details = resolve(SetAppDetailsFn, dll, "win_sparkle_set_app_details") orelse return logMissing(),
        .set_automatic_check_for_updates = resolve(SetAutomaticCheckFn, dll, "win_sparkle_set_automatic_check_for_updates") orelse return logMissing(),
        .set_update_check_interval = resolve(SetIntervalFn, dll, "win_sparkle_set_update_check_interval") orelse return logMissing(),
        .init = resolve(InitFn, dll, "win_sparkle_init") orelse return logMissing(),
        .check_update_with_ui = resolve(CheckWithUiFn, dll, "win_sparkle_check_update_with_ui") orelse return logMissing(),
        .cleanup = resolve(CleanupFn, dll, "win_sparkle_cleanup") orelse return logMissing(),
    };

    // All set_* calls MUST precede init().
    a.set_appcast_url(APPCAST_URL);
    if (a.set_eddsa_public_key(EDDSA_PUBKEY) == 0) {
        // 0 = the key was rejected (malformed); without a valid key WinSparkle
        // cannot verify a download, so it will refuse every update. Worth a
        // breadcrumb even though we still init (so Check-for-Updates at least
        // reports cleanly rather than silently doing nothing).
        diag.log("WinSparkle rejected the EdDSA public key", .{});
    }

    // App details want wchar_t*; company/app are static, version is runtime.
    const version_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, version) catch {
        diag.log("WinSparkle: version UTF-16 conversion failed", .{});
        return;
    };
    defer gpa.free(version_w); // WinSparkle copies the strings into std::wstring.
    a.set_app_details(
        std.unicode.utf8ToUtf16LeStringLiteral(COMPANY_NAME),
        std.unicode.utf8ToUtf16LeStringLiteral(APP_NAME),
        version_w,
    );

    // Silent background checks, matching the macOS host (no system profile is
    // ever sent — WinSparkle's no-telemetry default, consistent with Skrive's
    // posture).
    a.set_automatic_check_for_updates(1);
    a.set_update_check_interval(CHECK_INTERVAL_SECONDS);

    a.init();
    api = a;
    diag.log("WinSparkle initialized (version {s})", .{version});
}

/// The Settings "Check for updates" button — trigger WinSparkle's own dialog
/// (checks now, shows progress/no-update/up-to-date UI). No-op if uninitialized.
pub fn check() void {
    if (api) |a| a.check_update_with_ui();
}

/// Flush WinSparkle's background thread on shutdown. No-op if uninitialized.
pub fn shutdown() void {
    if (api) |a| a.cleanup();
}

fn logMissing() void {
    diag.log("WinSparkle: a required entry point is missing; updater disabled", .{});
}
