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
//! corpus-tested simplifications (logged): app-state load fills gaps from the
//! embedded default but does NOT replicate the oracle's exhaustive per-field
//! type whitelisting (`sanitizeAppState`) — porting that defensive renderer-
//! coupled validation is the scope-creep the kill criterion warns against, and
//! the core writes its own well-formed files; project-state load returns the
//! stored object as-is rather than porting `sanitizeProjectState`.
//!
//! Load is deliberately not a key filter either: the stored file's keys all
//! survive, so a pref the renderer has and this core doesn't still round-trips
//! (SKR-273). See `mergeAppState`.

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
///
/// The lockstep is no longer trust-based: `app/__test__/shell/app-state-default-
/// parity.test.ts` parses this literal and asserts deep equality with the shared
/// default, so a new pref that misses the shell fails the suite. It had drifted
/// twice before that existed (SKR-273) — a fresh install got line-height 1.7
/// instead of 1.5, and an autosave debounce of 0ms, which meant a write on every
/// edit rather than after a 500ms pause.
const DEFAULT_APP_STATE =
    \\{"schemaVersion":1,"lastOpenedProject":null,"recentProjects":[],"license":null,"firstRunMs":null,"launchCount":0,"seenFeedbackPrompt":false,"personalDictionary":[],"skipDeleteConfirmation":false,"recentFiles":[],"editorFont":"editorial","editorCustomFontFamily":"","editorFontSize":17,"editorLineHeightX100":150,"autoUpdateOnLaunch":true,"theme":"light","showOutlineRail":true,"showWordCount":true,"wordCountMetric":"words","defaultSurface":"rich","surfaceSwitchingEnabled":true,"markerMode":"recessed","lineMeasure":"normal","lineMeasureCustomCh":70,"showMeasureRule":false,"smartTypography":true,"formatOnSave":false,"autosaveIdleDelayMs":500,"newFileLocation":"activeFolder","newFileNaming":"title","slugFormat":"kebab-case","gitHistoryEnabled":true,"seedFrontmatter":true,"frontmatterFields":["title","date","tags"],"dateFormat":"YYYY-MM-DD","dailyNotesFormat":"md","dailyNotesFolder":"Daily","dailyNotesDateFormat":"YYYY-MM-DD","dailyNotesTemplate":"# {{date}}\n\n"}
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

/// Merge the stored file over the embedded default (default key order
/// preserved, file values win), forcing `schemaVersion:1`. A non-object or a
/// future schemaVersion falls back to the default.
///
/// The default is a FLOOR, not a whitelist: every key in the stored file
/// survives, including ones this core has never heard of. It used to iterate
/// the default's keys instead, which silently dropped any persisted pref
/// missing from the embedded copy — so a renderer pref the shell hadn't caught
/// up to could not be saved at all (SKR-273: showWordCount / wordCountMetric
/// were exactly that). The renderer spreads loaded state over its own defaults
/// and ignores what it doesn't know, so passing an unrecognized key through is
/// strictly safer than eating it. Keys the file doesn't carry still come from
/// the default; unknown ones land after it, in file order.
fn mergeAppState(a: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const default_parsed = try std.json.parseFromSlice(std.json.Value, a, DEFAULT_APP_STATE, .{});
    var merged = default_parsed.value; // object; the file's keys go over it

    const file_parsed = std.json.parseFromSlice(std.json.Value, a, raw, .{}) catch return DEFAULT_APP_STATE;
    if (file_parsed.value != .object) return DEFAULT_APP_STATE;
    const file_obj = file_parsed.value.object;

    if (file_obj.get("schemaVersion")) |v| {
        if (v == .integer and v.integer > 1) return DEFAULT_APP_STATE;
    }

    var it = file_obj.iterator();
    while (it.next()) |entry| {
        try merged.object.put(a, entry.key_ptr.*, entry.value_ptr.*);
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

test "mergeAppState keeps a stored key the embedded default does not have" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // The SKR-273 regression: the merge used to iterate the DEFAULT's keys, so a
    // pref the renderer had and this core didn't was dropped on load — meaning it
    // could never be persisted at all. Any future pref is this case.
    const merged = try mergeAppState(a, "{\"schemaVersion\":1,\"somethingNewer\":false}");
    const parsed = try std.json.parseFromSlice(std.json.Value, a, merged, .{});
    try testing.expectEqual(false, parsed.value.object.get("somethingNewer").?.bool);
    // ...without losing the defaults it fills in around it.
    try testing.expectEqualStrings("editorial", parsed.value.object.get("editorFont").?.string);
}

test "mergeAppState round-trips the prefs SKR-273 was dropping" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const merged = try mergeAppState(a, "{\"schemaVersion\":1,\"showWordCount\":false,\"wordCountMetric\":\"characters\"}");
    const parsed = try std.json.parseFromSlice(std.json.Value, a, merged, .{});
    try testing.expectEqual(false, parsed.value.object.get("showWordCount").?.bool);
    try testing.expectEqualStrings("characters", parsed.value.object.get("wordCountMetric").?.string);
}

test "mergeAppState rejects a future schemaVersion to the default" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const merged = try mergeAppState(a, "{\"schemaVersion\":99,\"theme\":\"dark\"}");
    try testing.expectEqualStrings(DEFAULT_APP_STATE, merged);
}
