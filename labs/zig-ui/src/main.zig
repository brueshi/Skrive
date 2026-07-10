//------------------------------------------------------------------------------
//  Skrive Zig UI Lab — Stage 1: rect batcher, SDF shape shader, draw API.
//
//  Renders on demand (see the Stage 0 note: sokol_app has no public
//  frame-on-demand mode at the pinned commit, so clean frames early-out of
//  all GPU work instead). Space toggles continuous rendering for
//  benchmarking. HUD is terminal prints only: per-frame CPU timings, quad
//  and draw-call counts, at most once per second.
//
//  Scenes (number keys):
//    1 — demo: fills, radii, borders, shadows for AA eyeballing (default)
//    2 — toast taste test: the Skrive toast-card composed by hand, exact
//        light-theme token values; left = shipped spec (no border), right =
//        the plan's variant (warm surface + 1px hairline)
//    3 — stress: 10,000 randomized rounded rects; S toggles shadows on 10%
//------------------------------------------------------------------------------
const std = @import("std");
const sokol = @import("sokol");
const slog = sokol.log;
const sg = sokol.gfx;
const sapp = sokol.app;
const sglue = sokol.glue;
const stime = sokol.time;

const batch_mod = @import("gfx/batch.zig");
const draw = @import("ui/draw.zig");

const hud_print_interval_sec: f64 = 1.0;
// Base clear color: neutral warm grey, placeholder until Stage 5 tokens.
const clear_r: f32 = 0.949;
const clear_g: f32 = 0.949;
const clear_b: f32 = 0.941;

// Skrive light-theme tokens the toast scene transcribes (app/src/index.css).
const skrive = struct {
    const bg = draw.Color.hex(0xffffff); // --skrive-bg
    const fg = draw.Color.hex(0x1a1a1d); // --skrive-fg
    const muted = draw.Color.hex(0x73737a); // --skrive-muted
    const rule = draw.Color.hex(0xd8d9dd); // --skrive-rule
    const radius_xl: f32 = 16; // --skrive-radius-xl
    // --skrive-shadow-sheet: 0 14px 34px 14%, 0 3px 10px 7%.
    // CSS blur-radius = 2 sigma, so sigmas are 17 and 5.
    const shadow_sheet = [2]draw.Shadow{
        .{ .offset = .{ 0, 14 }, .sigma = 17, .color = draw.Color.hex(0x000000).withAlpha(0.14) },
        .{ .offset = .{ 0, 3 }, .sigma = 5, .color = draw.Color.hex(0x000000).withAlpha(0.07) },
    };
};

const Scene = enum { demo, toast, stress };

const stress_count = 10_000;
const StressRect = struct {
    r: draw.Rect,
    fill: draw.Color,
    radius: f32,
    bordered: bool,
    shadowed: bool, // only drawn when stress_shadows is on (10% of rects)
};

/// Two fill-rate regimes for the same 10k-quad batch. `large` is the plan's
/// literal scene and a fill-rate torture test (~100x screen overdraw);
/// `small` sizes the same count at glyph/chip scale, the overdraw a real UI
/// frame actually produces per 10k quads.
const StressSize = enum {
    large,
    small,

    fn range(self: StressSize) [2]f32 {
        return switch (self) {
            .large => .{ 16, 180 },
            .small => .{ 4, 48 },
        };
    }
};

// Self-driving benchmark (--bench): a fixed phase schedule, keyboard ignored
// so a stray keystroke into the focused window cannot contaminate a run
// (this happened; the machine is a daily driver). Each phase discards a
// warmup, then reports averages and worst frame. The final phase idles
// on-demand with the stress scene on screen and reports the present count,
// which must stay at ~0 for the frame-on-demand exit criterion.
const bench = struct {
    const Phase = struct {
        name: []const u8,
        scene: Scene,
        stress_size: StressSize = .large,
        shadows: bool = false,
        continuous: bool = true,
        warmup_sec: f64 = 3,
        measure_sec: f64 = 9,
    };
    const phases = [_]Phase{
        .{ .name = "stress-large", .scene = .stress },
        .{ .name = "stress-large-shadows", .scene = .stress, .shadows = true },
        .{ .name = "stress-small", .scene = .stress, .stress_size = .small },
        .{ .name = "toast", .scene = .toast },
        .{ .name = "idle-stress-on-demand", .scene = .stress, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
    };

    var active: bool = false;
    var phase_idx: usize = 0;
    var phase_start_ticks: u64 = 0;
    var measuring: bool = false;
    var presents: u64 = 0;
    var build_ticks: u64 = 0;
    var upload_ticks: u64 = 0;
    var encode_ticks: u64 = 0;
    var frame_dur_sec: f64 = 0.0;
    var worst_frame_sec: f64 = 0.0;

    fn enterPhase(idx: usize) void {
        const p = phases[idx];
        phase_idx = idx;
        state.scene = p.scene;
        state.stress_shadows = p.shadows;
        state.continuous = p.continuous;
        if (p.scene == .stress and state.stress_size != p.stress_size) {
            state.stress_size = p.stress_size;
            initStressRects();
        }
        state.dirty = true;
        measuring = false;
        phase_start_ticks = stime.now();
        std.debug.print("bench: {s} (warmup {d:.0}s, measure {d:.0}s)\n", .{ p.name, p.warmup_sec, p.measure_sec });
    }

    fn resetAccumulators() void {
        presents = 0;
        build_ticks = 0;
        upload_ticks = 0;
        encode_ticks = 0;
        frame_dur_sec = 0.0;
        worst_frame_sec = 0.0;
    }

    /// Called on every frame callback tick, including clean ones that skip
    /// rendering (that is what makes the idle phase measurable).
    fn tick() void {
        const p = phases[phase_idx];
        const elapsed = stime.sec(stime.diff(stime.now(), phase_start_ticks));
        if (!measuring and elapsed >= p.warmup_sec) {
            measuring = true;
            resetAccumulators();
        }
        if (elapsed < p.warmup_sec + p.measure_sec) return;

        const presents_f: f64 = @floatFromInt(@max(presents, 1));
        if (p.continuous) {
            const avg_frame_ms = frame_dur_sec / presents_f * std.time.ms_per_s;
            std.debug.print("bench result: {s} | quads: {d} | draw calls: {d} | cpu avg us: build {d:.0} upload {d:.0} encode {d:.0} | frame avg: {d:.2} ms ({d:.1} fps) | frame worst: {d:.2} ms\n", .{
                p.name,
                state.batch.stats.quads,
                state.batch.stats.draw_calls,
                stime.us(build_ticks) / presents_f,
                stime.us(upload_ticks) / presents_f,
                stime.us(encode_ticks) / presents_f,
                avg_frame_ms,
                1000.0 / avg_frame_ms,
                worst_frame_sec * std.time.ms_per_s,
            });
        } else {
            std.debug.print("bench result: {s} | presents during {d:.0}s idle: {d} (0 = frame-on-demand holds)\n", .{
                p.name, p.measure_sec, presents,
            });
        }
        if (phase_idx + 1 < phases.len) {
            enterPhase(phase_idx + 1);
        } else {
            std.debug.print("bench: done\n", .{});
            sapp.requestQuit();
        }
    }
};

const state = struct {
    var pass_action: sg.PassAction = .{};
    var batch: batch_mod.Batch = undefined;
    var scene: Scene = .demo;
    var stress_shadows: bool = false;
    var stress_size: StressSize = .large;
    var stress_rects: [stress_count]StressRect = undefined;
    var dirty: bool = true; // first frame must render
    var continuous: bool = false;
    var present_count: u64 = 0;
    var pulse_phase: f32 = 0.0;
    // HUD accumulators, reset on each print
    var hud_last_print_ticks: u64 = 0;
    var hud_presents: u64 = 0;
    var hud_build_ticks: u64 = 0;
    var hud_upload_ticks: u64 = 0;
    var hud_encode_ticks: u64 = 0;
    var hud_frame_dur_sec: f64 = 0.0;
};

fn initStressRects() void {
    var prng = std.Random.DefaultPrng.init(0x5eed_2026);
    const rnd = prng.random();
    const size = state.stress_size.range();
    var covered_px: f64 = 0;
    for (&state.stress_rects) |*sr| {
        const w = size[0] + rnd.float(f32) * (size[1] - size[0]);
        const h = size[0] + rnd.float(f32) * (size[1] - size[0]);
        covered_px += w * h;
        sr.* = .{
            .r = .{
                .x = rnd.float(f32) * (1200 - w),
                .y = rnd.float(f32) * (800 - h),
                .w = w,
                .h = h,
            },
            .fill = .{
                .r = 0.25 + rnd.float(f32) * 0.7,
                .g = 0.25 + rnd.float(f32) * 0.7,
                .b = 0.25 + rnd.float(f32) * 0.7,
                .a = 0.35 + rnd.float(f32) * 0.65,
            },
            .radius = rnd.float(f32) * @min(w, h) / 2,
            .bordered = rnd.float(f32) < 0.3,
            .shadowed = rnd.float(f32) < 0.1,
        };
    }
    std.debug.print("stress rects: {d} {t}, overdraw {d:.1}x of the 1200x800 window\n", .{
        stress_count,
        state.stress_size,
        covered_px / (1200.0 * 800.0),
    });
}

export fn init() void {
    stime.setup();
    sg.setup(.{
        .environment = sglue.environment(),
        .logger = .{ .func = slog.func },
    });
    state.pass_action.colors[0] = .{
        .load_action = .CLEAR,
        .clear_value = .{ .r = clear_r, .g = clear_g, .b = clear_b, .a = 1 },
    };
    state.batch = batch_mod.Batch.init(std.heap.page_allocator);
    initStressRects();
    std.debug.print("backend: {t}\n", .{sg.queryBackend()});
    std.debug.print("device pixel ratio: {d}\n", .{sapp.dpiScale()});
    std.debug.print("framebuffer: {d}x{d} px ({d}x{d} logical)\n", .{
        sapp.width(),
        sapp.height(),
        @as(f32, @floatFromInt(sapp.width())) / sapp.dpiScale(),
        @as(f32, @floatFromInt(sapp.height())) / sapp.dpiScale(),
    });
    std.debug.print("keys: 1 demo | 2 toast | 3 stress | 4 stress small | S stress shadows | space continuous\n", .{});
    if (bench.active) bench.enterPhase(0);
}

fn buildDemoScene(b: *batch_mod.Batch) void {
    const slate = draw.Color.hex(0x4c5ba6); // --skrive-accent, light theme
    // Row 1: radius ladder on solid fills.
    const radii = [_]f32{ 0, 4, 8, 16, 40 };
    for (radii, 0..) |radius, i| {
        const x = 60 + @as(f32, @floatFromInt(i)) * 120;
        draw.rect(b, .{ .x = x, .y = 60, .w = 80, .h = 80 }, .{ .fill = slate, .radius = radius });
    }
    // Row 2: borders — hairline, 2px, 6px, and a hairline pill.
    const widths = [_]f32{ 1, 2, 6 };
    for (widths, 0..) |width, i| {
        const x = 60 + @as(f32, @floatFromInt(i)) * 120;
        draw.rect(b, .{ .x = x, .y = 190, .w = 80, .h = 80 }, .{
            .fill = skrive.bg,
            .radius = 8,
            .border = .{ .width = width, .color = skrive.rule },
        });
    }
    draw.rect(b, .{ .x = 420, .y = 190, .w = 140, .h = 36 }, .{
        .fill = skrive.bg,
        .radius = 18,
        .border = .{ .width = 1, .color = skrive.muted },
    });
    // Row 3: shadow softness ladder.
    const sigmas = [_]f32{ 4, 12, 24 };
    for (sigmas, 0..) |sigma, i| {
        const x = 60 + @as(f32, @floatFromInt(i)) * 160;
        draw.rect(b, .{ .x = x, .y = 330, .w = 110, .h = 80 }, .{
            .fill = skrive.bg,
            .radius = 12,
            .shadows = &.{.{ .offset = .{ 0, @max(2, sigma / 2) }, .sigma = sigma, .color = draw.Color.hex(0x000000).withAlpha(0.25) }},
        });
    }
    // Row 4: translucent overlaps to verify blending, plus a 1px hairline.
    draw.rect(b, .{ .x = 60, .y = 480, .w = 120, .h = 120 }, .{ .fill = slate.withAlpha(0.4), .radius = 60 });
    draw.rect(b, .{ .x = 130, .y = 480, .w = 120, .h = 120 }, .{ .fill = draw.Color.hex(0xa84030).withAlpha(0.4), .radius = 60 });
    draw.rect(b, .{ .x = 200, .y = 480, .w = 120, .h = 120 }, .{ .fill = draw.Color.hex(0x2e7d5b).withAlpha(0.4), .radius = 60 });
    draw.rect(b, .{ .x = 60, .y = 640, .w = 500, .h = 1 }, .{ .fill = skrive.rule });
}

fn buildToastGreeking(b: *batch_mod.Batch, x: f32, y: f32, w: f32) void {
    // Text placeholders at the .toast-card text positions (padding 15/17,
    // eyebrow 12px + 4 gap, title 15px/1.3). Real text is Stage 2.
    draw.rect(b, .{ .x = x + 17, .y = y + 17, .w = 64, .h = 8 }, .{ .fill = skrive.muted.withAlpha(0.7), .radius = 4 });
    draw.rect(b, .{ .x = x + 17, .y = y + 35, .w = 176, .h = 11 }, .{ .fill = skrive.fg, .radius = 4 });
    // In-card dismiss: 20x20 hit area at top 8 / right 8; greek the glyph
    // as a small dot at its center.
    draw.rect(b, .{ .x = x + w - 22, .y = y + 14, .w = 8, .h = 8 }, .{ .fill = skrive.muted.withAlpha(0.55), .radius = 2 });
}

fn buildToastScene(b: *batch_mod.Batch) void {
    const w: f32 = 356; // sonner's default toast width
    const h: f32 = 66; // padding 15x2 + eyebrow 12 + gap 4 + title 19.5, rounded down
    const y: f32 = 340;

    // Left: the shipped .toast-card spec — white surface, radius 16,
    // the two-layer sheet shadow, no border.
    draw.rect(b, .{ .x = 180, .y = y, .w = w, .h = h }, .{
        .fill = skrive.bg,
        .radius = skrive.radius_xl,
        .shadows = &skrive.shadow_sheet,
    });
    buildToastGreeking(b, 180, y, w);

    // Right: the plan 7/Stage-1 variant — warm surface, 1px hairline,
    // large radius, the same soft low shadow.
    draw.rect(b, .{ .x = 664, .y = y, .w = w, .h = h }, .{
        .fill = draw.Color.hex(0xfbf9f4),
        .radius = skrive.radius_xl,
        .border = .{ .width = 1, .color = skrive.rule },
        .shadows = &skrive.shadow_sheet,
    });
    buildToastGreeking(b, 664, y, w);
}

fn buildStressScene(b: *batch_mod.Batch) void {
    for (&state.stress_rects) |*sr| {
        draw.rect(b, sr.r, .{
            .fill = sr.fill,
            .radius = sr.radius,
            .border = if (sr.bordered) .{ .width = 1, .color = skrive.fg.withAlpha(0.5) } else null,
            .shadows = if (state.stress_shadows and sr.shadowed)
                &.{.{ .offset = .{ 0, 4 }, .sigma = 8, .color = draw.Color.hex(0x000000).withAlpha(0.2) }}
            else
                &.{},
        });
    }
}

export fn frame() void {
    if (bench.active) bench.tick();
    if (!state.continuous and !state.dirty) {
        return;
    }
    state.dirty = false;

    if (state.continuous) {
        // Subtle brightness pulse so continuous mode is visibly on.
        state.pulse_phase += @floatCast(sapp.frameDuration());
        const pulse = 0.02 * @sin(state.pulse_phase * 2.0);
        state.pass_action.colors[0].clear_value.g = clear_g + pulse;
    } else {
        state.pass_action.colors[0].clear_value.g = clear_g;
    }

    const t_build = stime.now();
    state.batch.begin();
    switch (state.scene) {
        .demo => buildDemoScene(&state.batch),
        .toast => buildToastScene(&state.batch),
        .stress => buildStressScene(&state.batch),
    }
    const t_upload = stime.now();
    state.batch.upload();
    const t_uploaded = stime.now();

    // Acquire the swapchain outside every timed span: under vsync
    // backpressure Metal's nextDrawable blocks here, which is wait time,
    // not render cost.
    const swapchain = sglue.swapchain();
    const t_encode = stime.now();
    sg.beginPass(.{ .action = state.pass_action, .swapchain = swapchain });
    state.batch.draw(
        .{ @floatFromInt(sapp.width()), @floatFromInt(sapp.height()) },
        sapp.dpiScale(),
    );
    sg.endPass();
    sg.commit();
    const now = stime.now();

    state.present_count += 1;
    state.hud_presents += 1;
    state.hud_build_ticks += stime.diff(t_upload, t_build);
    state.hud_upload_ticks += stime.diff(t_uploaded, t_upload);
    state.hud_encode_ticks += stime.diff(now, t_encode);
    state.hud_frame_dur_sec += sapp.frameDuration();

    if (bench.active and bench.measuring) {
        bench.presents += 1;
        bench.build_ticks += stime.diff(t_upload, t_build);
        bench.upload_ticks += stime.diff(t_uploaded, t_upload);
        bench.encode_ticks += stime.diff(now, t_encode);
        bench.frame_dur_sec += sapp.frameDuration();
        bench.worst_frame_sec = @max(bench.worst_frame_sec, sapp.frameDuration());
    }

    if (!bench.active and stime.sec(stime.diff(now, state.hud_last_print_ticks)) >= hud_print_interval_sec) {
        const presents_f: f64 = @floatFromInt(state.hud_presents);
        const avg_frame_ms = state.hud_frame_dur_sec / presents_f * std.time.ms_per_s;
        std.debug.print("presents: {d} total (+{d}) | quads: {d} | draw calls: {d} | cpu avg us: build {d:.0} upload {d:.0} encode {d:.0} | frame avg: {d:.2} ms ({d:.1} fps) | {s}{s}\n", .{
            state.present_count,
            state.hud_presents,
            state.batch.stats.quads,
            state.batch.stats.draw_calls,
            stime.us(state.hud_build_ticks) / presents_f,
            stime.us(state.hud_upload_ticks) / presents_f,
            stime.us(state.hud_encode_ticks) / presents_f,
            avg_frame_ms,
            1000.0 / avg_frame_ms,
            @tagName(state.scene),
            if (state.continuous) ", continuous" else ", on-demand",
        });
        state.hud_last_print_ticks = now;
        state.hud_presents = 0;
        state.hud_build_ticks = 0;
        state.hud_upload_ticks = 0;
        state.hud_encode_ticks = 0;
        state.hud_frame_dur_sec = 0.0;
    }
}

export fn event(ev: ?*const sapp.Event) void {
    const e = ev.?;
    if (bench.active) return; // keys must not contaminate a bench run
    if (e.type == .KEY_DOWN) {
        switch (e.key_code) {
            .SPACE => {
                state.continuous = !state.continuous;
                state.pulse_phase = 0.0;
                std.debug.print("mode: {s}\n", .{if (state.continuous) "continuous" else "on-demand"});
            },
            ._1 => state.scene = .demo,
            ._2 => state.scene = .toast,
            ._3 => {
                state.scene = .stress;
                if (state.stress_size != .large) {
                    state.stress_size = .large;
                    initStressRects();
                }
            },
            ._4 => {
                state.scene = .stress;
                if (state.stress_size != .small) {
                    state.stress_size = .small;
                    initStressRects();
                }
            },
            .S => {
                state.stress_shadows = !state.stress_shadows;
                std.debug.print("stress shadows: {s}\n", .{if (state.stress_shadows) "on (10% of rects)" else "off"});
            },
            else => {},
        }
    }
    // Any event invalidates the frame; rendering is cheap enough at this
    // stage that finer-grained damage tracking would be premature.
    state.dirty = true;
}

export fn cleanup() void {
    sg.shutdown();
}

pub fn main(process: std.process.Init.Minimal) void {
    // --continuous starts in continuous mode, so benchmark runs don't need
    // a keypress in the window; --stress starts in the stress scene.
    var args = std.process.Args.Iterator.init(process.args);
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--continuous")) {
            state.continuous = true;
        } else if (std.mem.eql(u8, arg, "--stress")) {
            state.scene = .stress;
        } else if (std.mem.eql(u8, arg, "--stress-small")) {
            state.scene = .stress;
            state.stress_size = .small;
        } else if (std.mem.eql(u8, arg, "--toast")) {
            state.scene = .toast;
        } else if (std.mem.eql(u8, arg, "--bench")) {
            bench.active = true;
        }
    }
    sapp.run(.{
        .init_cb = init,
        .frame_cb = frame,
        .event_cb = event,
        .cleanup_cb = cleanup,
        .width = 1200,
        .height = 800,
        .high_dpi = true,
        .window_title = "Skrive Zig UI Lab",
        .icon = .{ .sokol_default = true },
        .logger = .{ .func = slog.func },
    });
}
