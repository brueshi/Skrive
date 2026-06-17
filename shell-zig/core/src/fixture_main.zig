//! Parity-fixture harness (Stage 2.1).
//!
//! Reads one request-envelope JSON per line on stdin and writes one
//! response-envelope JSON per line on stdout — the foreign-dispatcher
//! contract in `shell-zig/fixtures/README.md` that
//! `scripts/run-parity-fixtures.ts --exec` drives. It funnels every line
//! through the same `Core.handle` the macOS host's C ABI uses, so the
//! bytes it emits are the bytes the host would receive.
//!
//! Run via the parity runner:
//!   bun run parity:check -- --exec "shell-zig/core/zig-out/bin/fixture_main"

const std = @import("std");
const core_mod = @import("skrive_core.zig");
const dispatch = @import("dispatch.zig");

// stdout is process-global; the C-convention `emit` callback has no way to
// thread context other than the `userdata` pointer, so the destination
// file, its Io, and the core live here. Single-threaded harness, one core,
// one sink.
var stdout_file: std.Io.File = undefined;
var stdout_io: std.Io = undefined;
var core_ptr: *core_mod.Core = undefined;

/// The emit sink. Host-command envelopes (the `host:` channel) are played
/// by the harness standing in for the OS host; everything else is a
/// renderer-bound response written as one line for the runner to read.
fn emit(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
    _ = userdata;
    const msg = std.mem.span(message_json);
    if (playHostCommand(msg)) return;
    stdout_file.writeStreamingAll(stdout_io, msg) catch {};
    stdout_file.writeStreamingAll(stdout_io, "\n") catch {};
}

/// If `msg` is a `host:` command envelope, perform it and reply on the
/// host channel (the core turns the reply into the deferred response).
/// Returns true when handled. There is no OS trash in a test, so `trash`
/// is a plain delete. Reentering `core.handle` here is safe: each call has
/// its own arena and the core holds no per-request state.
fn playHostCommand(msg: []const u8) bool {
    // Cheap guard so normal responses (which can be large) aren't parsed.
    if (!std.mem.startsWith(u8, msg, "{\"v\":1,\"host\":")) return false;

    var buf: [64 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    const a = fba.allocator();
    const parsed = std.json.parseFromSlice(std.json.Value, a, msg, .{}) catch return false;
    const obj = switch (parsed.value) {
        .object => |o| o,
        else => return false,
    };
    const host = switch (obj.get("host") orelse return false) {
        .string => |s| s,
        else => return false,
    };
    if (!std.mem.eql(u8, host, "trash")) return false;
    const id = switch (obj.get("id") orelse return false) {
        .integer => |n| n,
        else => return false,
    };
    const target = switch (obj.get("path") orelse return false) {
        .string => |s| s,
        else => return false,
    };

    const ok = deletePath(target);
    var rbuf: [128]u8 = undefined;
    const reply = std.fmt.bufPrint(
        &rbuf,
        "{{\"v\":1,\"host\":\"result\",\"id\":{d},\"ok\":{}}}",
        .{ id, ok },
    ) catch return true;
    core_ptr.handle(reply);
    return true;
}

fn deletePath(p: []const u8) bool {
    const dir = std.Io.Dir.cwd();
    if (dir.deleteFile(stdout_io, p)) |_| {
        return true;
    } else |err| switch (err) {
        error.IsDir => {},
        else => return false,
    }
    dir.deleteTree(stdout_io, p) catch return false;
    return true;
}

pub fn main(init: std.process.Init) !void {
    stdout_file = std.Io.File.stdout();
    stdout_io = init.io;

    // The harness uses the real process Io for filesystem work (the parity
    // corpus mutates a temp project on disk); the C-ABI path uses the
    // global single-threaded Io instead.
    const core = try core_mod.Core.create(init.io, emit, null);
    defer core.destroy();
    // Visible to the emit callback so it can reply on the host channel.
    core_ptr = core;

    // The PAYLOAD_TOO_LARGE fixture sends a request just over the 32 MiB
    // cap on a single line. `takeDelimiter` returns the whole line from the
    // reader's buffer, so the buffer must exceed the largest possible line
    // (cap + small JSON framing + newline); 1 MiB of headroom is ample. An
    // oversize line then reaches the dispatcher and is rejected there with
    // PAYLOAD_TOO_LARGE, which is exactly what the fixture asserts.
    const buf = try init.gpa.alloc(u8, dispatch.MAX_REQUEST_BYTES + (1 << 20));
    defer init.gpa.free(buf);

    var reader = std.Io.File.stdin().reader(init.io, buf);
    const r = &reader.interface;
    while (try r.takeDelimiter('\n')) |line| {
        core.handle(line);
    }
}
