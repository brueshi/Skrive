//! Robust file diagnostics for Windows bring-up. stderr is unreliable from a
//! GUI-launched process (the macOS host learned the same and moved to a file
//! logger), so this appends to `skrive-diag.log` in the working directory via
//! libc fopen/fwrite — always-on, independent of how the exe was launched.
//! Stage 5.1 bring-up scaffolding; trimmed once first light is green.

const std = @import("std");

extern fn fopen(path: [*:0]const u8, mode: [*:0]const u8) callconv(.c) ?*anyopaque;
extern fn fwrite(ptr: [*]const u8, size: usize, count: usize, stream: *anyopaque) callconv(.c) usize;
extern fn fclose(stream: *anyopaque) callconv(.c) c_int;

pub fn log(comptime fmt: []const u8, args: anytype) void {
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
