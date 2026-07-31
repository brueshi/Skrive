const std = @import("std");
const sokol = @import("sokol");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const dep_sokol = b.dependency("sokol", .{
        .target = target,
        .optimize = optimize,
    });

    // Shader compilation is an explicit step (`zig build shaders`), not part
    // of the default graph: the generated .zig artifacts are checked in, so
    // ordinary builds never need sokol-shdc. The tool itself arrives as
    // sokol-zig's own `shdc` dependency (prebuilt binaries from
    // floooh/sokol-tools-bin), invoked through sokol-zig's build helper.
    const shaders_step = b.step("shaders", "Regenerate .glsl.zig shader artifacts with sokol-shdc");
    shaders_step.dependOn(try sokol.shdc.createSourceFile(b, .{
        .shdc_dep = dep_sokol.builder.dependency("shdc", .{}),
        .input = "src/gfx/sdf_shapes.glsl",
        .output = "src/gfx/sdf_shapes.glsl.zig",
        .slang = .{
            .metal_macos = true,
            .hlsl5 = true, // Windows smoke test is plan 4.4; free to carry now
        },
    }));

    const root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true, // stb_truetype uses libc (malloc, math)
        .imports = &.{
            .{ .name = "sokol", .module = dep_sokol.module("sokol") },
        },
    });
    // stb_truetype: vendored single header. Declarations come in via
    // @cImport in gfx/text.zig; the implementation is its own C TU.
    root_module.addIncludePath(b.path("vendor/stb"));
    root_module.addCSourceFile(.{ .file = b.path("vendor/stb/stb_truetype.c") });
    // Fonts are embedded (@embedFile by module name); assets/ sits outside
    // the src/ module root, so they arrive as anonymous imports.
    root_module.addAnonymousImport("Inter-Regular.ttf", .{ .root_source_file = b.path("assets/Inter-Regular.ttf") });
    root_module.addAnonymousImport("Inter-Medium.ttf", .{ .root_source_file = b.path("assets/Inter-Medium.ttf") });
    root_module.addAnonymousImport("Inter-SemiBold.ttf", .{ .root_source_file = b.path("assets/Inter-SemiBold.ttf") });
    root_module.addAnonymousImport("Inter-Light.ttf", .{ .root_source_file = b.path("assets/Inter-Light.ttf") });

    const exe = b.addExecutable(.{
        .name = "zig-ui",
        .root_module = root_module,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    const run_step = b.step("run", "Run the zig-ui lab");
    run_step.dependOn(&run_cmd.step);

    // Unit tests (Stage 3): the immediate-mode state machine in ui/context.zig.
    // The module mirrors the exe's config because context.zig pulls the draw ->
    // gfx graph transitively (and thus stb + libc), even though the tests
    // exercise only pure logic.
    const test_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "sokol", .module = dep_sokol.module("sokol") },
        },
    });
    test_module.addIncludePath(b.path("vendor/stb"));
    test_module.addCSourceFile(.{ .file = b.path("vendor/stb/stb_truetype.c") });
    const unit_tests = b.addTest(.{ .root_module = test_module });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run the zig-ui lab unit tests");
    test_step.dependOn(&run_tests.step);
}
