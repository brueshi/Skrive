//! The `project` namespace (Stage 2.3, minus watch).
//!
//! `project:snapshot` — the batched project read: one response with every
//! file (bodies for markdown and `.skrive.toml`, `body:null` for assets),
//! walking the tree with the exact noise-dir skip list from
//! `shell/src/lib/snapshot.ts`. `project:create` — make `{parent}/{name}`
//! with a starter README and an optional `git init`.
//!
//! Parity is against `shell/src/ipc/project.ts` + `snapshot.ts`. One
//! deliberate, non-functional approximation: the oracle sorts the files
//! array with JS `localeCompare`, which needs ICU. We sort case-insensitive
//! ASCII, which reproduces the corpus order; the array order is cosmetic
//! anyway (the renderer's project-model worker re-sorts on `init`, and
//! binary-searches its own structure, not the snapshot — model.ts:217).
//!
//! `project:openDialog`, `project:watch`, and `project:unwatch` are not
//! here: the dialog is host-side (NSOpenPanel) and the watcher is Stage 3.

const std = @import("std");
const dispatch = @import("dispatch.zig");
const fs = @import("fs.zig");
const filter = @import("filter.zig");

const Command = dispatch.Command;
const Context = dispatch.Context;
const Io = std.Io;
const Dir = std.Io.Dir;
const path = std.fs.path;

pub const ProjectError = error{
    InvalidPayload,
    AlreadyExists,
    IoFailure,
    OutOfMemory,
};

pub const commands = [_]Command{
    .{ .name = "project:snapshot", .handler = handleSnapshot },
    .{ .name = "project:create", .handler = handleCreate },
    .{ .name = "project:watch", .handler = handleWatch },
    .{ .name = "project:unwatch", .handler = handleUnwatch },
};

fn requireString(payload: std.json.Value, field: []const u8) ProjectError![]const u8 {
    const v = payload.object.get(field) orelse return error.InvalidPayload;
    return switch (v) {
        .string => |s| s,
        else => error.InvalidPayload,
    };
}

// ---- snapshot -------------------------------------------------------------

const Walked = struct {
    /// Project-relative, forward-slash separated.
    rel: []const u8,
    /// Markdown (and `.skrive.toml`) carry their body + hash; assets don't.
    with_body: bool,
};

fn joinRel(a: std.mem.Allocator, prefix: []const u8, name: []const u8) ProjectError![]const u8 {
    // `name` is a slice into the iterator's buffer (invalid after the next
    // `next`); both branches allocate, so the result is owned.
    if (prefix.len == 0) return a.dupe(u8, name) catch error.OutOfMemory;
    return std.fmt.allocPrint(a, "{s}/{s}", .{ prefix, name }) catch error.OutOfMemory;
}

/// Recursive walk mirroring `snapshot.ts:walk`: skip noise dirs and hidden
/// dirs; skip dot-files; yield everything else (markdown flagged for a
/// body). Symlinks (neither `.file` nor `.directory`) are skipped, matching
/// the oracle's `withFileTypes` lstat semantics. A dir that won't open is
/// skipped, not fatal — the same lenient posture as the oracle's scan.
fn walkDir(io: Io, a: std.mem.Allocator, dir: Dir, rel_prefix: []const u8, out: *std.ArrayList(Walked)) ProjectError!void {
    var it = dir.iterate();
    while (true) {
        const entry = (it.next(io) catch break) orelse break;
        switch (entry.kind) {
            .directory => {
                if (filter.isNoiseDir(entry.name)) continue;
                if (entry.name.len > 0 and entry.name[0] == '.') continue;
                const child_rel = try joinRel(a, rel_prefix, entry.name);
                var sub = dir.openDir(io, entry.name, .{ .iterate = true }) catch continue;
                defer sub.close(io);
                try walkDir(io, a, sub, child_rel, out);
            },
            .file => {
                if (entry.name.len > 0 and entry.name[0] == '.') continue;
                const child_rel = try joinRel(a, rel_prefix, entry.name);
                try out.append(a, .{ .rel = child_rel, .with_body = filter.isMarkdown(entry.name) });
            },
            else => {},
        }
    }
}

/// Case-insensitive ASCII order, reproducing the oracle's `localeCompare`
/// for the corpus (the only non-byte-sort case is `README.md`); exact bytes
/// break ties deterministically.
fn walkedLessThan(_: void, lhs: Walked, rhs: Walked) bool {
    const a = lhs.rel;
    const b = rhs.rel;
    const n = @min(a.len, b.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const ca = std.ascii.toLower(a[i]);
        const cb = std.ascii.toLower(b[i]);
        if (ca != cb) return ca < cb;
    }
    if (a.len != b.len) return a.len < b.len;
    return std.mem.lessThan(u8, a, b);
}

/// One SnapshotFile as JSON, or null when the file vanished between walk and
/// stat (the oracle drops it). Key order matches the fixture: path, body,
/// modifiedMs, hash, sizeBytes.
fn snapshotFileJson(a: std.mem.Allocator, io: Io, root_abs: []const u8, rel: []const u8, with_body: bool) ProjectError!?[]const u8 {
    const abs = path.resolve(a, &.{ root_abs, rel }) catch return error.OutOfMemory;
    const stat = Dir.cwd().statFile(io, abs, .{}) catch return null;
    const rel_json = try fs.jsonString(a, rel);
    if (!with_body) {
        return std.fmt.allocPrint(
            a,
            "{{\"path\":{s},\"body\":null,\"modifiedMs\":{d},\"hash\":null,\"sizeBytes\":{d}}}",
            .{ rel_json, fs.mtimeMs(stat), stat.size },
        ) catch error.OutOfMemory;
    }
    // Stat succeeded but the read might not — keep the entry, empty body
    // (the oracle's lenient posture).
    const body = Dir.cwd().readFileAlloc(io, abs, a, .unlimited) catch "";
    const body_json = try fs.jsonString(a, body);
    const hash = try fs.sha256Hex(a, body);
    return std.fmt.allocPrint(
        a,
        "{{\"path\":{s},\"body\":{s},\"modifiedMs\":{d},\"hash\":\"{s}\",\"sizeBytes\":{d}}}",
        .{ rel_json, body_json, fs.mtimeMs(stat), hash, stat.size },
    ) catch error.OutOfMemory;
}

fn handleSnapshot(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    const io = ctx.io;
    _ = id;
    const root_in = try requireString(payload, "root");
    if (root_in.len == 0) return error.InvalidPayload;
    const root_abs = path.resolve(a, &.{root_in}) catch return error.OutOfMemory;

    var walked: std.ArrayList(Walked) = .empty;
    // A missing/unreadable root is not an error — the oracle's scan returns
    // an empty file list (the walk's readdir failure is swallowed).
    if (Dir.cwd().openDir(io, root_abs, .{ .iterate = true })) |opened| {
        var root_dir = opened;
        defer root_dir.close(io);
        try walkDir(io, a, root_dir, "", &walked);
    } else |_| {}
    // `.skrive.toml` is dot-skipped by the walk but always included with a
    // body: the renderer needs the config source to derive the manifest.
    try walked.append(a, .{ .rel = ".skrive.toml", .with_body = true });

    std.mem.sort(Walked, walked.items, {}, walkedLessThan);

    var files: std.ArrayList([]const u8) = .empty;
    for (walked.items) |w| {
        if (try snapshotFileJson(a, io, root_abs, w.rel, w.with_body)) |json| {
            try files.append(a, json);
        }
    }
    const joined = std.mem.join(a, ",", files.items) catch return error.OutOfMemory;
    const root_json = try fs.jsonString(a, root_abs);
    return std.fmt.allocPrint(a, "{{\"root\":{s},\"files\":[{s}]}}", .{ root_json, joined }) catch error.OutOfMemory;
}

// ---- create ---------------------------------------------------------------

fn handleCreate(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    const io = ctx.io;
    _ = id;
    const parent = try requireString(payload, "parent");
    if (parent.len == 0) return error.InvalidPayload;

    // The oracle coerces a non-string name to '' then trims; either way an
    // empty name is INVALID_PAYLOAD.
    const name_raw = switch (payload.object.get("name") orelse return error.InvalidPayload) {
        .string => |s| s,
        else => return error.InvalidPayload,
    };
    const name = std.mem.trim(u8, name_raw, " \t\r\n");
    if (name.len == 0) return error.InvalidPayload;
    // The user picked a parent; the name can't nest or traverse.
    if (std.mem.indexOfAny(u8, name, "/\\") != null or
        std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, ".."))
    {
        return error.InvalidPayload;
    }

    const target = path.resolve(a, &.{ parent, name }) catch return error.OutOfMemory;
    Dir.cwd().createDir(io, target, .default_dir) catch |err| switch (err) {
        error.PathAlreadyExists => return error.AlreadyExists,
        else => return error.IoFailure,
    };

    // Starter README so the sidebar / linter / search has something to chew.
    const readme = std.fmt.allocPrint(a, "# {s}\n\nWritten with Skrive.\n", .{name}) catch return error.OutOfMemory;
    const readme_path = path.resolve(a, &.{ target, "README.md" }) catch return error.OutOfMemory;
    Dir.cwd().writeFile(io, .{ .sub_path = readme_path, .data = readme }) catch return error.IoFailure;

    if (payload.object.get("gitInit")) |g| {
        if (g == .bool and g.bool) gitInit(io, target);
    }

    return std.fmt.allocPrint(a, "{{\"path\":{s}}}", .{try fs.jsonString(a, target)}) catch error.OutOfMemory;
}

// ---- watch / unwatch ------------------------------------------------------

/// Start watching `root`, replacing any active watcher (single watcher per
/// core). The path is canonicalized so the watcher's rel-path stripping lines
/// up with the absolute paths the backend reports. Returns `{}` — the
/// contract's `watch(): Promise<void>`. Where there is no event channel (the
/// parity harness), this is a no-op.
fn handleWatch(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const root_in = try requireString(payload, "root");
    if (root_in.len == 0) return error.InvalidPayload;
    const ctl = ctx.watcher_ctl orelse return "{}";

    const root_abs = path.resolve(a, &.{root_in}) catch return error.OutOfMemory;
    // A missing root just yields no events (chokidar's non-throwing posture),
    // so fall back to the resolved path if realpath can't canonicalize it.
    const root_real: []const u8 = if (Dir.realPathFileAbsoluteAlloc(ctx.io, root_abs, a)) |r|
        r
    else |_|
        root_abs;

    ctl.start(ctx.io, root_real) catch return error.IoFailure;
    return "{}";
}

/// Stop the active watcher, if any. Returns `{}` (contract `unwatch():
/// Promise<void>`).
fn handleUnwatch(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = a;
    _ = payload;
    _ = id;
    if (ctx.watcher_ctl) |ctl| ctl.stop();
    return "{}";
}

/// Best-effort `git init` in the new project (matching the oracle, which
/// ignores a missing or failing git). argv[0] resolves via the parent's
/// PATH; output is suppressed.
fn gitInit(io: Io, cwd_path: []const u8) void {
    var child = std.process.spawn(io, .{
        .argv = &.{ "git", "init", "--quiet" },
        .cwd = .{ .path = cwd_path },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch return;
    _ = child.wait(io) catch return;
}

// ---- tests ----------------------------------------------------------------

const testing = std.testing;

test "walkedLessThan reproduces the corpus localeCompare order" {
    // The snapshot file set, deliberately shuffled. After sort it must match
    // the fixture order: .skrive.toml, assets/pixel.bin, fresh.md,
    // notes/intro.md, README.md, test.png.
    var items = [_]Walked{
        .{ .rel = "README.md", .with_body = true },
        .{ .rel = "test.png", .with_body = false },
        .{ .rel = ".skrive.toml", .with_body = true },
        .{ .rel = "notes/intro.md", .with_body = true },
        .{ .rel = "assets/pixel.bin", .with_body = false },
        .{ .rel = "fresh.md", .with_body = true },
    };
    std.mem.sort(Walked, &items, {}, walkedLessThan);
    const want = [_][]const u8{
        ".skrive.toml",   "assets/pixel.bin", "fresh.md",
        "notes/intro.md", "README.md",        "test.png",
    };
    for (want, 0..) |w, i| try testing.expectEqualStrings(w, items[i].rel);
}
