//! Filesystem watcher: the Zig wrapper over the vendored e-dant/watcher C
//! ABI (vendor/watcher). Turns raw watcher-c events into the `project:change`
//! shape the renderer already consumes from the Electron shell's chokidar
//! (`add`/`change`/`unlink`/`addDir`/`unlinkDir`).
//!
//! Parity reference: `shell/src/ipc/project.ts` (the chokidar setup) and
//! `app/src/stores/project.ts` (the consumer). Two things are matched
//! deliberately rather than improved:
//!   - The path filter mirrors chokidar's `ignored` predicate exactly (noise
//!     dirs, hidden dirs, non-markdown files except a root `.skrive.toml`) —
//!     NOT the snapshot walker's slightly different dot-file rule.
//!   - Self-writes are NOT suppressed here. The Electron shell forwards every
//!     event faithfully and the renderer dedups via content hash
//!     (`fs.detectExternalChange` against the tab's `diskHash`); the Zig core
//!     emits faithfully too.
//!
//! Write-finish stabilization (chokidar's `awaitWriteFinish`, which watcher-c
//! does not provide) is rebuilt here: an `add`/`change` on a file is held
//! until its size+mtime are unchanged for STABILITY_MS, polled every
//! POLL_MS. The values match the Electron shell (`project.ts`: 80ms / 30ms).
//! `unlink` and directory events are emitted immediately.
//!
//! Threading. watcher-c invokes the C callback on its own backend thread
//! (FSEvents/libdispatch on macOS). A dedicated poll thread owns the
//! stabilization timing. All access to the shared queue + pending map is
//! serialized by one mutex, so a non-thread-safe allocator is race-free; the
//! event's string pointers are only valid during the callback, so paths are
//! copied immediately. The emit callback is therefore invoked from the poll
//! thread — the host marshals it to the UI thread (Stage 3.4).

const std = @import("std");
const project = @import("project.zig");

const Dir = std.Io.Dir;
const Io = std.Io;

/// chokidar `awaitWriteFinish` equivalents, copied from the Electron shell.
const STABILITY_MS: u32 = 80;
const POLL_MS: u32 = 30;

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

/// The renderer-facing change kinds (the `ProjectChange.kind` union in
/// `shared/src/ipc-contracts.ts`).
pub const ChangeKind = enum {
    add,
    change,
    unlink,
    add_dir,
    unlink_dir,

    pub fn wireName(self: ChangeKind) []const u8 {
        return switch (self) {
            .add => "add",
            .change => "change",
            .unlink => "unlink",
            .add_dir => "addDir",
            .unlink_dir => "unlinkDir",
        };
    }
};

/// Called when a translated, stabilized change is ready to emit. `rel_path`
/// is project-relative, forward-slash separated, and valid only for the
/// duration of the call (copy what you keep). Invoked from the poll thread.
pub const EmitFn = *const fn (ctx: ?*anyopaque, kind: ChangeKind, rel_path: []const u8) void;

// ---- path filter (chokidar `ignored` parity) ------------------------------

/// True if chokidar's `ignored` predicate would drop this path: any ancestor
/// segment is a noise dir or a hidden dir, the leaf is a noise dir, a hidden
/// leaf directory, or a non-markdown file other than a root `.skrive.toml`.
fn shouldIgnore(rel: []const u8, is_dir: bool) bool {
    // Ancestor segments are all directories on the path; a noise/hidden one
    // excludes the whole subtree (chokidar applies `ignored` per level).
    var idx: usize = 0;
    while (std.mem.indexOfScalarPos(u8, rel, idx, '/')) |slash| {
        const seg = rel[idx..slash];
        if (project.isNoiseDir(seg)) return true;
        if (seg.len > 0 and seg[0] == '.') return true;
        idx = slash + 1;
    }
    const base = rel[idx..];
    if (project.isNoiseDir(base)) return true;
    if (is_dir) return base.len > 0 and base[0] == '.';
    // File: keep markdown, and the root config file the watcher rescans on;
    // drop everything else. The root-only check matches the oracle's
    // `resolve(target) === resolve(root, '.skrive.toml')`.
    if (project.isMarkdown(base)) return false;
    if (std.mem.eql(u8, rel, ".skrive.toml")) return false;
    return true;
}

/// Project-relative path for an absolute path under `root` (which carries no
/// trailing slash), or null if the path is the root itself or outside it. On
/// macOS the separator is already `/`; Windows normalization comes with the
/// Stage 5 host.
fn relFromAbs(root: []const u8, abs: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, abs, root)) return null;
    if (abs.len == root.len) return null;
    if (abs[root.len] != '/') return null;
    const rel = abs[root.len + 1 ..];
    if (rel.len == 0) return null;
    return rel;
}

// ---- the watcher ----------------------------------------------------------

const RawKind = enum { add_file, change_file, unlink_file, add_dir, unlink_dir };

/// A translated event waiting to be processed by the poll thread. `rel` is
/// owned by the watcher allocator; the poll thread frees it or transfers it
/// into the pending map.
const RawEvent = struct { kind: RawKind, rel: []const u8 };

const Stat = struct { size: u64, mtime_ns: i128 };

/// A file `add`/`change` held for write-finish stabilization. `kind` is only
/// `.add` or `.change`; a `.add` that gets deleted before stabilizing is a
/// transient file and emits nothing.
const Pending = struct { kind: ChangeKind, baseline: ?Stat, stable_ms: u32 };

pub const Watcher = struct {
    gpa: std.mem.Allocator,
    io: Io,
    /// Canonical absolute root, no trailing slash (owned).
    root: []const u8,
    /// NUL-terminated root for the C ABI (owned).
    root_z: [:0]const u8,
    emit_fn: EmitFn,
    emit_ctx: ?*anyopaque,

    /// Guards `queue` and `pending` and serializes every allocator op so a
    /// non-thread-safe allocator stays race-free across the callback thread
    /// and the poll thread.
    mutex: Io.Mutex,
    queue: std.ArrayList(RawEvent),
    pending: std.StringHashMapUnmanaged(Pending),

    running: std.atomic.Value(bool),
    thread: ?std.Thread,
    handle: ?*anyopaque,

    /// Start watching `root_abs`. Spawns the poll thread and opens the C
    /// backend; events begin flowing through `emit_fn` after this returns.
    pub fn open(
        gpa: std.mem.Allocator,
        io: Io,
        root_abs: []const u8,
        emit_fn: EmitFn,
        emit_ctx: ?*anyopaque,
    ) !*Watcher {
        const self = try gpa.create(Watcher);
        errdefer gpa.destroy(self);

        const root_owned = try gpa.dupe(u8, std.mem.trimEnd(u8, root_abs, "/"));
        errdefer gpa.free(root_owned);
        const root_z = try gpa.dupeZ(u8, root_owned);
        errdefer gpa.free(root_z);

        self.* = .{
            .gpa = gpa,
            .io = io,
            .root = root_owned,
            .root_z = root_z,
            .emit_fn = emit_fn,
            .emit_ctx = emit_ctx,
            .mutex = .init,
            .queue = .empty,
            .pending = .empty,
            .running = .init(true),
            .thread = null,
            .handle = null,
        };

        // Poll thread before the backend: events that arrive immediately just
        // queue until the first tick.
        self.thread = try std.Thread.spawn(.{}, pollLoop, .{self});
        errdefer {
            self.running.store(false, .release);
            self.thread.?.join();
        }

        self.handle = c.wtr_watcher_open(self.root_z, cCallback, self) orelse
            return error.WatcherOpenFailed;
        return self;
    }

    /// Stop watching and free everything. Stops the backend first (no more
    /// callbacks), then joins the poll thread, then drains state — so the
    /// final teardown runs with no other thread touching the watcher.
    pub fn close(self: *Watcher) void {
        if (self.handle) |h| {
            _ = c.wtr_watcher_close(h);
            self.handle = null;
        }
        self.running.store(false, .release);
        if (self.thread) |t| {
            t.join();
            self.thread = null;
        }

        for (self.queue.items) |ev| self.gpa.free(ev.rel);
        self.queue.deinit(self.gpa);
        var it = self.pending.iterator();
        while (it.next()) |e| self.gpa.free(e.key_ptr.*);
        self.pending.deinit(self.gpa);

        self.gpa.free(self.root_z);
        self.gpa.free(self.root);
        self.gpa.destroy(self);
    }

    // -- callback thread ----------------------------------------------------

    /// Translate one backend event and enqueue 0..2 raw events. Runs on the
    /// backend thread; copies any path it keeps.
    fn onEvent(self: *Watcher, event: c.Event) void {
        const pt = event.path_type;
        // Events about the watcher itself, or path kinds we don't surface.
        if (pt == c.PATH_WATCHER or pt == c.PATH_OTHER) return;
        const is_dir = (pt == c.PATH_DIR);

        switch (event.effect_type) {
            c.EFFECT_RENAME => {
                // Don't trust which side is from/to — disambiguate by
                // existence. The side that no longer exists is the unlink,
                // the side that exists is the add. Handles rename-within,
                // rename-out (only old side), and rename-in (only new side).
                self.handleRenameSide(std.mem.span(event.path_name), is_dir);
                if (event.associated_path_name) |assoc| {
                    self.handleRenameSide(std.mem.span(assoc), is_dir);
                }
            },
            c.EFFECT_CREATE => self.enqueueAbs(
                std.mem.span(event.path_name),
                if (is_dir) .add_dir else .add_file,
            ),
            c.EFFECT_DESTROY => self.enqueueAbs(
                std.mem.span(event.path_name),
                if (is_dir) .unlink_dir else .unlink_file,
            ),
            // chokidar emits no `change` for directories; metadata-only
            // effects (OWNER/OTHER) have no ProjectChange equivalent.
            c.EFFECT_MODIFY => if (!is_dir)
                self.enqueueAbs(std.mem.span(event.path_name), .change_file),
            else => {},
        }
    }

    fn handleRenameSide(self: *Watcher, abs: []const u8, is_dir: bool) void {
        const exists = blk: {
            _ = Dir.cwd().statFile(self.io, abs, .{}) catch break :blk false;
            break :blk true;
        };
        const kind: RawKind = if (exists)
            (if (is_dir) .add_dir else .add_file)
        else
            (if (is_dir) .unlink_dir else .unlink_file);
        self.enqueueAbs(abs, kind);
    }

    fn enqueueAbs(self: *Watcher, abs: []const u8, kind: RawKind) void {
        const rel = relFromAbs(self.root, abs) orelse return;
        const is_dir = (kind == .add_dir or kind == .unlink_dir);
        if (shouldIgnore(rel, is_dir)) return;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const rel_owned = self.gpa.dupe(u8, rel) catch return;
        self.queue.append(self.gpa, .{ .kind = kind, .rel = rel_owned }) catch {
            self.gpa.free(rel_owned);
        };
    }

    // -- poll thread --------------------------------------------------------

    fn pollLoop(self: *Watcher) void {
        while (self.running.load(.acquire)) {
            self.tick();
            std.Io.sleep(self.io, .fromMilliseconds(POLL_MS), .awake) catch {};
        }
    }

    fn tick(self: *Watcher) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        for (self.queue.items) |ev| self.applyRaw(ev);
        self.queue.clearRetainingCapacity();

        self.pollPending();
    }

    /// Fold one raw event into pending/immediate state. Consumes `ev.rel`:
    /// frees it, or transfers ownership into the pending map.
    fn applyRaw(self: *Watcher, ev: RawEvent) void {
        switch (ev.kind) {
            .add_dir => {
                self.emit(.add_dir, ev.rel);
                self.gpa.free(ev.rel);
            },
            .unlink_dir => {
                self.emit(.unlink_dir, ev.rel);
                self.gpa.free(ev.rel);
            },
            .unlink_file => {
                if (self.pending.fetchRemove(ev.rel)) |kv| {
                    self.gpa.free(kv.key);
                    if (kv.value.kind == .add) {
                        // Created then deleted before stabilizing: transient,
                        // emit nothing (chokidar cancels the pending add).
                        self.gpa.free(ev.rel);
                        return;
                    }
                }
                self.emit(.unlink, ev.rel);
                self.gpa.free(ev.rel);
            },
            .add_file, .change_file => {
                const kind: ChangeKind = if (ev.kind == .add_file) .add else .change;
                if (self.pending.getPtr(ev.rel)) |p| {
                    // Still settling: restart the window. Keep an existing
                    // `.add` kind (a create+modify before stabilizing is an
                    // add, not a change).
                    if (p.kind == .change and kind == .add) p.kind = .add;
                    p.baseline = null;
                    p.stable_ms = 0;
                    self.gpa.free(ev.rel);
                } else {
                    self.pending.put(self.gpa, ev.rel, .{
                        .kind = kind,
                        .baseline = null,
                        .stable_ms = 0,
                    }) catch self.gpa.free(ev.rel);
                }
            },
        }
    }

    /// Stat each pending file; emit the ones whose size+mtime have held for
    /// STABILITY_MS, drop the ones that vanished (a separate unlink emits).
    fn pollPending(self: *Watcher) void {
        const Done = struct { key: []const u8, emit: bool, kind: ChangeKind };
        var done: std.ArrayList(Done) = .empty;
        defer done.deinit(self.gpa);

        var it = self.pending.iterator();
        while (it.next()) |entry| {
            const rel = entry.key_ptr.*;
            const p = entry.value_ptr;
            const st = self.statRel(rel) orelse {
                done.append(self.gpa, .{ .key = rel, .emit = false, .kind = p.kind }) catch {};
                continue;
            };
            if (p.baseline) |b| {
                if (b.size == st.size and b.mtime_ns == st.mtime_ns) {
                    p.stable_ms += POLL_MS;
                    if (p.stable_ms >= STABILITY_MS) {
                        done.append(self.gpa, .{ .key = rel, .emit = true, .kind = p.kind }) catch {};
                    }
                } else {
                    p.baseline = st;
                    p.stable_ms = 0;
                }
            } else {
                p.baseline = st;
                p.stable_ms = 0;
            }
        }

        for (done.items) |d| {
            if (self.pending.fetchRemove(d.key)) |kv| {
                if (d.emit) self.emit(d.kind, kv.key);
                self.gpa.free(kv.key);
            }
        }
    }

    fn statRel(self: *Watcher, rel: []const u8) ?Stat {
        const abs = std.fs.path.join(self.gpa, &.{ self.root, rel }) catch return null;
        defer self.gpa.free(abs);
        const st = Dir.cwd().statFile(self.io, abs, .{}) catch return null;
        return .{ .size = st.size, .mtime_ns = st.mtime.nanoseconds };
    }

    fn emit(self: *Watcher, kind: ChangeKind, rel: []const u8) void {
        self.emit_fn(self.emit_ctx, kind, rel);
    }
};

fn cCallback(event: c.Event, context: ?*anyopaque) callconv(.c) void {
    const self: *Watcher = @ptrCast(@alignCast(context.?));
    self.onEvent(event);
}

// ---- tests ----------------------------------------------------------------

const testing = std.testing;

test "shouldIgnore mirrors chokidar's ignored predicate" {
    // Kept.
    try testing.expect(!shouldIgnore("notes/intro.md", false));
    try testing.expect(!shouldIgnore(".skrive.toml", false)); // root config
    try testing.expect(!shouldIgnore(".secret.md", false)); // hidden md file: chokidar keeps it
    try testing.expect(!shouldIgnore("sub", true)); // ordinary dir
    // Dropped.
    try testing.expect(shouldIgnore("node_modules/pkg/readme.md", false)); // noise ancestor
    try testing.expect(shouldIgnore(".git/HEAD", false)); // hidden ancestor
    try testing.expect(shouldIgnore("notes/diagram.png", false)); // non-markdown file
    try testing.expect(shouldIgnore("notes/.skrive.toml", false)); // only the root one is kept
    try testing.expect(shouldIgnore(".cache", true)); // hidden leaf dir
    try testing.expect(shouldIgnore("node_modules", true)); // noise leaf dir
}

test "relFromAbs strips the root prefix and rejects outsiders" {
    try testing.expectEqualStrings("a/b.md", relFromAbs("/r", "/r/a/b.md").?);
    try testing.expect(relFromAbs("/r", "/r") == null); // the root itself
    try testing.expect(relFromAbs("/r", "/other/x") == null); // outside
    try testing.expect(relFromAbs("/r", "/rx/y") == null); // prefix coincidence, not a child
}

// A live end-to-end test: real FSEvents, real debounce, real lifecycle. Uses
// a dedicated leak-checking allocator for the watcher's own memory (touched
// only by the two watcher threads, serialized by the watcher mutex — the test
// thread uses testing.allocator for its scratch, so the two allocators never
// race).

const Collector = struct {
    mutex: Io.Mutex = .init,
    io: Io,
    buf: std.ArrayList(u8) = .empty,
    gpa: std.mem.Allocator,

    fn record(ctx: ?*anyopaque, kind: ChangeKind, rel: []const u8) void {
        const self: *Collector = @ptrCast(@alignCast(ctx.?));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.buf.appendSlice(self.gpa, kind.wireName()) catch return;
        self.buf.append(self.gpa, ':') catch return;
        self.buf.appendSlice(self.gpa, rel) catch return;
        self.buf.append(self.gpa, ';') catch return;
    }

    fn contains(self: *Collector, needle: []const u8) bool {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return std.mem.indexOf(u8, self.buf.items, needle) != null;
    }
};

test "watcher translates, filters, and debounces real filesystem events" {
    const a = testing.allocator;
    const io = std.Io.Threaded.global_single_threaded.io();

    var wgpa_state = std.heap.DebugAllocator(.{}){};
    const wgpa = wgpa_state.allocator();

    const dir_name = "watcher_e2e_test_dir";
    Dir.cwd().createDir(io, dir_name, .default_dir) catch |e| switch (e) {
        error.PathAlreadyExists => {},
        else => return e,
    };
    defer Dir.cwd().deleteTree(io, dir_name) catch {};

    const root = try Dir.cwd().realPathFileAlloc(io, dir_name, a);
    defer a.free(root);

    var collector = Collector{ .io = io, .gpa = a };
    defer collector.buf.deinit(a);

    const w = try Watcher.open(wgpa, io, root, Collector.record, &collector);

    // Helper to write a file inside the watched dir.
    const settle = struct {
        fn waitFor(c_io: Io, col: *Collector, needle: []const u8) !void {
            var waited: usize = 0;
            while (waited < 4000) : (waited += 25) {
                try std.Io.sleep(c_io, .fromMilliseconds(25), .awake);
                if (col.contains(needle)) return;
            }
            return error.EventNotSeen;
        }
    };

    try std.Io.sleep(io, .fromMilliseconds(150), .awake); // backend warmup

    // add (markdown) — must survive the stabilization window.
    try Dir.cwd().writeFile(io, .{ .sub_path = dir_name ++ "/note.md", .data = "hello" });
    try settle.waitFor(io, &collector, "add:note.md;");

    // change.
    try Dir.cwd().writeFile(io, .{ .sub_path = dir_name ++ "/note.md", .data = "hello world" });
    try settle.waitFor(io, &collector, "change:note.md;");

    // A non-markdown file must be filtered out — assert the add did fire but
    // the png never shows up after a generous wait.
    try Dir.cwd().writeFile(io, .{ .sub_path = dir_name ++ "/image.png", .data = "x" });
    try std.Io.sleep(io, .fromMilliseconds(400), .awake);
    try testing.expect(!collector.contains("image.png"));

    // unlink (immediate).
    try Dir.cwd().deleteFile(io, dir_name ++ "/note.md");
    try settle.waitFor(io, &collector, "unlink:note.md;");

    w.close();
    try testing.expect(wgpa_state.deinit() == .ok); // no watcher leaks
}
