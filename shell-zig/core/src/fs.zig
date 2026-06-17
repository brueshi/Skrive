//! The `fs` namespace (Stage 2.2).
//!
//! The seven filesystem commands that live in the core, each taking a
//! `{ projectRoot, relPath }` (or `oldRelPath`/`newRelPath`) payload. Every
//! path is resolved with symlink-safe containment (Part I path safety,
//! porting `shell/src/lib/path-safety.ts` verbatim — the algorithm is
//! identical; only the 0.16 std API names differ) before any syscall, so
//! containment lives in one place. The eighth command, `fs:trash`, routes
//! to the host via the reserved `host:` channel (Stage 2.2b).
//!
//! Parity is against the Electron shell (`shell/src/ipc/fs.ts`): the
//! content hash is SHA-256 of the UTF-8 body, byte-equal to
//! `contentHash` there; writes are atomic (temp + fsync + rename) via
//! `createFileAtomic`.

const std = @import("std");
const dispatch = @import("dispatch.zig");

const Command = dispatch.Command;
const Io = std.Io;
const Dir = std.Io.Dir;
const path = std.fs.path;

/// The fs error set, mapped to envelope codes in `errors.codeFor`. Zig
/// error tags are global, so the mapping there matches these without
/// importing this file. Std errors are converted to these at the call
/// site so the dispatcher never sees a raw filesystem error.
pub const FsError = error{
    PathEscape,
    InvalidPayload,
    AlreadyExists,
    IoFailure,
    OutOfMemory,
};

pub const commands = [_]Command{
    .{ .name = "fs:readFile", .handler = handleReadFile },
    .{ .name = "fs:detectExternalChange", .handler = handleDetectExternalChange },
    .{ .name = "fs:writeFile", .handler = handleWriteFile },
    .{ .name = "fs:writeBinaryFile", .handler = handleWriteBinaryFile },
    .{ .name = "fs:newFile", .handler = handleNewFile },
    .{ .name = "fs:mkdir", .handler = handleMkdir },
    .{ .name = "fs:rename", .handler = handleRename },
    // fs:trash is NOT here: it delegates to the host via the reserved
    // `host:` channel and so is special-cased in dispatch.zig (it emits a
    // host-command envelope instead of a result the dispatcher wraps).
};

/// Validate `{ projectRoot, relPath }` and return the resolved absolute
/// target for `fs:trash`. The dispatcher frames the host-command envelope
/// around it; the path never goes through the normal result-wrapping path.
pub fn resolveTrashTarget(a: std.mem.Allocator, io: Io, payload: std.json.Value) FsError![]const u8 {
    return (try resolveFromPayload(a, io, payload)).target;
}

// ---- payload helpers ------------------------------------------------------

fn requireString(payload: std.json.Value, field: []const u8) FsError![]const u8 {
    const v = payload.object.get(field) orelse return error.InvalidPayload;
    return switch (v) {
        .string => |s| s,
        else => error.InvalidPayload,
    };
}

/// Resolve `{ projectRoot, relPath }` from a payload with containment.
fn resolveFromPayload(a: std.mem.Allocator, io: Io, payload: std.json.Value) FsError!struct {
    rel_path: []const u8,
    target: []const u8,
} {
    const project_root = try requireString(payload, "projectRoot");
    const rel_path = try requireString(payload, "relPath");
    return .{ .rel_path = rel_path, .target = try resolveSafe(a, io, project_root, rel_path) };
}

// ---- path safety (Part I; mirrors shell/src/lib/path-safety.ts) -----------

fn containsNul(s: []const u8) bool {
    return std.mem.indexOfScalar(u8, s, 0) != null;
}

/// Lexical escape test on `path.relative(root, target)`: an empty string
/// means contained; `..`, a `../` prefix, or an absolute result escaped.
fn lexicallyEscapes(rel: []const u8) bool {
    if (std.mem.eql(u8, rel, "..")) return true;
    if (rel.len >= 3 and rel[0] == '.' and rel[1] == '.' and rel[2] == path.sep) return true;
    if (path.isAbsolute(rel)) return true;
    return false;
}

/// realpath of the deepest existing ancestor of `target` (the target
/// itself when it exists, so a symlinked file is caught; otherwise its
/// nearest existing parent — the not-yet-created tail can't be a symlink).
/// Terminates because the filesystem root always exists.
fn realpathDeepestExisting(io: Io, a: std.mem.Allocator, target: []const u8) FsError![]const u8 {
    var current = target;
    while (true) {
        if (Dir.realPathFileAbsoluteAlloc(io, current, a)) |real| {
            return real;
        } else |_| {
            const parent = path.dirname(current) orelse return current;
            if (std.mem.eql(u8, parent, current)) return current;
            current = parent;
        }
    }
}

/// Resolve `relPath` against `projectRoot` and verify it stays inside the
/// root both lexically and physically. Returns the resolved absolute
/// target (under the canonical root). Errors `PathEscape` on a NUL byte, a
/// missing root, `..` traversal, an absolute `relPath`, or a symlink in
/// the existing prefix that jumps outside.
fn resolveSafe(
    a: std.mem.Allocator,
    io: Io,
    project_root: []const u8,
    rel_path: []const u8,
) FsError![]const u8 {
    // (5) NUL bytes truncate paths at the C layer — reject before any
    // syscall sees them.
    if (containsNul(project_root) or containsNul(rel_path)) return error.PathEscape;

    // (1) Canonicalize the root: both sides of the containment comparison
    // are symlink-free, and a non-existent root is itself a failure.
    const abs_root = if (path.isAbsolute(project_root))
        project_root
    else
        try path.resolve(a, &.{project_root});
    const real_root = Dir.realPathFileAbsoluteAlloc(io, abs_root, a) catch return error.PathEscape;

    // (2) Lexical join, then (3) lexical containment — a cheap reject
    // before touching disk. `real_root` and `target` are absolute, so the
    // cwd/environ args to `path.relative` are unused on posix.
    const target = try path.resolve(a, &.{ real_root, rel_path });
    if (lexicallyEscapes(try path.relative(a, "", null, real_root, target))) return error.PathEscape;

    // (4) Physical check: the deepest existing ancestor, canonicalized,
    // must still be inside the root — the case the lexical check misses.
    const real_existing = try realpathDeepestExisting(io, a, target);
    const rel_existing = try path.relative(a, "", null, real_root, real_existing);
    if (rel_existing.len != 0 and lexicallyEscapes(rel_existing)) return error.PathEscape;

    return target;
}

// ---- result serialization -------------------------------------------------

const empty_result = "{}";

/// SHA-256 of `bytes` as lowercase hex — byte-equal to `contentHash` in
/// `shell/src/lib/atomic-write.ts`.
fn sha256Hex(a: std.mem.Allocator, bytes: []const u8) FsError![]const u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    return a.dupe(u8, &hex);
}

/// A JSON string literal (quoted + escaped) for an arbitrary byte slice.
pub fn jsonString(a: std.mem.Allocator, s: []const u8) FsError![]const u8 {
    var aw = std.Io.Writer.Allocating.init(a);
    std.json.Stringify.encodeJsonString(s, .{}, &aw.writer) catch return error.OutOfMemory;
    return aw.written();
}

fn mtimeMs(stat: Dir.Stat) i64 {
    return @intCast(@divTrunc(stat.mtime.nanoseconds, std.time.ns_per_ms));
}

// ---- handlers -------------------------------------------------------------

fn handleReadFile(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    const body = Dir.cwd().readFileAlloc(io, r.target, a, .unlimited) catch return error.IoFailure;
    const stat = Dir.cwd().statFile(io, r.target, .{}) catch return error.IoFailure;
    return std.fmt.allocPrint(
        a,
        "{{\"path\":{s},\"body\":{s},\"modifiedMs\":{d},\"hash\":\"{s}\"}}",
        .{ try jsonString(a, r.rel_path), try jsonString(a, body), mtimeMs(stat), try sha256Hex(a, body) },
    );
}

fn handleDetectExternalChange(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    const known_hash = try requireString(payload, "knownHash");
    // A missing file is not a conflict — a save will create it.
    const changed = blk: {
        const disk = Dir.cwd().readFileAlloc(io, r.target, a, .unlimited) catch break :blk false;
        break :blk !std.mem.eql(u8, try sha256Hex(a, disk), known_hash);
    };
    return std.fmt.allocPrint(a, "{{\"changed\":{}}}", .{changed});
}

fn handleWriteFile(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    const content = try requireString(payload, "content");
    try atomicWrite(io, r.target, content);
    // Note: the Electron writer's auto-checkpoint trigger is Stage 4.2; in
    // the parity harness no project is open, so the oracle skips it too.
    return std.fmt.allocPrint(a, "{{\"hash\":\"{s}\"}}", .{try sha256Hex(a, content)});
}

fn handleWriteBinaryFile(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    const base64 = try requireString(payload, "base64");
    const decoder = std.base64.standard.Decoder;
    const len = decoder.calcSizeForSlice(base64) catch return error.InvalidPayload;
    const bytes = try a.alloc(u8, len);
    decoder.decode(bytes, base64) catch return error.InvalidPayload;
    if (path.dirname(r.target)) |dir| Dir.cwd().createDirPath(io, dir) catch return error.IoFailure;
    // Binary assets (pasted images) bypass the atomic/checkpoint path the
    // markdown writer uses, matching the Electron shell.
    Dir.cwd().writeFile(io, .{ .sub_path = r.target, .data = bytes }) catch return error.IoFailure;
    return empty_result;
}

fn handleNewFile(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    if (path.dirname(r.target)) |dir| Dir.cwd().createDirPath(io, dir) catch return error.IoFailure;
    // Exclusive create: errors if the file already exists.
    var file = Dir.cwd().createFile(io, r.target, .{ .exclusive = true }) catch |err| switch (err) {
        error.PathAlreadyExists => return error.AlreadyExists,
        else => return error.IoFailure,
    };
    file.close(io);
    return empty_result;
}

fn handleMkdir(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const r = try resolveFromPayload(a, io, payload);
    Dir.cwd().createDirPath(io, r.target) catch return error.IoFailure;
    return empty_result;
}

fn handleRename(a: std.mem.Allocator, io: Io, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const project_root = try requireString(payload, "projectRoot");
    const old_rel = try requireString(payload, "oldRelPath");
    const new_rel = try requireString(payload, "newRelPath");
    const old_target = try resolveSafe(a, io, project_root, old_rel);
    const new_target = try resolveSafe(a, io, project_root, new_rel);
    if (path.dirname(new_target)) |dir| Dir.cwd().createDirPath(io, dir) catch return error.IoFailure;
    Dir.renameAbsolute(old_target, new_target, io) catch return error.IoFailure;
    return empty_result;
}

/// Atomic, durable write: temp sibling, fsync, rename over the target —
/// the same guarantee as `shell/src/lib/atomic-write.ts`.
fn atomicWrite(io: Io, target: []const u8, content: []const u8) FsError!void {
    var af = Dir.cwd().createFileAtomic(io, target, .{ .make_path = true, .replace = true }) catch return error.IoFailure;
    defer af.deinit(io);
    af.file.writeStreamingAll(io, content) catch return error.IoFailure;
    af.file.sync(io) catch return error.IoFailure;
    af.replace(io) catch return error.IoFailure;
}

// ---- tests ----------------------------------------------------------------
// Path safety: the symlink fixture tree from shell/__test__/path-safety.test.ts
// ported verbatim — it is the cross-implementation oracle for the algorithm.

const testing = std.testing;

const PathSafeFixture = struct {
    tmp: testing.TmpDir,
    sandbox: []const u8,
    root: []const u8,

    fn join(a: std.mem.Allocator, parts: []const []const u8) []const u8 {
        return path.join(a, parts) catch unreachable;
    }

    fn setup(a: std.mem.Allocator) !PathSafeFixture {
        const io = testing.io;
        var tmp = testing.tmpDir(.{});
        var buf: [std.fs.max_path_bytes]u8 = undefined;
        const n = try tmp.dir.realPath(io, &buf);
        const sandbox = try a.dupe(u8, buf[0..n]);
        const outside = join(a, &.{ sandbox, "outside" });
        const root = join(a, &.{ sandbox, "root" });
        try Dir.cwd().createDirPath(io, join(a, &.{ outside, "subdir" }));
        try Dir.cwd().writeFile(io, .{ .sub_path = join(a, &.{ outside, "secret.md" }), .data = "TOP SECRET" });
        try Dir.cwd().createDirPath(io, join(a, &.{ root, "notes" }));
        try Dir.cwd().writeFile(io, .{ .sub_path = join(a, &.{ root, "inside.md" }), .data = "inside" });
        try Dir.cwd().writeFile(io, .{ .sub_path = join(a, &.{ root, "notes", "a.md" }), .data = "# A" });
        try Dir.symLinkAbsolute(io, join(a, &.{ outside, "subdir" }), join(a, &.{ root, "linkDir" }), .{});
        try Dir.symLinkAbsolute(io, join(a, &.{ outside, "secret.md" }), join(a, &.{ root, "linkFile.md" }), .{});
        return .{ .tmp = tmp, .sandbox = sandbox, .root = root };
    }

    fn deinit(self: *PathSafeFixture) void {
        self.tmp.cleanup();
    }

    fn expectEscape(self: *PathSafeFixture, a: std.mem.Allocator, rel: []const u8) !void {
        try testing.expectError(error.PathEscape, resolveSafe(a, testing.io, self.root, rel));
    }
};

test "resolveSafe rejects the five attack shapes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fx = try PathSafeFixture.setup(a);
    defer fx.deinit();

    // 1. in-root symlink to an out-of-root directory (read and create).
    try fx.expectEscape(a, "linkDir/leak.md");
    try fx.expectEscape(a, "linkDir/new-file.md");
    // 2. in-root symlink to an out-of-root file.
    try fx.expectEscape(a, "linkFile.md");
    // 3. `..` traversal.
    try fx.expectEscape(a, "../outside/secret.md");
    try fx.expectEscape(a, "notes/../../outside/secret.md");
    // 4. absolute paths.
    try fx.expectEscape(a, "/etc/passwd");
    try fx.expectEscape(a, PathSafeFixture.join(a, &.{ fx.sandbox, "outside", "secret.md" }));
    // 5. NUL bytes.
    try fx.expectEscape(a, "a\x00b.md");
    try fx.expectEscape(a, "notes/\x00.md");
}

test "resolveSafe resolves legitimate paths" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fx = try PathSafeFixture.setup(a);
    defer fx.deinit();
    const io = testing.io;

    const expectResolves = struct {
        fn check(al: std.mem.Allocator, root: []const u8, rel: []const u8, want: []const u8) !void {
            const got = try resolveSafe(al, testing.io, root, rel);
            try testing.expectEqualStrings(want, got);
        }
    }.check;

    try expectResolves(a, fx.root, "inside.md", PathSafeFixture.join(a, &.{ fx.root, "inside.md" }));
    try expectResolves(a, fx.root, "notes/a.md", PathSafeFixture.join(a, &.{ fx.root, "notes", "a.md" }));
    // not-yet-created file under an existing dir (create path).
    try expectResolves(a, fx.root, "notes/new.md", PathSafeFixture.join(a, &.{ fx.root, "notes", "new.md" }));
    // file under a not-yet-created subtree (recursive create).
    try expectResolves(a, fx.root, "deep/dir/new.md", PathSafeFixture.join(a, &.{ fx.root, "deep", "dir", "new.md" }));
    // the root itself (empty relPath) is contained.
    try expectResolves(a, fx.root, "", fx.root);

    // A symlink whose target IS the real root behaves like the root.
    const linked_root = PathSafeFixture.join(a, &.{ fx.sandbox, "root-link" });
    try Dir.symLinkAbsolute(io, fx.root, linked_root, .{});
    try expectResolves(a, linked_root, "notes/a.md", PathSafeFixture.join(a, &.{ fx.root, "notes", "a.md" }));
}

test "resolveSafe rejects a non-existent project root" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var fx = try PathSafeFixture.setup(a);
    defer fx.deinit();
    try testing.expectError(
        error.PathEscape,
        resolveSafe(a, testing.io, PathSafeFixture.join(a, &.{ fx.sandbox, "no-such-root" }), "a.md"),
    );
}

test "sha256Hex matches the known fixture hash" {
    // README.md from the parity sample project; hash is the fs.jsonl value.
    const body = "# Parity Sample\n\nA tiny project the parity corpus runs against. See [intro](notes/intro.md).\n";
    const hex = try sha256Hex(testing.allocator, body);
    defer testing.allocator.free(hex);
    try testing.expectEqualStrings("7e838c0698095bf4b8fca223174761d29fd2848889c202b90d2358f94a49bb00", hex);
}
