const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // No dependencies, no C, no linked system libraries. The lab's whole
    // point is a small, exhaustively testable surface, and the build graph is
    // held to the same standard: if this ever needs a dependency, that is a
    // decision to argue, not a convenience to reach for.
    //
    // The module is published under the lab's name because this lab is
    // classified load-bearing: the eventual consumer depends on a published
    // artifact, never a path import.
    _ = b.addModule("zig-data-engine", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    const unit_tests = b.addTest(.{ .root_module = test_module });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run the zig-data-engine lab unit tests");
    test_step.dependOn(&run_tests.step);
}
