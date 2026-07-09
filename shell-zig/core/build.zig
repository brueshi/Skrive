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
    // An OMITTED `-Doptimize` means ReleaseSafe here, not Debug (SKR-236). It was
    // omitted: build-macos.sh never passed the flag to the Zig step, so every shipped
    // macOS build linked an -O0 core. A forgotten flag must fail toward "optimized and
    // checked", never toward "unoptimized" (this bug) or "unchecked" (its Windows twin,
    // SKR-235).
    //
    // Rolled by hand rather than with `standardOptimizeOption`'s `preferred_optimize_
    // mode`: that field does not mean "default to this". It swaps `-Doptimize` for a
    // `-Drelease` boolean and still resolves to Debug when the flag is absent, which is
    // the exact hazard this line exists to remove. Measured, not assumed.
    //
    // ReleaseSafe keeps every runtime safety check -- bounds, overflow, null unwrap --
    // so an out-of-bounds slice aborts with a stack trace into the crash-log pipeline
    // instead of reading adjacent memory. The core is a file watcher, a dispatch table
    // and a loopback file server; nothing here is hot enough to buy anything by turning
    // the checks off.
    const optimize = b.option(
        std.builtin.OptimizeMode,
        "optimize",
        "Prioritize performance, safety, or binary size (default: ReleaseSafe)",
    ) orelse .ReleaseSafe;

    const lib = b.addLibrary(.{
        .name = "skrive_core",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/skrive_core.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    // The static archive carries the watcher C++ objects but does not link
    // frameworks (an archive has no link step; the final consumer — the Swift
    // host, via Package.swift — links FSEvents). Crucially this keeps the lib
    // buildable under an explicit `-Dtarget=...macos` where Zig has no SDK
    // framework search path. `zig build lib` builds just this, for the host.
    linkWatcher(b, lib.root_module, target, false);
    const install_lib = b.addInstallArtifact(lib, .{});
    b.getInstallStep().dependOn(&install_lib.step);
    const lib_step = b.step("lib", "Install only the static core library (for the Swift host)");
    lib_step.dependOn(&install_lib.step);

    // Stage 5: expose the core as a consumable Zig module so the Windows host
    // (shell-zig/windows) can `@import` it and call the native `Core` API
    // directly — no C-ABI marshaling between a Zig host and a Zig core. The C
    // ABI above stays reserved for genuinely foreign hosts (the Swift macOS
    // host). The watcher C++ TU travels with the module, so any dependent
    // compiles it for its own target (verified cross-building to x86_64-windows
    // from macOS in Stage 5.0). This is purely additive: nothing in the
    // existing lib/fixture/test graph depends on it, so native builds are
    // unaffected; it only compiles when the host exe pulls it in.
    const core_mod = b.addModule("skrive_core", .{
        .root_source_file = b.path("src/skrive_core.zig"),
    });
    core_mod.addIncludePath(b.path("vendor/watcher/include"));
    core_mod.addCSourceFile(.{
        .file = b.path("vendor/watcher/src/watcher-c.cpp"),
        .flags = &.{ "-std=c++17", "-fno-sanitize=undefined" },
    });
    core_mod.link_libcpp = true;

    // The parity harness: a small executable reading request JSONL on
    // stdin and writing responses on stdout. Installed to zig-out/bin so
    // the parity runner can invoke it by path with `--exec`. Built and run
    // natively (the SDK is present), so it links FSEvents directly.
    const fixture = b.addExecutable(.{
        .name = "fixture_main",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/fixture_main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    linkWatcher(b, fixture.root_module, target, true);
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
        linkWatcher(b, t.root_module, target, true);
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}

/// Compile the vendored e-dant/watcher C ABI into `mod`. Every artifact that
/// compiles the core needs this because dispatch.zig pulls in watcher.zig's
/// extern declarations; compiling the single C++ TU per artifact is cheap
/// insurance against undefined symbols, and link_libcpp supplies the C++
/// stdlib the backend uses. `link_frameworks` adds the macOS FSEvents
/// frameworks — set it for executables that actually link (tests, the fixture
/// harness, both built natively), but NOT for the static archive: an archive
/// has no link step, and `-framework` would fail under an explicit
/// `-Dtarget=...macos` that lacks an SDK framework search path. The Swift host
/// links the frameworks itself (Package.swift).
fn linkWatcher(b: *std.Build, mod: *std.Build.Module, target: std.Build.ResolvedTarget, link_frameworks: bool) void {
    mod.addIncludePath(b.path("vendor/watcher/include"));
    mod.addCSourceFile(.{
        .file = b.path("vendor/watcher/src/watcher-c.cpp"),
        // Third-party C++; -fno-sanitize=undefined keeps Debug's default
        // UBSan from instrumenting code we don't own and trapping on benign
        // patterns. c++17 matches upstream's meson/cmake default.
        .flags = &.{ "-std=c++17", "-fno-sanitize=undefined" },
    });
    mod.link_libcpp = true;
    // Under an explicit `-Dtarget=...macos` Zig treats this as cross-compiling
    // and doesn't auto-detect the host SDK, so the watcher's framework-style
    // `#include <CoreFoundation/...>` can't be found. When the build is given
    // the SDK via `--sysroot`, add its framework dir so the C++ TU compiles.
    // Native builds (no sysroot) auto-detect and need nothing here.
    if (b.sysroot) |sysroot| {
        mod.addSystemFrameworkPath(.{
            .cwd_relative = b.pathJoin(&.{ sysroot, "System/Library/Frameworks" }),
        });
        mod.addSystemIncludePath(.{
            .cwd_relative = b.pathJoin(&.{ sysroot, "usr/include" }),
        });
        // The macOS host links this archive against the SYSTEM libc++, which on
        // older releases doesn't export std::__1::__hash_memory (Zig's newer
        // bundled libc++ references it from the watcher). Supply it. Only here:
        // native/Windows builds link Zig's libc++, which already defines it, so
        // adding the shim there would be a duplicate symbol. See the file.
        mod.addCSourceFile(.{
            .file = b.path("src/libcxx_compat.cpp"),
            // -fno-sanitize=undefined like the watcher: Debug's default UBSan
            // would otherwise instrument the hash arithmetic and reference
            // UBSan runtime symbols absent from this archive's final link.
            .flags = &.{ "-std=c++17", "-fno-sanitize=undefined" },
        });
    }
    if (link_frameworks and target.result.os.tag == .macos) {
        mod.linkFramework("CoreFoundation", .{});
        mod.linkFramework("CoreServices", .{});
    }
}
