//! Skrive Zig core — Stage 1 spike.
//!
//! This is the smallest thing that satisfies the Part I C ABI: a host
//! creates a core with an `emit` callback, hands it request envelopes as
//! JSON strings, and the core replies through `emit` with response
//! envelopes. Only `app:version` is implemented; every other command
//! returns UNKNOWN_COMMAND. Stage 2 replaces `buildResponse` with the
//! real comptime command table without changing this ABI.
//!
//! Memory model (the skeleton Stage 2 hardens): the long-lived core
//! struct is C-allocated; each `handle` call runs inside its own arena
//! that is reset when the call returns. The response string lives in
//! that arena and is only valid for the duration of the `emit` call —
//! the host must copy anything it keeps, which it does (WKWebView's
//! evaluateJavaScript copies the script synchronously).

const std = @import("std");

/// Identifies a build from the Zig core specifically, so the round-trip
/// is visible by eye in the running UI (it differs from the Electron
/// shell's version) — this is the Stage 1.1 done-criterion made legible.
const CORE_VERSION = "0.1.0-zig-spike";

const ENVELOPE_VERSION = 1;

/// Adversarial body the 1.4 injection check round-trips through the real
/// delivery path: core JSON-encode -> JSEscape (JS string literal) ->
/// window.__skriveDispatch -> renderer JSON.parse. Every byte must arrive
/// intact and none of it may execute. Contains a script-tag breakout, a
/// backtick + ${} template trap, a quote, a backslash, a newline, and
/// U+2028/U+2029 (the line terminators that historically broke JS string
/// literals).
const POISON_BODY =
    "</script><script>window.__pwned=1</script>" ++
    "`${alert(1)}`" ++
    "\"\\\n" ++
    "\u{2028}\u{2029}";

/// Core -> host callback. Matches `SkriveCoreEmit` in
/// `include/skrive_core.h`; the signatures are coupled by the round-trip
/// test, not by the compiler.
pub const Emit = ?*const fn (userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void;

const Core = struct {
    emit: Emit,
    userdata: ?*anyopaque,
};

export fn skrive_core_create(
    config_json: ?[*:0]const u8,
    emit: Emit,
    userdata: ?*anyopaque,
) callconv(.c) ?*Core {
    // config_json carries the app-data dir / markup extension set in
    // Stage 2; the spike has no long-lived state to configure.
    _ = config_json;
    const core = std.heap.c_allocator.create(Core) catch return null;
    core.* = .{ .emit = emit, .userdata = userdata };
    return core;
}

export fn skrive_core_destroy(core_opt: ?*Core) callconv(.c) void {
    const core = core_opt orelse return;
    std.heap.c_allocator.destroy(core);
}

export fn skrive_core_handle(
    core_opt: ?*Core,
    request_json: ?[*:0]const u8,
) callconv(.c) void {
    const core = core_opt orelse return;
    const emit = core.emit orelse return;
    const req = request_json orelse return;

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const response = buildResponse(a, std.mem.span(req)) catch {
        // Any internal failure (parse error, OOM) falls back to a coded
        // error with id 0 — no valid id is recoverable here. The literal
        // is statically NUL-terminated.
        emit(core.userdata, internal_error);
        return;
    };
    emit(core.userdata, response.ptr);
}

const internal_error: [*:0]const u8 =
    "{\"v\":1,\"id\":0,\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"core failure\"}}";

/// Two-stage parse per the conventions: the envelope is parsed
/// dynamically to recover `id` and `cmd`, then each command owns its
/// typed payload (none needed for app:version). Returns a
/// NUL-terminated response envelope allocated in `a`.
fn buildResponse(a: std.mem.Allocator, request: []const u8) ![:0]const u8 {
    const parsed = std.json.parseFromSlice(std.json.Value, a, request, .{}) catch {
        return badEnvelope(a, 0);
    };
    const root = parsed.value;
    if (root != .object) return badEnvelope(a, 0);

    const id = blk: {
        const v = root.object.get("id") orelse break :blk @as(i64, 0);
        break :blk switch (v) {
            .integer => |n| n,
            else => @as(i64, 0),
        };
    };

    const cmd = blk: {
        const v = root.object.get("cmd") orelse return badEnvelope(a, id);
        break :blk switch (v) {
            .string => |s| s,
            else => return badEnvelope(a, id),
        };
    };

    if (std.mem.eql(u8, cmd, "app:version")) {
        return std.fmt.allocPrintSentinel(
            a,
            "{{\"v\":{d},\"id\":{d},\"ok\":true,\"result\":{{\"version\":\"{s}\"}}}}",
            .{ ENVELOPE_VERSION, id, CORE_VERSION },
            0,
        );
    }

    if (std.mem.eql(u8, cmd, "diag:poison")) {
        return buildPoison(a, id);
    }

    // Unknown command. The message is intentionally static — the spike
    // never interpolates the (attacker-influenced) cmd into JSON until
    // the Stage 2 dispatcher escapes it properly.
    return std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":{d},\"id\":{d},\"ok\":false,\"error\":{{\"code\":\"UNKNOWN_COMMAND\",\"message\":\"command not implemented in the Stage 1 core\"}}}}",
        .{ ENVELOPE_VERSION, id },
        0,
    );
}

/// Build the diag:poison response: the adversarial body, JSON-encoded.
/// This is the core's serialization layer (escapes the structural bytes);
/// JSEscape adds the JS-string layer on the Swift side. U+2028/U+2029 are
/// valid raw in JSON, so they pass through here as their UTF-8 bytes.
fn buildPoison(a: std.mem.Allocator, id: i64) ![:0]const u8 {
    var buf: [256]u8 = undefined;
    var len: usize = 0;
    for (POISON_BODY) |c| {
        switch (c) {
            '"' => {
                buf[len] = '\\';
                buf[len + 1] = '"';
                len += 2;
            },
            '\\' => {
                buf[len] = '\\';
                buf[len + 1] = '\\';
                len += 2;
            },
            '\n' => {
                buf[len] = '\\';
                buf[len + 1] = 'n';
                len += 2;
            },
            else => {
                if (c < 0x20) {
                    const hex = "0123456789abcdef";
                    buf[len] = '\\';
                    buf[len + 1] = 'u';
                    buf[len + 2] = '0';
                    buf[len + 3] = '0';
                    buf[len + 4] = hex[(c >> 4) & 0xf];
                    buf[len + 5] = hex[c & 0xf];
                    len += 6;
                } else {
                    buf[len] = c;
                    len += 1;
                }
            },
        }
    }
    return std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":{d},\"id\":{d},\"ok\":true,\"result\":{{\"body\":\"{s}\"}}}}",
        .{ ENVELOPE_VERSION, id, buf[0..len] },
        0,
    );
}

fn badEnvelope(a: std.mem.Allocator, id: i64) ![:0]const u8 {
    return std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":{d},\"id\":{d},\"ok\":false,\"error\":{{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}}}",
        .{ ENVELOPE_VERSION, id },
        0,
    );
}

// ---- tests ----------------------------------------------------------------

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

    skrive_core_handle(core, "{\"v\":1,\"id\":42,\"cmd\":\"app:version\"}");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"id\":42") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"ok\":true") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), CORE_VERSION) != null);
}

test "unknown command returns UNKNOWN_COMMAND with the echoed id" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "{\"v\":1,\"id\":7,\"cmd\":\"fs:readFile\"}");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "\"id\":7") != null);
    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "UNKNOWN_COMMAND") != null);
}

test "diag:poison JSON-encodes the adversarial body" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "{\"v\":1,\"id\":9,\"cmd\":\"diag:poison\"}");
    const out = sink.captured();

    try std.testing.expect(std.mem.indexOf(u8, out, "\"ok\":true") != null);
    // The script breakout is present literally (the core does not escape
    // `<`; that is JSEscape's job on the Swift side).
    try std.testing.expect(std.mem.indexOf(u8, out, "</script>") != null);
    // The quote and backslash are JSON-escaped by the core.
    try std.testing.expect(std.mem.indexOf(u8, out, "\\\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, out, "\\\\") != null);
}

test "malformed JSON returns BAD_ENVELOPE" {
    var sink = TestSink{};
    const core = skrive_core_create(null, TestSink.record, &sink).?;
    defer skrive_core_destroy(core);

    skrive_core_handle(core, "not json at all");

    try std.testing.expect(std.mem.indexOf(u8, sink.captured(), "BAD_ENVELOPE") != null);
}
