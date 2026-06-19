const std = @import("std");

// Stage 2.1 build: the static library exposing the Part I C ABI
// (skrive_core_create / handle / destroy) that the macOS Swift host links,
// plus the `fixture_main` parity harness that the JS parity runner drives
// over stdin/stdout. Command handling lives in src/dispatch.zig behind the
// unchanged ABI; src/errors.zig owns the error->code mapping.
//
// Stage 3 adds the vendored e-dant/watcher C library (vendor/watcher): one
// C++ translation unit compiled into every artifact that pulls in the core,
// linked against libc++ and, on macOS, the CoreFoundation/CoreServices
// frameworks FSEvents needs. `linkWatcher` is applied to each compile so the
// extern symbols in src/watcher.zig resolve regardless of the import graph.
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
    linkWatcher(b, lib.root_module, target);
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
    linkWatcher(b, fixture.root_module, target);
    b.installArtifact(fixture);

    // Unit tests: each source file is its own test compilation so its
    // `test` blocks run. dispatch.zig holds the envelope-validation matrix,
    // errors.zig the wire-string checks, skrive_core.zig the C-ABI
    // round-trip, watcher.zig the live FSEvents smoke test.
    const test_step = b.step("test", "Run core unit tests");
    inline for (.{
        "src/skrive_core.zig",
        "src/dispatch.zig",
        "src/errors.zig",
        "src/fs.zig",
        "src/project.zig",
        "src/persistence.zig",
        "src/filter.zig",
        "src/watcher.zig",
    }) |src| {
        const t = b.addTest(.{
            .root_module = b.createModule(.{
                .root_source_file = b.path(src),
                .target = target,
                .optimize = optimize,
            }),
        });
        linkWatcher(b, t.root_module, target);
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}

/// Compile and link the vendored e-dant/watcher C ABI into `mod`. Every
/// artifact that compiles the core needs this because dispatch.zig pulls in
/// watcher.zig's extern declarations; compiling the single C++ TU per
/// artifact is cheap insurance against undefined symbols. The frameworks are
/// macOS-only (FSEvents); other targets link just the C++ backend.
fn linkWatcher(b: *std.Build, mod: *std.Build.Module, target: std.Build.ResolvedTarget) void {
    mod.addIncludePath(b.path("vendor/watcher/include"));
    mod.addCSourceFile(.{
        .file = b.path("vendor/watcher/src/watcher-c.cpp"),
        // Third-party C++; -fno-sanitize=undefined keeps Debug's default
        // UBSan from instrumenting code we don't own and trapping on benign
        // patterns. c++17 matches upstream's meson/cmake default.
        .flags = &.{ "-std=c++17", "-fno-sanitize=undefined" },
    });
    mod.link_libcpp = true;
    if (target.result.os.tag == .macos) {
        mod.linkFramework("CoreFoundation", .{});
        mod.linkFramework("CoreServices", .{});
    }
}
