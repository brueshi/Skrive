//! The Skrive core dispatcher (Stage 2.1).
//!
//! Replaces the Stage 1 spike's inline `buildResponse` with the real
//! two-stage envelope parse, a comptime command table, and one-place
//! error framing — behind the unchanged Part I C ABI. Every request flows
//! through `dispatchJson`, which is also the surface the parity-fixture
//! harness (`fixture_main.zig`) drives over stdin/stdout.
//!
//! The validation order below mirrors `shell/src/main/dispatch.ts`
//! exactly: that JS dispatcher is the oracle the parity corpus was
//! recorded against, so the codes AND the echoed ids must match for the
//! same malformed inputs. Response key order (`v,id,ok,result` /
//! `v,id,ok,error:{code,message}`) is likewise fixed because the parity
//! normalizer re-stringifies in parsed-key order — byte-equality requires
//! emitting in that order.

const std = @import("std");
const errors = @import("errors.zig");
const ErrorCode = errors.ErrorCode;

pub const ENVELOPE_VERSION = 1;

/// Hard cap on a serialized request, matching `MAX_REQUEST_BYTES` in
/// `shared/src/ipc-contracts.ts`. Oversize requests are rejected before
/// parsing.
pub const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/// Identifies a build from the Zig core specifically, so the round-trip
/// is visible by eye in the running UI (it differs from the Electron
/// shell's version). `app:version` is host-implemented per the contract;
/// the core's copy is purely the round-trip aid carried over from the
/// spike and is not corpus-tested.
const CORE_VERSION = "0.1.0-zig-spike";

/// A command handler. It receives the per-request arena, the parsed
/// payload (guaranteed by the dispatcher to be a JSON object), and the
/// request id, and returns its `result` object as a JSON slice allocated
/// in the arena. The dispatcher frames the success envelope around it;
/// any error it returns is mapped to a code in `errors.codeFor`.
pub const Handler = *const fn (
    a: std.mem.Allocator,
    payload: std.json.Value,
    id: i64,
) anyerror![]const u8;

pub const Command = struct {
    name: []const u8,
    handler: Handler,
};

/// The comptime command table. Stage 2.1 carries the two spike commands
/// (neither corpus-tested; they keep the macOS round-trip self-test and
/// the Swift host legible). `fs:*`, `project:*`, and `persistence:*` are
/// appended here in 2.2-2.4.
pub const commands = [_]Command{
    .{ .name = "app:version", .handler = handleAppVersion },
    .{ .name = "diag:poison", .handler = handleDiagPoison },
};

fn lookup(name: []const u8) ?Handler {
    inline for (commands) |c| {
        if (std.mem.eql(u8, c.name, name)) return c.handler;
    }
    return null;
}

const ENVELOPE_FIELDS = [_][]const u8{ "v", "id", "cmd", "payload" };

fn isEnvelopeField(key: []const u8) bool {
    inline for (ENVELOPE_FIELDS) |f| {
        if (std.mem.eql(u8, f, key)) return true;
    }
    return false;
}

/// The string-marshaled entry point: size cap, parse, dispatch. Returns a
/// NUL-terminated response envelope allocated in `a` (the C ABI emits it
/// as a C string; the fixture harness writes the slice). Never fails — an
/// allocation failure falls back to the static OOM envelope.
pub fn dispatchJson(a: std.mem.Allocator, request: []const u8) [:0]const u8 {
    // Size cap before parsing, per spec.
    if (request.len > MAX_REQUEST_BYTES) {
        return errorEnvelope(a, 0, .payload_too_large);
    }
    // Two-stage parse: the envelope first, dynamically. A parse failure
    // (or any non-object root) is a BAD_ENVELOPE with id 0 — no
    // recoverable id exists.
    const parsed = std.json.parseFromSlice(std.json.Value, a, request, .{}) catch {
        return errorEnvelope(a, 0, .bad_envelope);
    };
    return dispatchValue(a, parsed.value);
}

fn dispatchValue(a: std.mem.Allocator, root: std.json.Value) [:0]const u8 {
    if (root != .object) return errorEnvelope(a, 0, .bad_envelope);
    const obj = root.object;

    // Best-effort id for error responses: a positive JSON integer, else 0.
    const raw_id: i64 = blk: {
        const v = obj.get("id") orelse break :blk 0;
        break :blk switch (v) {
            .integer => |n| if (n > 0) n else 0,
            else => 0,
        };
    };

    // Unknown top-level field — checked before version, matching the JS
    // oracle's order.
    var it = obj.iterator();
    while (it.next()) |entry| {
        if (!isEnvelopeField(entry.key_ptr.*)) {
            return errorEnvelope(a, raw_id, .bad_envelope);
        }
    }

    // Envelope version must be exactly 1.
    const version_ok = blk: {
        const v = obj.get("v") orelse break :blk false;
        break :blk switch (v) {
            .integer => |n| n == ENVELOPE_VERSION,
            else => false,
        };
    };
    if (!version_ok) return errorEnvelope(a, raw_id, .bad_envelope);

    // id must be a positive integer.
    if (raw_id == 0) return errorEnvelope(a, 0, .bad_envelope);

    // cmd must be a non-empty string.
    const cmd: []const u8 = blk: {
        const v = obj.get("cmd") orelse return errorEnvelope(a, raw_id, .bad_envelope);
        break :blk switch (v) {
            .string => |s| s,
            else => return errorEnvelope(a, raw_id, .bad_envelope),
        };
    };
    if (cmd.len == 0) return errorEnvelope(a, raw_id, .bad_envelope);

    // payload must be an object.
    const payload: std.json.Value = blk: {
        const v = obj.get("payload") orelse return errorEnvelope(a, raw_id, .bad_envelope);
        break :blk switch (v) {
            .object => v,
            else => return errorEnvelope(a, raw_id, .bad_envelope),
        };
    };

    const handler = lookup(cmd) orelse return errorEnvelope(a, raw_id, .unknown_command);
    const result = handler(a, payload, raw_id) catch |err| {
        return errorEnvelope(a, raw_id, errors.codeFor(err));
    };
    return okEnvelope(a, raw_id, result);
}

// ---- envelope framing (the only place response JSON is built) -------------

/// Static fallback when even the error envelope can't be allocated.
const oom_envelope: [:0]const u8 =
    "{\"v\":1,\"id\":0,\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"out of memory\"}}";

fn okEnvelope(a: std.mem.Allocator, id: i64, result_json: []const u8) [:0]const u8 {
    return std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":{d},\"id\":{d},\"ok\":true,\"result\":{s}}}",
        .{ ENVELOPE_VERSION, id, result_json },
        0,
    ) catch oom_envelope;
}

fn errorEnvelope(a: std.mem.Allocator, id: i64, code: ErrorCode) [:0]const u8 {
    return std.fmt.allocPrintSentinel(
        a,
        "{{\"v\":{d},\"id\":{d},\"ok\":false,\"error\":{{\"code\":\"{s}\",\"message\":\"{s}\"}}}}",
        .{ ENVELOPE_VERSION, id, code.wire(), code.message() },
        0,
    ) catch oom_envelope;
}

// ---- handlers -------------------------------------------------------------

fn handleAppVersion(a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = payload;
    _ = id;
    return std.fmt.allocPrint(a, "{{\"version\":\"{s}\"}}", .{CORE_VERSION});
}

/// Adversarial body the 1.4 injection check round-trips through the real
/// delivery path: core JSON-encode -> JSEscape (JS string literal) ->
/// `window.__skriveDispatch` -> renderer `JSON.parse`. Every byte must
/// arrive intact and none may execute. Contains a script-tag breakout, a
/// backtick + ${} template trap, a quote, a backslash, a newline, and
/// U+2028/U+2029.
const POISON_BODY =
    "</script><script>window.__pwned=1</script>" ++
    "`${alert(1)}`" ++
    "\"\\\n" ++
    "\u{2028}\u{2029}";

/// Build the `diag:poison` result object: the adversarial body,
/// JSON-string-encoded. This is the core's serialization layer (it
/// escapes the structural bytes); JSEscape adds the JS-string layer on
/// the Swift side. U+2028/U+2029 are valid raw in JSON, so they pass
/// through here as their UTF-8 bytes.
fn handleDiagPoison(a: std.mem.Allocator, payload: std.json.Value, id: i64) anyerror![]const u8 {
    _ = payload;
    _ = id;
    // The body is small and fixed; escape into a stack buffer (2x headroom
    // for the worst case where every byte expands to a 6-byte \u escape),
    // then copy the result object into the arena.
    var buf: [POISON_BODY.len * 6]u8 = undefined;
    var len: usize = 0;
    const hex = "0123456789abcdef";
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
    return std.fmt.allocPrint(a, "{{\"body\":\"{s}\"}}", .{buf[0..len]});
}

// ---- tests ----------------------------------------------------------------
// The envelope-validation matrix is the 2.1 deliverable: these mirror the
// six `envelope.jsonl` parity fixtures (parity normalizes `message` away,
// so the assertions check code + echoed id, not message text).

const testing = std.testing;

/// Run a request through the dispatcher under the leak-checking allocator.
/// Returns the response; caller frees nothing (arena-style: we dupe out).
fn dispatchForTest(request: []const u8) ![]const u8 {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const resp = dispatchJson(arena.allocator(), request);
    return testing.allocator.dupe(u8, resp);
}

fn expectResponse(request: []const u8, expected: []const u8) !void {
    const got = try dispatchForTest(request);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(expected, got);
}

test "malformed JSON -> BAD_ENVELOPE id 0" {
    try expectResponse(
        "{ not json",
        "{\"v\":1,\"id\":0,\"ok\":false,\"error\":{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}",
    );
}

test "unknown top-level field -> BAD_ENVELOPE with echoed id" {
    try expectResponse(
        "{\"v\":1,\"id\":1,\"cmd\":\"fs:readFile\",\"payload\":{},\"extra\":1}",
        "{\"v\":1,\"id\":1,\"ok\":false,\"error\":{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}",
    );
}

test "bad version -> BAD_ENVELOPE with echoed id" {
    try expectResponse(
        "{\"v\":2,\"id\":2,\"cmd\":\"app:version\",\"payload\":{}}",
        "{\"v\":1,\"id\":2,\"ok\":false,\"error\":{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}",
    );
}

test "non-object payload -> BAD_ENVELOPE with echoed id" {
    try expectResponse(
        "{\"v\":1,\"id\":3,\"cmd\":\"fs:readFile\",\"payload\":\"scalar\"}",
        "{\"v\":1,\"id\":3,\"ok\":false,\"error\":{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}",
    );
}

test "unknown command -> UNKNOWN_COMMAND with echoed id" {
    try expectResponse(
        "{\"v\":1,\"id\":4,\"cmd\":\"nope:never\",\"payload\":{}}",
        "{\"v\":1,\"id\":4,\"ok\":false,\"error\":{\"code\":\"UNKNOWN_COMMAND\",\"message\":\"command not implemented\"}}",
    );
}

test "oversize request -> PAYLOAD_TOO_LARGE id 0" {
    const oversize = try testing.allocator.alloc(u8, MAX_REQUEST_BYTES + 16);
    defer testing.allocator.free(oversize);
    @memset(oversize, 'a');
    try expectResponse(
        oversize,
        "{\"v\":1,\"id\":0,\"ok\":false,\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"request exceeds maximum size\"}}",
    );
}

test "missing id (but otherwise valid shape) -> BAD_ENVELOPE id 0" {
    // version and fields are fine, but no positive id is recoverable.
    try expectResponse(
        "{\"v\":1,\"cmd\":\"app:version\",\"payload\":{}}",
        "{\"v\":1,\"id\":0,\"ok\":false,\"error\":{\"code\":\"BAD_ENVELOPE\",\"message\":\"malformed request envelope\"}}",
    );
}

test "app:version success round-trip" {
    const got = try dispatchForTest("{\"v\":1,\"id\":42,\"cmd\":\"app:version\",\"payload\":{}}");
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(
        "{\"v\":1,\"id\":42,\"ok\":true,\"result\":{\"version\":\"" ++ CORE_VERSION ++ "\"}}",
        got,
    );
}

test "diag:poison JSON-encodes the adversarial body intact" {
    const got = try dispatchForTest("{\"v\":1,\"id\":9,\"cmd\":\"diag:poison\",\"payload\":{}}");
    defer testing.allocator.free(got);
    try testing.expect(std.mem.indexOf(u8, got, "\"ok\":true") != null);
    // The script breakout is present literally (the core does not escape
    // `<`; that is JSEscape's job on the Swift side).
    try testing.expect(std.mem.indexOf(u8, got, "</script>") != null);
    // The quote and backslash are JSON-escaped by the core.
    try testing.expect(std.mem.indexOf(u8, got, "\\\"") != null);
    try testing.expect(std.mem.indexOf(u8, got, "\\\\") != null);
}
