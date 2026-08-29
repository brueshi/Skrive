//! Test aggregator. Runs headless via `zig build test`.

const std = @import("std");
const root = @import("root.zig");

const Fault = root.Fault;

// ---- the fault model ------------------------------------------------------

test "every fault class carries a distinct description" {
    const classes = std.enums.values(root.FaultClass);
    try std.testing.expect(classes.len > 0);
    for (classes, 0..) |class, i| {
        const text = class.description();
        try std.testing.expect(text.len > 0);
        for (classes[i + 1 ..]) |other| {
            try std.testing.expect(!std.mem.eql(u8, text, other.description()));
        }
    }
}

// ---- the seam, under both backends ----------------------------------------

/// The round-trip every backend owes: what was appended reads back, in order,
/// across a barrier.
fn expectRoundTrip(s: root.Storage) !void {
    const gpa = std.testing.allocator;

    try s.append("hello ");
    try s.sync();
    try s.append("world");

    try std.testing.expectEqual(@as(u64, 11), try s.size());

    const all = try s.readAll(gpa);
    defer gpa.free(all);
    try std.testing.expectEqualStrings("hello world", all);
}

test "round-trip through the simulated backend" {
    var sim = root.SimStorage.init(std.testing.allocator);
    defer sim.deinit();
    try expectRoundTrip(sim.storage());
}

test "round-trip through the real backend" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var real = try root.RealStorage.open(std.testing.io, tmp.dir, "log");
    defer real.close();
    try expectRoundTrip(real.storage());
}

test "reopening the real backend preserves the log" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    {
        var real = try root.RealStorage.open(std.testing.io, tmp.dir, "log");
        defer real.close();
        try real.storage().append("durable");
        try real.storage().sync();
    }

    var reopened = try root.RealStorage.open(std.testing.io, tmp.dir, "log");
    defer reopened.close();
    try std.testing.expectEqual(@as(u64, 7), try reopened.storage().size());

    const all = try reopened.storage().readAll(std.testing.allocator);
    defer std.testing.allocator.free(all);
    try std.testing.expectEqualStrings("durable", all);
}

// ---- fault injection ------------------------------------------------------

/// A storage with 8 synced bytes followed by 8 unsynced ones.
fn seeded(sim: *root.SimStorage) !void {
    const s = sim.storage();
    try s.append("SYNCEDAA"[0..8]);
    try s.sync();
    try s.append("PENDINGB"[0..8]);
}

test "truncation at every byte offset yields exactly that prefix" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seeded(&sim);

    const total = try sim.storage().size();
    var keep: u64 = 0;
    while (keep <= total) : (keep += 1) {
        const image = try sim.crashImage(gpa, .{ .truncation = .{ .keep_bytes = keep } });
        defer gpa.free(image);
        try std.testing.expectEqual(@as(usize, @intCast(keep)), image.len);
        try std.testing.expectEqualStrings("SYNCEDAAPENDINGB"[0..@intCast(keep)], image);
    }
}

test "a lost unsynced tail never costs a synced byte" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seeded(&sim);

    const committed = sim.committedLen();

    // Every subset of the two pending 4-byte pages, including total loss.
    var mask: u64 = 0;
    while (mask < 4) : (mask += 1) {
        const image = try sim.crashImage(gpa, .{ .lost_unsynced_tail = .{
            .page_size = 4,
            .survivor_mask = mask,
        } });
        defer gpa.free(image);

        try std.testing.expectEqualStrings("SYNCEDAA", image[0..committed]);

        const page0 = image[committed .. committed + 4];
        const page1 = image[committed + 4 ..];
        if (mask & 1 == 1) {
            try std.testing.expectEqualStrings("PEND", page0);
        } else {
            try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0 }, page0);
        }
        if (mask & 2 == 2) {
            try std.testing.expectEqualStrings("INGB", page1);
        } else {
            try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0 }, page1);
        }
    }
}

test "a torn sector zeroes its span without shortening the image" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seeded(&sim);

    // Drop sector 0 of 4 bytes: survivors are not a prefix.
    const image = try sim.crashImage(gpa, .{ .torn_sector = .{
        .sector_size = 4,
        .drop_index = 0,
    } });
    defer gpa.free(image);

    try std.testing.expectEqual(@as(usize, 16), image.len);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0 }, image[0..4]);
    try std.testing.expectEqualStrings("EDAAPENDINGB", image[4..]);
}

test "a bit flip alters exactly one byte" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seeded(&sim);

    const clean = try sim.storage().readAll(gpa);
    defer gpa.free(clean);

    const image = try sim.crashImage(gpa, .{ .bit_flip = .{ .at_byte = 3, .mask = 0x20 } });
    defer gpa.free(image);

    try std.testing.expectEqual(clean.len, image.len);
    var differing: usize = 0;
    for (clean, image) |a, b| {
        if (a != b) differing += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), differing);
    try std.testing.expectEqual(clean[3] ^ 0x20, image[3]);
}

test "there is no snapshot to corrupt until snapshots exist" {
    const gpa = std.testing.allocator;
    var sim = root.SimStorage.init(gpa);
    defer sim.deinit();
    try seeded(&sim);

    try std.testing.expectError(error.NoSnapshot, sim.crashImage(gpa, .corrupt_snapshot));
}

// ---- the clock seam -------------------------------------------------------

test "the simulated clock moves only when told to" {
    var sim: root.SimClock = .{};
    const c = sim.clock();

    try std.testing.expectEqual(@as(i64, 0), c.nowMillis());
    try std.testing.expectEqual(@as(i64, 0), c.nowMillis());
    sim.advance(250);
    try std.testing.expectEqual(@as(i64, 250), c.nowMillis());
}

test "the real clock reports wall time" {
    var real = root.RealClock.init(std.testing.io);
    try std.testing.expect(real.clock().nowMillis() > 0);
}
