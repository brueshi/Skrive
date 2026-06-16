const std = @import("std");

// Stage 1 spike build: produce a static library exposing the Part I C ABI
// (skrive_core_create / handle / destroy). The macOS Swift host links this
// archive and imports the matching header via a modulemap. Only app:version
// is implemented; Stage 2 grows the dispatcher behind the same ABI.
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addLibrary(.{
        .name = "skrive_core",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/skrive_core.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(lib);

    // Unit tests live in the library module (the C-ABI round-trip check).
    const lib_tests = b.addTest(.{ .root_module = lib.root_module });
    const run_lib_tests = b.addRunArtifact(lib_tests);
    const test_step = b.step("test", "Run core unit tests");
    test_step.dependOn(&run_lib_tests.step);
}
