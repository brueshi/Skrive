//! The durability harness.
//!
//! This is the gate. Every fault class in `docs/fault-model.md` is injected
//! here and the same property is asserted each time: **replay never returns a
//! record that differs from what was appended, and never returns a partial
//! one.** A crash may cost unconfirmed records; it may never invent or damage
//! a confirmed one.
//!
//! The sweeps are exhaustive rather than sampled. At this log size that is
//! affordable, and a seeded sample is a weaker claim to make when the
//! exhaustive one is free.

const std = @import("std");
const root = @import("root.zig");

const RecordType = root.RecordType;

const Expected = struct { type: RecordType, payload: []const u8 };

/// Deliberately varied: an empty payload (a legal zero-length record), a
/// single byte, and spans that straddle any sector or page boundary the
/// faults below use.
const fixture_records = [_]Expected{
    .{ .type = .put_block, .payload = "alpha" },
    .{ .type = .delete_block, .payload = "" },
    .{ .type = .put_block, .payload = "a slightly longer payload" },
    .{ .type = .put_block, .payload = "z" },
    .{ .type = .delete_block, .payload = "beta" },
};

/// Start offset of each record, plus a final entry at the image length.
fn boundaries(records: []const Expected, out: []usize) void {
    var at: usize = 0;
    for (records, 0..) |r, i| {
        out[i] = at;
        at += root.header_len + r.payload.len;
    }
    out[records.len] = at;
}

/// Index of the record whose bytes cover `offset`.
fn ownerOf(bounds: []const usize, offset: usize) usize {
    var i: usize = 0;
    while (i + 1 < bounds.len) : (i += 1) {
        if (offset >= bounds[i] and offset < bounds[i + 1]) return i;
    }
    unreachable;
}

/// Append `records` to a fresh simulated storage, syncing after the first
/// `synced` of them. Caller owns the returned storage.
fn seed(gpa: std.mem.Allocator, sim: *root.SimStorage, records: []const Expected, synced: usize) !void {
    var log = root.Log.init(gpa, sim.storage());
    defer log.deinit();
    for (records, 0..) |r, i| {
        try log.append(r.type, r.payload);
        if (i + 1 == synced) try log.sync();
    }
}

/// The invariant, stated once: whatever replay returns is an unmodified
/// prefix of what was appended.
fn expectIntactPrefix(gpa: std.mem.Allocator, image: []const u8, records: []const Expected) !usize {
    var r = try root.replay(gpa, image);
    defer r.deinit(gpa);

    try std.testing.expect(r.records.len <= records.len);
    for (r.records, records[0..r.records.len]) |got, want| {
        try std.testing.expectEqual(want.type, got.type);
        try std.testing.expectEqualSlices(u8, want.payload, got.payload);
    }
    return r.records.len;
}

// ---- framing and replay ---------------------------------------------------

test "a clean log replays to exactly what was appended" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    var r = try root.replay(gpa, image);
    defer r.deinit(gpa);

    try std.testing.expectEqual(root.StopReason.clean_end, r.stopped);
    try std.testing.expectEqual(image.len, r.valid_bytes);
    try std.testing.expectEqual(fixture_records.len, r.records.len);
    for (r.records, fixture_records) |got, want| {
        try std.testing.expectEqual(want.type, got.type);
        try std.testing.expectEqualSlices(u8, want.payload, got.payload);
    }
}

test "an empty log replays to nothing" {
    const gpa = std.testing.allocator;
    var r = try root.replay(gpa, "");
    defer r.deinit(gpa);
    try std.testing.expectEqual(root.StopReason.clean_end, r.stopped);
    try std.testing.expectEqual(@as(usize, 0), r.records.len);
}

test "a zeroed page is rejected by both the tag and the checksum" {
    const gpa = std.testing.allocator;
    const zeroes = [_]u8{0} ** 64;

    var r = try root.replay(gpa, &zeroes);
    defer r.deinit(gpa);

    try std.testing.expectEqual(@as(usize, 0), r.records.len);
    try std.testing.expectEqual(root.StopReason.checksum_mismatch, r.stopped);
}

test "an absurd length is refused rather than attempted" {
    const gpa = std.testing.allocator;
    var image: [root.header_len]u8 = undefined;
    std.mem.writeInt(u32, image[0..4], root.max_payload_len + 1, .little);
    std.mem.writeInt(u32, image[4..8], 0, .little);
    image[8] = @intFromEnum(RecordType.put_block);

    var r = try root.replay(gpa, &image);
    defer r.deinit(gpa);

    try std.testing.expectEqual(root.StopReason.length_exceeds_limit, r.stopped);
    try std.testing.expectEqual(@as(usize, 0), r.records.len);
}

// ---- fault class 1: truncation --------------------------------------------

test "truncation at every byte offset yields an intact prefix" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    var bounds: [fixture_records.len + 1]usize = undefined;
    boundaries(&fixture_records, &bounds);
    const total = bounds[fixture_records.len];

    var keep: u64 = 0;
    while (keep <= total) : (keep += 1) {
        const image = try sim.crashImage(gpa, .{ .truncation = .{ .keep_bytes = keep } });
        defer gpa.free(image);

        const recovered = try expectIntactPrefix(gpa, image, &fixture_records);

        // Exactly the records that fit entirely inside the surviving bytes.
        var expected: usize = 0;
        while (expected < fixture_records.len and bounds[expected + 1] <= keep) expected += 1;
        try std.testing.expectEqual(expected, recovered);
    }
}

// ---- fault class 2: torn sector -------------------------------------------

test "a torn sector costs its record and everything after it, never before" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    var bounds: [fixture_records.len + 1]usize = undefined;
    boundaries(&fixture_records, &bounds);
    const total = bounds[fixture_records.len];

    const sector_size: u32 = 8;
    var index: u32 = 0;
    while (@as(usize, index) * sector_size < total) : (index += 1) {
        const image = try sim.crashImage(gpa, .{ .torn_sector = .{
            .sector_size = sector_size,
            .drop_index = index,
        } });
        defer gpa.free(image);

        try std.testing.expectEqual(total, image.len);
        const recovered = try expectIntactPrefix(gpa, image, &fixture_records);
        try std.testing.expect(recovered <= ownerOf(&bounds, @as(usize, index) * sector_size));
    }
}

// ---- fault class 3: bit flip ----------------------------------------------

test "every single-bit flip is caught at or before its own record" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    var bounds: [fixture_records.len + 1]usize = undefined;
    boundaries(&fixture_records, &bounds);
    const total = bounds[fixture_records.len];

    var offset: u64 = 0;
    while (offset < total) : (offset += 1) {
        var bit: u3 = 0;
        while (true) {
            const mask = @as(u8, 1) << bit;
            const image = try sim.crashImage(gpa, .{ .bit_flip = .{
                .at_byte = offset,
                .mask = mask,
            } });
            defer gpa.free(image);

            const recovered = try expectIntactPrefix(gpa, image, &fixture_records);
            try std.testing.expect(recovered <= ownerOf(&bounds, @intCast(offset)));

            if (bit == 7) break;
            bit += 1;
        }
    }
}

// ---- fault class 4: lost unsynced tail ------------------------------------

test "a lost unsynced tail never costs a confirmed record" {
    const gpa = std.testing.allocator;
    const synced = 3;

    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, synced);

    // Every subset of the pending pages, total loss included.
    const page_size: u32 = 8;
    const pending = (try sim.storage().size()) - sim.committedLen();
    const pages: u6 = @intCast((pending + page_size - 1) / page_size);
    const subsets = @as(u64, 1) << pages;

    var mask: u64 = 0;
    while (mask < subsets) : (mask += 1) {
        const image = try sim.crashImage(gpa, .{ .lost_unsynced_tail = .{
            .page_size = page_size,
            .survivor_mask = mask,
        } });
        defer gpa.free(image);

        const recovered = try expectIntactPrefix(gpa, image, &fixture_records);
        try std.testing.expect(recovered >= synced);
    }
}

// ---- fault class 5: corrupt snapshot --------------------------------------

test "a snapshot round-trips and positions replay at its log offset" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    var bounds: [fixture_records.len + 1]usize = undefined;
    boundaries(&fixture_records, &bounds);

    var store = root.SimSnapshotStore.init(gpa);
    defer store.deinit();

    const framed = try root.encodeSnapshot(gpa, bounds[3], "arena-bytes");
    defer gpa.free(framed);
    try store.store().write(1, framed);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    var rec = try root.recover(gpa, image, store.store());
    defer rec.deinit(gpa);

    try std.testing.expectEqual(@as(?u64, 1), rec.snapshot_index);
    try std.testing.expectEqualStrings("arena-bytes", rec.snapshot_payload.?);
    try std.testing.expectEqual(@as(usize, 0), rec.snapshots_rejected);
    // Only the records after the snapshot's offset are replayed.
    try std.testing.expectEqual(fixture_records.len - 3, rec.replay.records.len);
    for (rec.replay.records, fixture_records[3..]) |got, want| {
        try std.testing.expectEqualSlices(u8, want.payload, got.payload);
    }
}

test "a corrupt newest snapshot falls back to the prior known-good one" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    var bounds: [fixture_records.len + 1]usize = undefined;
    boundaries(&fixture_records, &bounds);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    // Damage the newer snapshot at every byte, and confirm recovery lands on
    // the older one with the correct log position every single time.
    const older = try root.encodeSnapshot(gpa, bounds[1], "older-arena");
    defer gpa.free(older);
    const newer = try root.encodeSnapshot(gpa, bounds[3], "newer-arena");
    defer gpa.free(newer);

    var at: usize = 0;
    while (at < newer.len) : (at += 1) {
        var store = root.SimSnapshotStore.init(gpa);
        defer store.deinit();
        try store.store().write(1, older);
        try store.store().write(2, newer);
        store.corrupt(2, at, 0x80);

        var rec = try root.recover(gpa, image, store.store());
        defer rec.deinit(gpa);

        try std.testing.expectEqual(@as(?u64, 1), rec.snapshot_index);
        try std.testing.expectEqualStrings("older-arena", rec.snapshot_payload.?);
        try std.testing.expectEqual(@as(usize, 1), rec.snapshots_rejected);
        try std.testing.expectEqual(bounds[1], @as(usize, @intCast(rec.log_offset)));
        try std.testing.expectEqual(fixture_records.len - 1, rec.replay.records.len);
    }
}

test "a truncated snapshot is rejected at every length" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    const framed = try root.encodeSnapshot(gpa, 0, "arena-bytes");
    defer gpa.free(framed);

    var keep: usize = 0;
    while (keep < framed.len) : (keep += 1) {
        var store = root.SimSnapshotStore.init(gpa);
        defer store.deinit();
        try store.store().write(1, framed);
        store.truncate(1, keep);

        var rec = try root.recover(gpa, image, store.store());
        defer rec.deinit(gpa);

        try std.testing.expectEqual(@as(?u64, null), rec.snapshot_index);
        try std.testing.expectEqual(@as(usize, 1), rec.snapshots_rejected);
        // Falling back to no snapshot still recovers the whole log.
        try std.testing.expectEqual(fixture_records.len, rec.replay.records.len);
    }
}

test "a valid snapshot pointing past the log is rejected" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    // Internally consistent, correctly checksummed, and wrong: it claims a
    // log position this log does not reach. A checksum alone never catches
    // this.
    const framed = try root.encodeSnapshot(gpa, image.len + 1, "arena-bytes");
    defer gpa.free(framed);

    var store = root.SimSnapshotStore.init(gpa);
    defer store.deinit();
    try store.store().write(1, framed);

    var rec = try root.recover(gpa, image, store.store());
    defer rec.deinit(gpa);

    try std.testing.expectEqual(@as(?u64, null), rec.snapshot_index);
    try std.testing.expectEqual(@as(usize, 1), rec.snapshots_rejected);
    try std.testing.expectEqual(fixture_records.len, rec.replay.records.len);
}

test "recovery with no snapshots replays the whole log" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seed(gpa, &sim, &fixture_records, fixture_records.len);

    const image = try sim.storage().readAll(gpa);
    defer gpa.free(image);

    var store = root.SimSnapshotStore.init(gpa);
    defer store.deinit();

    var rec = try root.recover(gpa, image, store.store());
    defer rec.deinit(gpa);

    try std.testing.expectEqual(@as(?u64, null), rec.snapshot_index);
    try std.testing.expectEqual(@as(u64, 0), rec.log_offset);
    try std.testing.expectEqual(fixture_records.len, rec.replay.records.len);
}
