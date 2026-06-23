//! Skrive Windows host entry point.
//!
//! Thin: build the App (window + Zig core + WebView2) and pump the message
//! loop. Everything else lives in app.zig (orchestration), webview2.zig (the
//! hand-declared COM ABI), handlers.zig (the COM callback objects), win32.zig
//! (the Win32 surface), and jsescape.zig (the delivery-rule escaper).
//!
//! GUI subsystem (build.zig sets `exe.subsystem = .Windows`), so no console
//! flashes on launch. Zig's WinMainCRTStartup shim still calls this `main`.
//! Because there is no console, a startup failure can't print to stderr — it
//! surfaces via a MessageBox instead (parity with the macOS host's
//! presentFatal NSAlert). In-flight diagnostics still go to skrive-diag.log
//! in dev builds (diag.zig).

const std = @import("std");
const win32 = @import("win32.zig");
const App = @import("app.zig").App;

pub fn main() !void {
    // Single instance: a second launch exits immediately. (argv-forward /
    // file-open hand-off to the running instance is deferred — it pairs with
    // file associations, a net-new feature.)
    const mutex_name = std.unicode.utf8ToUtf16LeStringLiteral("Local\\Skrive-SingleInstance");
    _ = win32.CreateMutexW(null, 0, mutex_name);
    if (win32.GetLastError() == win32.ERROR_ALREADY_EXISTS) return;

    const app = App.create(std.heap.c_allocator) catch |err| {
        fatal("Skrive failed to start: {s}", .{@errorName(err)});
        return err;
    };
    app.run();
}

/// Report a fatal startup error in a modal box (stderr is invisible under the
/// GUI subsystem). Best-effort: if formatting or the UTF-16 conversion fails,
/// the process still exits with the propagated error.
fn fatal(comptime fmt: []const u8, args: anytype) void {
    var buf: [512]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, fmt, args) catch "Skrive failed to start.";
    var wbuf: [512]u16 = undefined;
    const n = std.unicode.utf8ToUtf16Le(&wbuf, msg) catch return;
    wbuf[n] = 0;
    const caption = std.unicode.utf8ToUtf16LeStringLiteral("Skrive");
    _ = win32.MessageBoxW(null, wbuf[0..n :0].ptr, caption, win32.MB_OK | win32.MB_ICONERROR);
}
