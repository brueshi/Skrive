//! Skrive Zig core — the Part I C ABI surface.
//!
//! A host creates a core with an `emit` callback, hands it request
//! envelopes as JSON strings, and the core replies through `emit` with
//! response envelopes. The actual command handling lives in `dispatch.zig`
//! (the comptime command table) and `errors.zig` (the one-place
//! error->code mapping); this file is just the boundary.
//!
//! Two entry points share one `Core.handle`:
//!   - `skrive_core_handle` (the C ABI) spans the caller's C string.
//!   - `fixture_main.zig` (the parity harness) passes a stdin line slice
//!     directly — the C-string marshaling is a trivial `std.mem.span`, not
//!     worth re-exercising per line, so both funnel into the same
//!     dispatch + emit path.
//!
//! Memory model: the long-lived `Core` struct is C-allocated; each
//! `handle` call runs inside its own arena that is reset when the call
//! returns. The response string lives in that arena and is only valid for
//! the duration of the `emit` call — the host copies anything it keeps
//! (WKWebView's `evaluateJavaScript` copies the script synchronously).

const std = @import("std");
const dispatch = @import("dispatch.zig");

/// Core -> host callback. Matches `SkriveCoreEmit` in
/// `include/skrive_core.h`; the signatures are coupled by the round-trip
/// test, not by the compiler.
pub const Emit = ?*const fn (userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void;

pub const Core = struct {
    /// The Io the dispatcher's filesystem work runs on. In 0.16 every
    /// fs operation takes an `Io`; the C ABI passes none, so the core
    /// holds one. The C-ABI `create` uses the global single-threaded Io
    /// (the documented library escape hatch — synchronous blocking fs on
    /// the calling thread, which is exactly Stage 2's model); the parity
    /// harness passes the real process Io. If the core ever moves to a
    /// thread pool (Part I), an owned `Threaded` + host emit-marshaling
    /// replaces this.
    io: std.Io,
    emit: Emit,
    userdata: ?*anyopaque,

    pub fn create(io: std.Io, emit: Emit, userdata: ?*anyopaque) !*Core {
        const core = try std.heap.c_allocator.create(Core);
        core.* = .{ .io = io, .emit = emit, .userdata = userdata };
        return core;
    }

    pub fn destroy(self: *Core) void {
        std.heap.c_allocator.destroy(self);
    }

    /// Handle one request envelope (a raw, non-NUL-terminated slice is
    /// fine) and emit the response through the registered callback. Runs
    /// inside its own arena, reset when the call returns.
    pub fn handle(self: *Core, request: []const u8) void {
        const emit = self.emit orelse return;
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const response = dispatch.dispatchJson(arena.allocator(), self.io, request);
        emit(self.userdata, response.ptr);
    }
};

// ---- C ABI ----------------------------------------------------------------

export fn skrive_core_create(
    config_json: ?[*:0]const u8,
    emit: Emit,
    userdata: ?*anyopaque,
) callconv(.c) ?*Core {
    // config_json carries the app-data dir / markup extension set,
    // consumed once the persistence namespace lands (2.4). fs work runs
    // on the global single-threaded Io (see Core.io).
    _ = config_json;
    const io = std.Io.Threaded.global_single_threaded.io();
    return Core.create(io, emit, userdata) catch null;
}

export fn skrive_core_destroy(core_opt: ?*Core) callconv(.c) void {
    const core = core_opt orelse return;
    core.destroy();
}

export fn skrive_core_handle(
    core_opt: ?*Core,
    request_json: ?[*:0]const u8,
) callconv(.c) void {
    const core = core_opt orelse return;
    const req = request_json orelse return;
    core.handle(std.mem.span(req));
}

// ---- tests ----------------------------------------------------------------
// The C-ABI round-trip: that `create` / `handle` / `destroy` and the
// `emit` callback are wired correctly. The envelope-validation matrix is
// tested in dispatch.zig against `dispatchJson` directly.

const TestSink = struct {
    buf: [1024]u8 = undefined,
    len: usize = 0,

    fn record(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
        const self: *TestSink = @ptrCast(@alignCast(userdata.?));
        const msg = std.mem.span(message_json);
        @memcpy(self.buf[0..msg.len], msg);
        self.len = msg.len;
    }

    fn captured(self: *const TestSink) []const u8 {
        return self.buf[0..self.len];
    }
};

test "app:version round-trips through the C ABI" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "{\"v\":1,\"id\":42,\"cmd\":\"app:version\",\"payload\":{}}");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"id\":42") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "0.1.0-zig-spike") != null);
}

test "unknown command returns UNKNOWN_COMMAND with the echoed id" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "{\"v\":1,\"id\":7,\"cmd\":\"nope:never\",\"payload\":{}}");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"id\":7") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "UNKNOWN_COMMAND") != null);
}

test "malformed JSON returns BAD_ENVELOPE" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "not json at all");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "BAD_ENVELOPE") != null);
}
