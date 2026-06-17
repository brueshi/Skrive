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
// file and its Io live here. Single-threaded harness, one core, one sink.
var stdout_file: std.Io.File = undefined;
var stdout_io: std.Io = undefined;

/// The emit sink: write the response envelope followed by a newline so the
/// runner can read one response per line. Unbuffered — each response is a
/// complete line the runner blocks on, so there is nothing to coalesce.
fn emit(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
    _ = userdata;
    const msg = std.mem.span(message_json);
    stdout_file.writeStreamingAll(stdout_io, msg) catch {};
    stdout_file.writeStreamingAll(stdout_io, "\n") catch {};
}

pub fn main(init: std.process.Init) !void {
    stdout_file = std.Io.File.stdout();
    stdout_io = init.io;

    // The harness uses the real process Io for filesystem work (the parity
    // corpus mutates a temp project on disk); the C-ABI path uses the
    // global single-threaded Io instead.
    const core = try core_mod.Core.create(init.io, emit, null);
    defer core.destroy();

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
