//! Test aggregator. Runs headless via `zig build test`.

const std = @import("std");
const root = @import("root.zig");

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
