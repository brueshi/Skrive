const std = @import("std");

// Stage 5.0 build: the Zig Windows host. Cross-compiles from macOS by default
// (Zig's headline trick — no MSVC, no Windows SDK install, no xwin sysroot;
// Win32 import libs come from Zig's bundled MinGW). Build from macOS with a
// plain `zig build`; the artifact is a real Windows PE that only RUNS on
// Windows (WebView2, and the host UI, are Windows-only — the known ceiling
// that holds for every candidate language, not just Zig).
//
// The host links the core as a Zig module (see shell-zig/core/build.zig's
// `addModule("skrive_core", ...)`) and calls its native `Core` API directly.
// The watcher C++ TU rides along with that module and is compiled for the
// Windows target here.
pub fn build(b: *std.Build) void {
    // Default to x86_64-windows-gnu so `zig build` from macOS just works.
    // Override with -Dtarget=aarch64-windows for Windows-on-ARM later.
    const target = b.standardTargetOptions(.{
        .default_target = .{ .cpu_arch = .x86_64, .os_tag = .windows, .abi = .gnu },
    });
    const optimize = b.standardOptimizeOption(.{});

    const core_dep = b.dependency("skrive_core", .{});
    const core_mod = core_dep.module("skrive_core");

    const exe = b.addExecutable(.{
        .name = "Skrive",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.root_module.addImport("skrive_core", core_mod);
    // The core module brings libc++ (the watcher); libc underlies it and the
    // Win32 CRT, so link it explicitly.
    exe.root_module.link_libc = true;
    // Win32 windowing + COM. WebView2 itself is loaded dynamically at runtime
    // (WebView2Loader.dll via LoadLibrary), so nothing is linked for it here.
    exe.root_module.linkSystemLibrary("user32", .{});
    exe.root_module.linkSystemLibrary("gdi32", .{});
    exe.root_module.linkSystemLibrary("ole32", .{}); // CoTaskMemFree
    b.installArtifact(exe);

    // Convenience step; only does anything on a Windows host. Building from
    // macOS, use `zig build` and ship the exe to Windows to run it.
    const run = b.addRunArtifact(exe);
    const run_step = b.step("run", "Run the Windows host (Windows only)");
    run_step.dependOn(&run.step);

    // Host-side unit tests that are pure logic (no Windows APIs), so they
    // compile and RUN on the native build host (macOS). Today: the delivery-
    // rule escaper. Built for the native target, not `target`, so `zig build
    // test` actually executes them on the dev machine.
    const test_step = b.step("test", "Run host unit tests (native; pure-logic only)");
    inline for (.{"src/jsescape.zig"}) |src| {
        const t = b.addTest(.{
            .root_module = b.createModule(.{
                .root_source_file = b.path(src),
                .target = b.graph.host,
                .optimize = optimize,
            }),
        });
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}
