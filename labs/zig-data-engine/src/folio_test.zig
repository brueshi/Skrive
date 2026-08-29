//! `.folio` conformance.
//!
//! The exit criterion for this stage, and the check that keeps "one encoding,
//! three consumers" honest: **parse then write must reproduce the file
//! byte-for-byte.** Every fixture is canonical output of the app's own writer
//! (`fixtures/README.md` records how), so a byte difference here is the Zig
//! and TypeScript encodings having drifted — exactly the failure the data
//! engine plan's "widen together" rule exists to catch.

const std = @import("std");
const root = @import("root.zig");

const fixtures = [_]struct { name: []const u8, bytes: []const u8 }{
    .{ .name = "app-written", .bytes = @embedFile("app-written.folio") },
    .{ .name = "minimal", .bytes = @embedFile("minimal.folio") },
    .{ .name = "kitchen-sink", .bytes = @embedFile("kitchen-sink.folio") },
    .{ .name = "table-widths", .bytes = @embedFile("table-widths.folio") },
    .{ .name = "meta-extra", .bytes = @embedFile("meta-extra.folio") },
    .{ .name = "escapes", .bytes = @embedFile("escapes.folio") },
};

test "every fixture round-trips byte-for-byte" {
    const gpa = std.testing.allocator;

    for (fixtures) |f| {
        var arena_state = std.heap.ArenaAllocator.init(gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const doc = root.parseFolio(arena, f.bytes) catch |err| {
            std.debug.print("fixture {s} failed to parse: {t}\n", .{ f.name, err });
            return err;
        };

        const written = try root.writeFolio(gpa, doc);
        defer gpa.free(written);

        if (!std.mem.eql(u8, f.bytes, written)) {
            std.debug.print("fixture {s} did not round-trip\n", .{f.name});
        }
        try std.testing.expectEqualStrings(f.bytes, written);
    }
}

test "writing is idempotent" {
    const gpa = std.testing.allocator;

    for (fixtures) |f| {
        var first_arena = std.heap.ArenaAllocator.init(gpa);
        defer first_arena.deinit();
        const once = try root.writeFolio(gpa, try root.parseFolio(first_arena.allocator(), f.bytes));
        defer gpa.free(once);

        var second_arena = std.heap.ArenaAllocator.init(gpa);
        defer second_arena.deinit();
        const twice = try root.writeFolio(gpa, try root.parseFolio(second_arena.allocator(), once));
        defer gpa.free(twice);

        try std.testing.expectEqualStrings(once, twice);
    }
}

test "unknown docMeta keys survive verbatim" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    const doc = try root.parseFolio(arena_state.allocator(), @embedFile("meta-extra.folio"));

    // Four unknown keys, in the order they appeared.
    try std.testing.expectEqual(@as(usize, 4), doc.meta.extra.len);
    try std.testing.expectEqualStrings("zzzLast", doc.meta.extra[0].key);
    try std.testing.expectEqualStrings("aNested", doc.meta.extra[1].key);
    try std.testing.expectEqualStrings("emptyObj", doc.meta.extra[2].key);
    try std.testing.expectEqualStrings("emptyArr", doc.meta.extra[3].key);
}

test "table widths keep their source token rather than a reformatted float" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    const doc = try root.parseFolio(arena_state.allocator(), @embedFile("table-widths.folio"));
    const widths = doc.blocks[1].body.table.widths.?;

    // `1` must not become `1.0`, and `0.0001` must not become `1e-4`.
    try std.testing.expectEqualStrings("1", widths[0]);
    try std.testing.expectEqualStrings("0.0001", widths[1]);
    try std.testing.expectEqualStrings("0.5", widths[2]);
}

// ---- version and container refusal ----------------------------------------

test "a zip container is refused before it is parsed" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    try std.testing.expectError(
        error.UnsupportedContainer,
        root.parseFolio(arena_state.allocator(), "PK\x03\x04 binary junk"),
    );
}

test "an unknown schema version is refused rather than half-read" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    const future =
        \\{ "schemaVersion": 2, "docId": "x", "docMeta": { "title": null, "createdAt": "t" }, "blocks": [] }
    ;
    try std.testing.expectError(
        error.UnsupportedVersion,
        root.parseFolio(arena_state.allocator(), future),
    );
}

test "structural nonsense is malformed" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    const cases = [_][]const u8{
        "",
        "[]",
        "{ \"schemaVersion\": 1 }",
        \\{ "schemaVersion": 1, "docId": "x", "docMeta": { "createdAt": "t" }, "blocks": [ { "id": "a", "type": "nope" } ] }
        ,
    };
    for (cases) |case| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        try std.testing.expectError(error.Malformed, root.parseFolio(arena.allocator(), case));
    }
}

// ---- a block on its own: the log-record and boundary case ------------------

test "every block encodes and decodes standalone" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const doc = try root.parseFolio(arena, @embedFile("kitchen-sink.folio"));
    try std.testing.expect(doc.blocks.len > 0);

    for (doc.blocks) |block| {
        const encoded = try root.writeFolioBlock(gpa, block);
        defer gpa.free(encoded);

        var round_arena = std.heap.ArenaAllocator.init(gpa);
        defer round_arena.deinit();
        const decoded = try root.parseFolioBlock(round_arena.allocator(), encoded);

        const re_encoded = try root.writeFolioBlock(gpa, decoded);
        defer gpa.free(re_encoded);

        try std.testing.expectEqualStrings(encoded, re_encoded);
    }
}

test "blocks survive a trip through the durable log as PutBlock payloads" {
    const gpa = std.testing.allocator;
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const doc = try root.parseFolio(arena, @embedFile("kitchen-sink.folio"));

    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();

    var encodings: std.ArrayList([]u8) = .empty;
    defer {
        for (encodings.items) |e| gpa.free(e);
        encodings.deinit(gpa);
    }

    var log = root.Log.init(gpa, sim.storage());
    defer log.deinit();

    for (doc.blocks) |block| {
        const encoded = try root.writeFolioBlock(gpa, block);
        try encodings.append(gpa, encoded);
        try log.append(.put_block, encoded);
    }
    try log.sync();

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    var r = try root.replay(gpa, image);
    defer r.deinit(gpa);

    try std.testing.expectEqual(root.StopReason.clean_end, r.stopped);
    try std.testing.expectEqual(doc.blocks.len, r.records.len);
    for (r.records, encodings.items) |record, expected| {
        try std.testing.expectEqual(root.RecordType.put_block, record.type);
        try std.testing.expectEqualStrings(expected, record.payload);
    }
}
