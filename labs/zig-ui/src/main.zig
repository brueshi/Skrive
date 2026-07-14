//------------------------------------------------------------------------------
//  Skrive Zig UI Lab — Stage 2: text. stb_truetype, the glyph atlas, and
//  draw.text on top of the Stage 1 batcher.
//
//  Renders on demand (see the Stage 0 note: sokol_app has no public
//  frame-on-demand mode at the pinned commit, so clean frames early-out of
//  all GPU work instead). Space toggles continuous rendering for
//  benchmarking. The HUD is on-screen text (bottom-left, once-per-second
//  refresh); --bench keeps the parseable terminal prints instead.
//
//  Scenes (number keys):
//    1 — demo: fills, radii, borders, shadows for AA eyeballing (default)
//    2 — toast taste test: the Skrive toast-card composed by hand, exact
//        light-theme token values and real text per the shipped CSS
//    3 — stress: 10,000 randomized rounded rects; S toggles shadows on 10%
//    5 — settings: heading + paragraphs + labels over Stage 1 surfaces
//    6 — text wall: the window filled with wrapped 14px paragraphs
//------------------------------------------------------------------------------
const std = @import("std");
const sokol = @import("sokol");
const slog = sokol.log;
const sg = sokol.gfx;
const sapp = sokol.app;
const sglue = sokol.glue;
const stime = sokol.time;

const batch_mod = @import("gfx/batch.zig");
const atlas_mod = @import("gfx/atlas.zig");
const text_mod = @import("gfx/text.zig");
const draw = @import("ui/draw.zig");

const inter_regular_ttf = @embedFile("Inter-Regular.ttf");
const inter_medium_ttf = @embedFile("Inter-Medium.ttf");

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

const Scene = enum { demo, toast, stress, settings, text_wall };

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
        .{ .name = "settings", .scene = .settings },
        .{ .name = "text-wall", .scene = .text_wall },
        .{ .name = "idle-stress-on-demand", .scene = .stress, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
        .{ .name = "idle-settings-on-demand", .scene = .settings, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
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
    var atlas: atlas_mod.Atlas = undefined;
    var font_regular: text_mod.Font = undefined;
    var font_medium: text_mod.Font = undefined;
    var scene: Scene = .demo;
    var stress_shadows: bool = false;
    var stress_size: StressSize = .large;
    var stress_rects: [stress_count]StressRect = undefined;
    var dirty: bool = true; // first frame must render
    var continuous: bool = false;
    var present_count: u64 = 0;
    var pulse_phase: f32 = 0.0;
    // HUD accumulators, reset on each refresh of the on-screen line
    var hud_last_print_ticks: u64 = 0;
    var hud_presents: u64 = 0;
    var hud_build_ticks: u64 = 0;
    var hud_upload_ticks: u64 = 0;
    var hud_encode_ticks: u64 = 0;
    var hud_frame_dur_sec: f64 = 0.0;
    // The rendered HUD line. Refreshed at most once per second at frame end,
    // so what is on screen lags the live numbers by up to a second and the
    // quad/draw counts include the HUD's own glyphs — accepted, and honest
    // about what a frame actually costs.
    var hud_text_buf: [160]u8 = undefined;
    var hud_text_len: usize = 0;
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
    state.atlas = atlas_mod.Atlas.init(std.heap.page_allocator);
    state.font_regular = text_mod.Font.init(0, inter_regular_ttf) catch @panic("zig-ui: Inter Regular failed to parse");
    state.font_medium = text_mod.Font.init(1, inter_medium_ttf) catch @panic("zig-ui: Inter Medium failed to parse");
    initStressRects();
    std.debug.print("backend: {t}\n", .{sg.queryBackend()});
    std.debug.print("device pixel ratio: {d}\n", .{sapp.dpiScale()});
    std.debug.print("framebuffer: {d}x{d} px ({d}x{d} logical)\n", .{
        sapp.width(),
        sapp.height(),
        @as(f32, @floatFromInt(sapp.width())) / sapp.dpiScale(),
        @as(f32, @floatFromInt(sapp.height())) / sapp.dpiScale(),
    });
    std.debug.print("keys: 1 demo | 2 toast | 3 stress | 4 stress small | 5 settings | 6 text wall | S stress shadows | space continuous\n", .{});
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

fn buildToastText(b: *batch_mod.Batch, x: f32, y: f32, w: f32) void {
    const dpi = sapp.dpiScale();
    // The shipped .toast-card text spec: padding 15/17; eyebrow 12px weight
    // 450 muted with a 4px margin below; title 15px weight 600, letter
    // spacing -0.01em. The lab carries Regular(400) and Medium(500), so the
    // eyebrow rounds down to Regular and the title down to Medium — the
    // closest honest approximations, noted in the log.
    _ = draw.text(b, &state.atlas, dpi, .{ x + 17, y + 15 }, "Update", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });
    _ = draw.text(b, &state.atlas, dpi, .{ x + 17, y + 31 }, "Skrive 1.8.7 is ready to install", .{
        .font = &state.font_medium,
        .size = 15,
        .color = skrive.fg,
        .letter_spacing = -0.15, // -0.01em at 15px
    });
    // In-card dismiss: a 15px multiplication sign centered in the 20x20
    // hit area at top 8 / right 8, muted at 0.55 opacity per the CSS.
    const cross = "\u{00d7}";
    const m = draw.measureText(&state.font_regular, 15, dpi, cross, 0);
    _ = draw.text(b, &state.atlas, dpi, .{
        x + w - 28 + (20 - m.width) / 2,
        y + 8 + (20 - m.lineHeight()) / 2,
    }, cross, .{
        .font = &state.font_regular,
        .size = 15,
        .color = skrive.muted.withAlpha(0.55),
    });
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
    buildToastText(b, 180, y, w);

    // Right: the plan 7/Stage-1 variant — warm surface, 1px hairline,
    // large radius, the same soft low shadow.
    draw.rect(b, .{ .x = 664, .y = y, .w = w, .h = h }, .{
        .fill = draw.Color.hex(0xfbf9f4),
        .radius = skrive.radius_xl,
        .border = .{ .width = 1, .color = skrive.rule },
        .shadows = &skrive.shadow_sheet,
    });
    buildToastText(b, 664, y, w);
}

// Settings-page copy: plausible prose, not lorem, so kerning pairs and
// word shapes read like the real app would.
const settings_copy = struct {
    const para1 = "Skrive keeps your writing in plain files on disk, and the window chrome stays out of their way. The theme follows the system by default; every surface in the app reads from one set of design tokens, so a change here lands everywhere at once.";
    const para2 = "Changes apply immediately and persist across sessions. Appearance is chrome, and chrome never touches a document: switching themes repaints pixels, not files.";
};

fn buildSettingsScene(b: *batch_mod.Batch) void {
    const dpi = sapp.dpiScale();
    const fg = skrive.fg;
    const muted = skrive.muted;

    _ = draw.text(b, &state.atlas, dpi, .{ 80, 56 }, "Settings", .{
        .font = &state.font_medium,
        .size = 20,
        .color = fg,
    });

    // The card: white surface, hairline border, small radius, quiet shadow.
    // Height hand-tuned to the content below (layout arrives in Stage 4).
    const card: draw.Rect = .{ .x = 80, .y = 108, .w = 640, .h = 314 };
    draw.rect(b, card, .{
        .fill = skrive.bg,
        .radius = 12,
        .border = .{ .width = 1, .color = skrive.rule },
        .shadows = &.{.{ .offset = .{ 0, 2 }, .sigma = 4, .color = draw.Color.hex(0x000000).withAlpha(0.05) }},
    });

    const pad: f32 = 24;
    const cx = card.x + pad;
    const cw = card.w - 2 * pad;
    var y: f32 = card.y + pad;

    _ = draw.text(b, &state.atlas, dpi, .{ cx, y }, "Appearance", .{
        .font = &state.font_medium,
        .size = 12,
        .color = muted,
    });
    y += 30;

    const para_style: draw.TextStyle = .{ .font = &state.font_regular, .size = 14, .color = fg };
    y += draw.textWrapped(b, &state.atlas, dpi, .{ cx, y }, cw, 21, settings_copy.para1, para_style);
    y += 12;
    y += draw.textWrapped(b, &state.atlas, dpi, .{ cx, y }, cw, 21, settings_copy.para2, para_style);
    y += 20;

    draw.rect(b, .{ .x = cx, .y = y, .w = cw, .h = 1 }, .{ .fill = skrive.rule });
    y += 20;

    // Labeled value rows at 12px.
    const rows = [_][2][]const u8{
        .{ "Theme", "System" },
        .{ "Accent", "Slate indigo" },
        .{ "UI font", "Inter" },
    };
    for (rows) |row| {
        _ = draw.text(b, &state.atlas, dpi, .{ cx, y }, row[0], .{
            .font = &state.font_regular,
            .size = 12,
            .color = muted,
        });
        _ = draw.text(b, &state.atlas, dpi, .{ cx + 420, y }, row[1], .{
            .font = &state.font_regular,
            .size = 12,
            .color = fg,
        });
        y += 26;
    }
}

// A window full of wrapped body text — the text-heavy bench phase. Repeats
// the settings prose until the window is full; quad count lands in the HUD
// and the bench summary.
fn buildTextWallScene(b: *batch_mod.Batch) void {
    const dpi = sapp.dpiScale();
    const style: draw.TextStyle = .{ .font = &state.font_regular, .size = 14, .color = skrive.fg };
    var y: f32 = 40;
    while (y < 760) {
        y += draw.textWrapped(b, &state.atlas, dpi, .{ 80, y }, 1040, 21, settings_copy.para1, style);
        y += 12;
        if (y >= 760) break;
        y += draw.textWrapped(b, &state.atlas, dpi, .{ 80, y }, 1040, 21, settings_copy.para2, style);
        y += 12;
    }
}

fn buildHud(b: *batch_mod.Batch) void {
    if (state.hud_text_len == 0) return;
    _ = draw.text(b, &state.atlas, sapp.dpiScale(), .{ 12, 778 }, state.hud_text_buf[0..state.hud_text_len], .{
        .font = &state.font_regular,
        .size = 11,
        .color = skrive.muted,
    });
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
        .settings => buildSettingsScene(&state.batch),
        .text_wall => buildTextWallScene(&state.batch),
    }
    // Bench runs keep the terminal HUD so scene quad counts stay pure.
    if (!bench.active) buildHud(&state.batch);
    const t_upload = stime.now();
    state.atlas.commit();
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
        state.atlas.view,
        state.atlas.smp,
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
        // Refreshes the on-screen HUD line (the Stage 0/1 terminal print,
        // now rendered by the renderer it measures). Deliberately does NOT
        // mark the frame dirty — that would repaint once a second forever
        // and break frame-on-demand; the line rides the next natural
        // repaint instead, so idle numbers freeze with the frame.
        const hud_line = std.fmt.bufPrint(&state.hud_text_buf, "{d:.2} ms ({d:.0} fps) | build {d:.0} us | quads {d} | draws {d} | atlas {d} px {d:.0}% | {s}{s}", .{
            avg_frame_ms,
            1000.0 / avg_frame_ms,
            stime.us(state.hud_build_ticks) / presents_f,
            state.batch.stats.quads,
            state.batch.stats.draw_calls,
            state.atlas.size,
            state.atlas.occupancy() * 100,
            @tagName(state.scene),
            if (state.continuous) ", continuous" else ", on-demand",
        }) catch state.hud_text_buf[0..0];
        state.hud_text_len = hud_line.len;
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
            ._5 => state.scene = .settings,
            ._6 => state.scene = .text_wall,
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
    // Atlas census on clean exit (--bench quits through here), so every
    // bench log ends with the stage-2 atlas numbers.
    std.debug.print("atlas: {d}x{d} px | {d} glyphs cached | {d:.1}% occupied | {d} growth events\n", .{
        state.atlas.size,
        state.atlas.size,
        state.atlas.cache.count(),
        state.atlas.occupancy() * 100,
        state.atlas.growth_count,
    });
    sg.shutdown();
}

pub fn main(process: std.process.Init.Minimal) void {
    // --continuous starts in continuous mode, so benchmark runs don't need
    // a keypress in the window; scene flags start in that scene. --dpi1
    // opens a non-high-DPI window: glyphs rasterize at 1x, which is the
    // honest way to shoot the "text at 1x" screenshot on a retina display.
    var high_dpi = true;
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
        } else if (std.mem.eql(u8, arg, "--settings")) {
            state.scene = .settings;
        } else if (std.mem.eql(u8, arg, "--text-wall")) {
            state.scene = .text_wall;
        } else if (std.mem.eql(u8, arg, "--dpi1")) {
            high_dpi = false;
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
        .high_dpi = high_dpi,
        .window_title = "Skrive Zig UI Lab",
        .icon = .{ .sokol_default = true },
        .logger = .{ .func = slog.func },
    });
}
