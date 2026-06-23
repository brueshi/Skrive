//! Skrive Windows host entry point.
//!
//! Thin: build the App (window + Zig core + WebView2) and pump the message
//! loop. Everything else lives in app.zig (orchestration), webview2.zig (the
//! hand-declared COM ABI), handlers.zig (the COM callback objects), win32.zig
//! (the Win32 surface), and jsescape.zig (the delivery-rule escaper).
//!
//! Console subsystem for now, so startup/HRESULT diagnostics are visible when
//! run from a terminal on Windows; Stage 5.1's gate uses them. A windowed
//! (no-console) subsystem is a packaging detail for 5.3.

const std = @import("std");
const App = @import("app.zig").App;

pub fn main() !void {
    const app = App.create(std.heap.c_allocator) catch |err| {
        std.debug.print("[skrive] startup failed: {s}\n", .{@errorName(err)});
        return err;
    };
    app.run();
}
