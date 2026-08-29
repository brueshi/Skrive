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

    // The corpus generator. An executable rather than a test so a
    // design-scale corpus can be produced on demand and kept out of the repo.
    const corpus_module = b.createModule(.{
        .root_source_file = b.path("src/corpus_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const corpus_exe = b.addExecutable(.{ .name = "corpus", .root_module = corpus_module });
    b.installArtifact(corpus_exe);
    const corpus_run = b.addRunArtifact(corpus_exe);
    if (b.args) |args| corpus_run.addArgs(args);
    const corpus_step = b.step("corpus", "Generate a synthetic corpus at a chosen tier");
    corpus_step.dependOn(&corpus_run.step);

    // The benchmark. Separate from the tests because it needs a corpus on
    // disk and reports numbers rather than asserting on them.
    const bench_module = b.createModule(.{
        .root_source_file = b.path("src/bench_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const bench_exe = b.addExecutable(.{ .name = "bench", .root_module = bench_module });
    b.installArtifact(bench_exe);
    const bench_run = b.addRunArtifact(bench_exe);
    if (b.args) |args| bench_run.addArgs(args);
    const bench_step = b.step("bench", "Measure cold start and warm search against a corpus");
    bench_step.dependOn(&bench_run.step);

    // The ranking comparison. Prints rather than asserts: whether a ranking
    // is better is a judgement about meaning, not something a test decides.
    const compare_module = b.createModule(.{
        .root_source_file = b.path("src/compare_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const compare_exe = b.addExecutable(.{ .name = "compare", .root_module = compare_module });
    b.installArtifact(compare_exe);
    const compare_run = b.addRunArtifact(compare_exe);
    if (b.args) |args| compare_run.addArgs(args);
    const compare_step = b.step("compare", "Rank real prose with and without the Skrive signals");
    compare_step.dependOn(&compare_run.step);

    // Known-item retrieval evaluation, with automatic ground truth.
    const eval_module = b.createModule(.{
        .root_source_file = b.path("src/eval_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const eval_exe = b.addExecutable(.{ .name = "eval", .root_module = eval_module });
    b.installArtifact(eval_exe);
    const eval_run = b.addRunArtifact(eval_exe);
    if (b.args) |args| eval_run.addArgs(args);
    const eval_step = b.step("eval", "Score retrieval by how well a document finds itself");
    eval_step.dependOn(&eval_run.step);

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    // Conformance fixtures live outside `src/`, so they arrive as anonymous
    // imports. They are canonical `.folio` bytes -- see fixtures/README.md --
    // and the round-trip tests assert the writer reproduces them exactly.
    const fixtures = [_][]const u8{
        "app-written.folio",
        "minimal.folio",
        "kitchen-sink.folio",
        "table-widths.folio",
        "meta-extra.folio",
        "escapes.folio",
    };
    for (fixtures) |name| {
        test_module.addAnonymousImport(name, .{
            .root_source_file = b.path(b.fmt("fixtures/{s}", .{name})),
        });
    }

    const unit_tests = b.addTest(.{ .root_module = test_module });
    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run the zig-data-engine lab unit tests");
    test_step.dependOn(&run_tests.step);
}
