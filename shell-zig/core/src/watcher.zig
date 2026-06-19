//! Filesystem watcher: the Zig wrapper over the vendored e-dant/watcher C
//! ABI (vendor/watcher). Stage 3 turns raw watcher-c events into the
//! `project:change` envelopes the renderer already consumes from the Electron
//! shell's chokidar.
//!
//! Stage 3.1 (this file, so far): the C-ABI bindings and a live smoke test
//! proving the vendored backend compiles, links, and reports events. The
//! event translation, the chokidar-style path filter, and the write-finish
//! debounce land in 3.2; the dispatch wiring (`project:watch`/`unwatch`) in
//! 3.3.
//!
//! Threading note for later stages: watcher-c invokes the callback on its own
//! backend thread (FSEvents/libdispatch on macOS), and the event's string
//! pointers are only valid for the duration of that call — any path kept past
//! the callback must be copied immediately.

const std = @import("std");
const Dir = std.Io.Dir;

/// The pure-C ABI from `vendor/watcher/include/wtr/watcher-c.h`. The struct
/// layout and function signatures are coupled to that header by the C ABI,
/// not by the compiler — keep them in lockstep when re-vendoring.
pub const c = struct {
    /// Mirrors `struct wtr_watcher_event`. Field order and types are
    /// load-bearing: this is passed by value across the C ABI.
    pub const Event = extern struct {
        effect_time: i64,
        path_name: [*:0]const u8,
        /// Non-null only for rename pairs (the rename's other half).
        associated_path_name: ?[*:0]const u8,
        effect_type: i8,
        path_type: i8,
    };

    pub const Callback = *const fn (event: Event, context: ?*anyopaque) callconv(.c) void;

    pub extern fn wtr_watcher_open(
        path: [*:0]const u8,
        callback: Callback,
        context: ?*anyopaque,
    ) ?*anyopaque;

    pub extern fn wtr_watcher_close(watcher: ?*anyopaque) bool;

    // effect_type values (what happened to the path).
    pub const EFFECT_RENAME: i8 = 0;
    pub const EFFECT_MODIFY: i8 = 1;
    pub const EFFECT_CREATE: i8 = 2;
    pub const EFFECT_DESTROY: i8 = 3;
    pub const EFFECT_OWNER: i8 = 4;
    pub const EFFECT_OTHER: i8 = 5;

    // path_type values (what kind of path it is).
    pub const PATH_DIR: i8 = 0;
    pub const PATH_FILE: i8 = 1;
    pub const PATH_HARD_LINK: i8 = 2;
    pub const PATH_SYM_LINK: i8 = 3;
    pub const PATH_WATCHER: i8 = 4;
    pub const PATH_OTHER: i8 = 5;
};

// ---- tests ----------------------------------------------------------------
// A live smoke test: open a watcher on a temp dir, create a file, and confirm
// the vendored backend delivers a CREATE event for it within a budget. This
// is the 3.1 acceptance gate — it proves the C++ TU compiled, libc++ and the
// FSEvents frameworks linked, and the callback fires on real filesystem
// activity. Translation correctness is tested in 3.2.

const SmokeCtx = struct {
    // Written from the watcher's backend thread, read from the test thread;
    // a lock-free flag is all the synchronization a one-shot needs.
    saw_create: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
};

fn smokeCallback(event: c.Event, context: ?*anyopaque) callconv(.c) void {
    const ctx: *SmokeCtx = @ptrCast(@alignCast(context.?));
    const name = std.mem.span(event.path_name);
    if (event.effect_type == c.EFFECT_CREATE and
        std.mem.indexOf(u8, name, "smoke.md") != null)
    {
        ctx.saw_create.store(true, .release);
    }
}

test "watcher-c delivers a create event for a new file" {
    const a = std.testing.allocator;
    const io = std.Io.Threaded.global_single_threaded.io();

    // A fresh, empty dir under cwd so only our own mutation fires. Its
    // canonical absolute path (NUL-terminated) is exactly what FSEvents
    // reports back and what wtr_watcher_open wants.
    const dir_name = "watcher_smoke_test_dir";
    Dir.cwd().createDir(io, dir_name, .default_dir) catch |e| switch (e) {
        error.PathAlreadyExists => {},
        else => return e,
    };
    defer Dir.cwd().deleteTree(io, dir_name) catch {};

    const watch_abs = try Dir.cwd().realPathFileAlloc(io, dir_name, a);
    defer a.free(watch_abs);

    var ctx = SmokeCtx{};
    const w = c.wtr_watcher_open(watch_abs.ptr, smokeCallback, &ctx) orelse
        return error.WatcherOpenFailed;

    // Let the backend settle before mutating, then create the file.
    try std.Io.sleep(io, .fromMilliseconds(150), .awake);
    try Dir.cwd().writeFile(io, .{ .sub_path = dir_name ++ "/smoke.md", .data = "" });

    // Poll up to ~3s for the event — FSEvents has inherent latency.
    var waited_ms: usize = 0;
    const saw = while (waited_ms < 3000) : (waited_ms += 25) {
        try std.Io.sleep(io, .fromMilliseconds(25), .awake);
        if (ctx.saw_create.load(.acquire)) break true;
    } else false;

    try std.testing.expect(c.wtr_watcher_close(w));
    try std.testing.expect(saw);
}
