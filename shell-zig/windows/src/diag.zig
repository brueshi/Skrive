//! Robust file diagnostics for Windows bring-up. stderr is unreliable from a
//! GUI-launched process (the macOS host learned the same and moved to a file
//! logger), so this appends to `skrive-diag.log` in the working directory via
//! libc fopen/fwrite, independent of how the exe was launched.
//!
//! Gated by the `dev` build option: in a shipped release (`dev == false`)
//! every `log()` call compiles to nothing, so no `skrive-diag.log` is written
//! next to the exe on a user's machine. Build `-Ddev=true` to force it on for
//! release triage.

const std = @import("std");
const dev = @import("build_options").dev;

extern fn fopen(path: [*:0]const u8, mode: [*:0]const u8) callconv(.c) ?*anyopaque;
extern fn fwrite(ptr: [*]const u8, size: usize, count: usize, stream: *anyopaque) callconv(.c) usize;
extern fn fclose(stream: *anyopaque) callconv(.c) c_int;

pub fn log(comptime fmt: []const u8, args: anytype) void {
    if (!dev) return;
    var buf: [2048]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, fmt ++ "\n", args) catch return;
    const f = fopen("skrive-diag.log", "ab") orelse return;
    defer _ = fclose(f);
    _ = fwrite(line.ptr, 1, line.len, f);
}

/// HRESULT as the conventional 0x-prefixed 8-hex-digit form.
pub fn hx(hr: i32) u32 {
    return @bitCast(hr);
}
