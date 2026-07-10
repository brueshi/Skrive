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

    const exe = b.addExecutable(.{
        .name = "zig-ui",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "sokol", .module = dep_sokol.module("sokol") },
            },
        }),
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    const run_step = b.step("run", "Run the zig-ui lab");
    run_step.dependOn(&run_cmd.step);
}
