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
const watcher = @import("watcher.zig");
const fs = @import("fs.zig");

/// Core -> host callback. Matches `SkriveCoreEmit` in
/// `include/skrive_core.h`; the signatures are coupled by the round-trip
/// test, not by the compiler.
pub const Emit = ?*const fn (userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void;

pub const Core = struct {
    /// Long-lived state handed to every handler: the `Io` for filesystem
    /// work and the app-data dir (from `config_json`). In 0.16 every fs op
    /// takes an `Io`; the C ABI passes none, so the core holds one — the
    /// C-ABI `create` uses the global single-threaded Io (the documented
    /// library escape hatch: synchronous blocking fs on the calling thread,
    /// exactly Stage 2's model), the parity harness passes the real process
    /// Io. `app_data_dir` is c-allocator-owned, freed in `destroy`.
    ctx: dispatch.Context,
    emit: Emit,
    userdata: ?*anyopaque,
    /// The single watcher slot (Stage 3). The dispatcher reaches it through
    /// `ctx.watcher_ctl`; its emit bridge turns ProjectChanges into
    /// `project:change` event envelopes and hands them to `emit`.
    watcher_ctl: watcher.WatcherCtl,

    pub fn create(io: std.Io, app_data_dir: []const u8, emit: Emit, userdata: ?*anyopaque) !*Core {
        const core = try std.heap.c_allocator.create(Core);
        errdefer std.heap.c_allocator.destroy(core);
        const dir_copy = try std.heap.c_allocator.dupe(u8, app_data_dir);
        core.* = .{
            .ctx = .{ .io = io, .app_data_dir = dir_copy },
            .emit = emit,
            .userdata = userdata,
            .watcher_ctl = .{
                .gpa = std.heap.c_allocator,
                .active = null,
                .emit_fn = watcherEmitBridge,
                // Set below: the bridge needs the now-allocated core address.
                .emit_ctx = undefined,
            },
        };
        core.watcher_ctl.emit_ctx = core;
        core.ctx.watcher_ctl = &core.watcher_ctl;
        return core;
    }

    pub fn destroy(self: *Core) void {
        // Stop the watcher (joins its threads) before tearing down state it
        // emits through.
        self.watcher_ctl.stop();
        std.heap.c_allocator.free(self.ctx.app_data_dir);
        std.heap.c_allocator.destroy(self);
    }

    /// Handle one request envelope (a raw, non-NUL-terminated slice is
    /// fine) and emit the response through the registered callback. Runs
    /// inside its own arena, reset when the call returns.
    pub fn handle(self: *Core, request: []const u8) void {
        const emit = self.emit orelse return;
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const response = dispatch.dispatchJson(arena.allocator(), &self.ctx, request);
        emit(self.userdata, response.ptr);
    }
};

/// Bridge a watcher ProjectChange to the host as a `project:change` event
/// envelope. Runs on the watcher's poll thread, so it builds the JSON in its
/// own scratch arena (page-allocator backed, thread-safe) and hands the host
/// the NUL-terminated string; the host copies it (the delivery rule) and
/// marshals it to the UI thread.
fn watcherEmitBridge(ctx: ?*anyopaque, kind: watcher.ChangeKind, rel: []const u8) void {
    const core: *Core = @ptrCast(@alignCast(ctx.?));
    const emit_cb = core.emit orelse return;
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rel_json = fs.jsonString(a, rel) catch return;
    const json = std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":1,\"event\":\"project:change\",\"payload\":{{\"kind\":\"{s}\",\"path\":{s}}}}}",
        .{ kind.wireName(), rel_json },
        0,
    ) catch return;
    emit_cb(core.userdata, json.ptr);
}

// ---- C ABI ----------------------------------------------------------------

export fn skrive_core_create(
    config_json: ?[*:0]const u8,
    emit: Emit,
    userdata: ?*anyopaque,
) callconv(.c) ?*Core {
    const io = std.Io.Threaded.global_single_threaded.io();
    // config_json carries the app-data dir (persistence) — parse it in a
    // scratch arena; Core.create copies the dir into long-lived storage.
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const app_data_dir = parseAppDataDir(arena.allocator(), config_json);
    return Core.create(io, app_data_dir, emit, userdata) catch null;
}

/// Extract `appDataDir` from the config JSON, or "" if absent/malformed.
fn parseAppDataDir(a: std.mem.Allocator, config_json: ?[*:0]const u8) []const u8 {
    const cfg = config_json orelse return "";
    const parsed = std.json.parseFromSlice(std.json.Value, a, std.mem.span(cfg), .{}) catch return "";
    if (parsed.value != .object) return "";
    return switch (parsed.value.object.get("appDataDir") orelse return "") {
        .string => |s| s,
        else => "",
    };
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
