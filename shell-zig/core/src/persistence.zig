//! The `persistence` namespace (Stage 2.4).
//!
//! UI-state files under the app-data dir (passed in via `config_json` →
//! `Context.app_data_dir`): `app.json` and `projects/<hash>.json`, where
//! `<hash>` is the first 16 hex of SHA-256 of the project path. The layout
//! and hash construction match `shell/src/lib/persistence.ts` exactly so a
//! state file written by one shell loads in the other.
//!
//! `persistence:revealUserData` is host-side (NSWorkspace) and routes over
//! the reserved `host:` channel — see dispatch.zig.
//!
//! Lenient load-with-defaults, like the oracle. Two deliberate, non-
//! corpus-tested simplifications (logged): app-state load merges the file
//! over the embedded default by key but does NOT replicate the oracle's
//! exhaustive per-field type whitelisting (`sanitizeAppState`) — porting
//! that defensive renderer-coupled validation is the scope-creep the kill
//! criterion warns against, and the core writes its own well-formed files;
//! project-state load returns the stored object as-is rather than porting
//! `sanitizeProjectState`.

const std = @import("std");
const dispatch = @import("dispatch.zig");
const fs = @import("fs.zig");

const Command = dispatch.Command;
const Context = dispatch.Context;
const Dir = std.Io.Dir;
const path = std.fs.path;

pub const PersistenceError = error{
    InvalidPayload,
    IoFailure,
    OutOfMemory,
};

/// The default AppUiState, byte-for-byte the `loadAppState-default` fixture.
/// MIRRORS `DEFAULT_APP_UI_STATE` in `shared/src/persistence.ts`; the two
/// MUST be updated in lockstep — a renderer default change that isn't
/// reflected here is a (logged) coupling the dual-shell period pays. The
/// shell owns load-with-defaults, so the core has to embed this; there is
/// no app-side seam to read it from.
const DEFAULT_APP_STATE =
    \\{"schemaVersion":1,"lastOpenedProject":null,"recentProjects":[],"license":null,"firstRunMs":null,"launchCount":0,"seenFeedbackPrompt":false,"personalDictionary":[],"skipDeleteConfirmation":false,"recentFiles":[],"editorFont":"editorial","editorCustomFontFamily":"","editorFontSize":17,"editorLineHeightX100":170,"autoUpdateOnLaunch":true,"theme":"light","showOutlineRail":true,"defaultSurface":"rich","surfaceSwitchingEnabled":true,"markerMode":"recessed","lineMeasure":"normal","lineMeasureCustomCh":70,"showMeasureRule":false,"smartTypography":true,"formatOnSave":false,"autosaveIdleDelayMs":0,"newFileLocation":"activeFolder","newFileNaming":"title","slugFormat":"kebab-case","gitHistoryEnabled":true,"seedFrontmatter":true,"frontmatterFields":["title","date","tags"],"dateFormat":"YYYY-MM-DD"}
;

pub const commands = [_]Command{
    .{ .name = "persistence:loadAppState", .handler = handleLoadAppState },
    .{ .name = "persistence:saveAppState", .handler = handleSaveAppState },
    .{ .name = "persistence:loadProjectState", .handler = handleLoadProjectState },
    .{ .name = "persistence:saveProjectState", .handler = handleSaveProjectState },
    // persistence:revealUserData is host-delegated (NSWorkspace): special-
    // cased in dispatch.zig over the `host:` channel, not handled here.
};

fn requireString(payload: std.json.Value, field: []const u8) PersistenceError![]const u8 {
    const v = payload.object.get(field) orelse return error.InvalidPayload;
    return switch (v) {
        .string => |s| s,
        else => error.InvalidPayload,
    };
}

fn appStateFile(a: std.mem.Allocator, app_data_dir: []const u8) ![]const u8 {
    return path.join(a, &.{ app_data_dir, "app.json" });
}

/// First 16 hex of SHA-256 of the project path — matching `hashProjectPath`.
fn projectStateFile(a: std.mem.Allocator, app_data_dir: []const u8, project_path: []const u8) ![]const u8 {
    const full = try fs.sha256Hex(a, project_path);
    const name = try std.fmt.allocPrint(a, "{s}.json", .{full[0..16]});
    return path.join(a, &.{ app_data_dir, "projects", name });
}

// ---- app state ------------------------------------------------------------

fn handleLoadAppState(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = payload;
    _ = id;
    const file = appStateFile(a, ctx.app_data_dir) catch return error.OutOfMemory;
    const raw = Dir.cwd().readFileAlloc(ctx.io, file, a, .unlimited) catch return DEFAULT_APP_STATE;
    return mergeAppState(a, raw) catch DEFAULT_APP_STATE;
}

/// Merge the stored file over the embedded default by key (default key
/// order preserved, file values win), forcing `schemaVersion:1`. A
/// non-object or a future schemaVersion falls back to the default.
fn mergeAppState(a: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const default_parsed = try std.json.parseFromSlice(std.json.Value, a, DEFAULT_APP_STATE, .{});
    var merged = default_parsed.value; // object; we overwrite values in place

    const file_parsed = std.json.parseFromSlice(std.json.Value, a, raw, .{}) catch return DEFAULT_APP_STATE;
    if (file_parsed.value != .object) return DEFAULT_APP_STATE;
    const file_obj = file_parsed.value.object;

    if (file_obj.get("schemaVersion")) |v| {
        if (v == .integer and v.integer > 1) return DEFAULT_APP_STATE;
    }

    var it = merged.object.iterator();
    while (it.next()) |entry| {
        if (file_obj.get(entry.key_ptr.*)) |file_val| {
            entry.value_ptr.* = file_val;
        }
    }
    try merged.object.put(a, "schemaVersion", .{ .integer = 1 });

    return stringifyValue(a, merged);
}

fn handleSaveAppState(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const state = payload.object.get("state") orelse return error.InvalidPayload;
    Dir.cwd().createDirPath(ctx.io, ctx.app_data_dir) catch return error.IoFailure;
    const file = appStateFile(a, ctx.app_data_dir) catch return error.OutOfMemory;
    try writeJsonAtomic(ctx, a, file, state);
    return "{}";
}

// ---- project state --------------------------------------------------------

fn handleLoadProjectState(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    // An empty/absent root is not an error here — the oracle returns
    // {state:null} rather than INVALID_PAYLOAD.
    const project_root = switch (payload.object.get("projectRoot") orelse return "{\"state\":null}") {
        .string => |s| s,
        else => return "{\"state\":null}",
    };
    if (project_root.len == 0) return "{\"state\":null}";

    const file = projectStateFile(a, ctx.app_data_dir, project_root) catch return error.OutOfMemory;
    const raw = Dir.cwd().readFileAlloc(ctx.io, file, a, .unlimited) catch return "{\"state\":null}";
    // Present + valid object: return as-is wrapped in {state:...}. (Full
    // sanitizeProjectState is not ported; see the module doc.)
    const parsed = std.json.parseFromSlice(std.json.Value, a, raw, .{}) catch return "{\"state\":null}";
    if (parsed.value != .object) return "{\"state\":null}";
    return std.fmt.allocPrint(a, "{{\"state\":{s}}}", .{raw}) catch error.OutOfMemory;
}

fn handleSaveProjectState(ctx: *const Context, a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = id;
    const project_root = try requireString(payload, "projectRoot");
    if (project_root.len == 0) return error.InvalidPayload;
    const state = payload.object.get("state") orelse return error.InvalidPayload;
    const file = projectStateFile(a, ctx.app_data_dir, project_root) catch return error.OutOfMemory;
    if (path.dirname(file)) |dir| Dir.cwd().createDirPath(ctx.io, dir) catch return error.IoFailure;
    try writeJsonAtomic(ctx, a, file, state);
    return "{}";
}

// ---- helpers --------------------------------------------------------------

/// Serialize a parsed Value to compact JSON in the arena.
fn stringifyValue(a: std.mem.Allocator, value: std.json.Value) ![]const u8 {
    var aw = std.Io.Writer.Allocating.init(a);
    std.json.Stringify.value(value, .{}, &aw.writer) catch return error.OutOfMemory;
    return aw.written();
}

/// Atomic write of a JSON value (pretty-printed, two-space indent, matching
/// the oracle's `JSON.stringify(value, null, 2)`). temp + rename, no fsync —
/// the same lighter guarantee `persistence.ts:atomicWriteJson` gives state
/// files (vs the fsync'd document writer).
fn writeJsonAtomic(ctx: *const Context, a: std.mem.Allocator, file: []const u8, value: std.json.Value) PersistenceError!void {
    var aw = std.Io.Writer.Allocating.init(a);
    std.json.Stringify.value(value, .{ .whitespace = .indent_2 }, &aw.writer) catch return error.OutOfMemory;
    var af = Dir.cwd().createFileAtomic(ctx.io, file, .{ .make_path = true, .replace = true }) catch return error.IoFailure;
    defer af.deinit(ctx.io);
    af.file.writeStreamingAll(ctx.io, aw.written()) catch return error.IoFailure;
    af.replace(ctx.io) catch return error.IoFailure;
}

// ---- tests ----------------------------------------------------------------

const testing = std.testing;

test "projectStateFile uses the first 16 hex of sha256(path)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const full = try fs.sha256Hex(a, "/some/project");
    const file = try projectStateFile(a, "/data", "/some/project");
    // .../projects/<first16>.json
    const base = path.basename(file);
    try testing.expectEqualStrings(full[0..16], base[0 .. base.len - ".json".len]);
    try testing.expect(std.mem.endsWith(u8, file, ".json"));
}

test "mergeAppState fills missing fields from the default and forces v1" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // A sparse file: only theme set (to a non-default), schemaVersion bumped
    // within range. Missing fields must come from the default.
    const merged = try mergeAppState(a, "{\"schemaVersion\":1,\"theme\":\"dark\"}");
    const parsed = try std.json.parseFromSlice(std.json.Value, a, merged, .{});
    try testing.expectEqualStrings("dark", parsed.value.object.get("theme").?.string);
    // A field absent from the sparse file is taken from the default.
    try testing.expectEqualStrings("editorial", parsed.value.object.get("editorFont").?.string);
    try testing.expectEqual(@as(i64, 1), parsed.value.object.get("schemaVersion").?.integer);
}

test "mergeAppState rejects a future schemaVersion to the default" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const merged = try mergeAppState(a, "{\"schemaVersion\":99,\"theme\":\"dark\"}");
    try testing.expectEqualStrings(DEFAULT_APP_STATE, merged);
}
