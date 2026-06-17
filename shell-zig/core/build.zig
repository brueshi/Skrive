const std = @import("std");

// Stage 2.1 build: the static library exposing the Part I C ABI
// (skrive_core_create / handle / destroy) that the macOS Swift host links,
// plus the `fixture_main` parity harness that the JS parity runner drives
// over stdin/stdout. Command handling lives in src/dispatch.zig behind the
// unchanged ABI; src/errors.zig owns the error->code mapping.
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

    // The parity harness: a small executable reading request JSONL on
    // stdin and writing responses on stdout. Installed to zig-out/bin so
    // the parity runner can invoke it by path with `--exec`.
    const fixture = b.addExecutable(.{
        .name = "fixture_main",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/fixture_main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(fixture);

    // Unit tests: each source file is its own test compilation so its
    // `test` blocks run. dispatch.zig holds the envelope-validation matrix,
    // errors.zig the wire-string checks, skrive_core.zig the C-ABI
    // round-trip.
    const test_step = b.step("test", "Run core unit tests");
    inline for (.{ "src/skrive_core.zig", "src/dispatch.zig", "src/errors.zig", "src/fs.zig", "src/project.zig" }) |src| {
        const t = b.addTest(.{
            .root_module = b.createModule(.{
                .root_source_file = b.path(src),
                .target = target,
                .optimize = optimize,
            }),
        });
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}
