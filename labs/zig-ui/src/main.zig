//------------------------------------------------------------------------------
//  Skrive Zig UI Lab — Stage 4: layout and the small kit. Row/column boxes,
//  toggle and segmented, and the first animation, on top of the Stage 3 widget
//  layer and the Stage 1-2 renderer.
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
//    7 — buttons: a live row of buttons wired to visible effects (Stage 3)
//    8 — showcase: every button / toggle / segmented visual state at once,
//        deterministic, for the screenshot deliverable (no live input needed)
//    9 — card: the Stage 4 settings card — heading, three labeled rows
//        (segmented, toggle, button), laid out entirely by ui/layout.zig with
//        zero absolute coordinates, resizing with the window
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
const ui_context = @import("ui/context.zig");
const widgets = @import("ui/widgets.zig");
const layout = @import("ui/layout.zig");

const inter_regular_ttf = @embedFile("Inter-Regular.ttf");
const inter_medium_ttf = @embedFile("Inter-Medium.ttf");
const inter_semibold_ttf = @embedFile("Inter-SemiBold.ttf");
const inter_light_ttf = @embedFile("Inter-Light.ttf");

const hud_print_interval_sec: f64 = 1.0;
// Base clear color: neutral warm grey, placeholder until Stage 5 tokens.
const clear_r: f32 = 0.949;
const clear_g: f32 = 0.949;
const clear_b: f32 = 0.941;

// The buttons demo's "Cycle background" walks this palette. All kept light so
// the by-eye light-theme buttons stay legible; index 0 is the Stage 0-2 base.
const clear_palette = [_][3]f32{
    .{ clear_r, clear_g, clear_b },
    .{ 0.945, 0.955, 0.960 },
    .{ 0.960, 0.950, 0.940 },
    .{ 0.930, 0.940, 0.935 },
};

// Skrive light-theme tokens — since Stage 5 the one transcription in
// ui/tokens.zig, which every scene and widget reads. The `skrive` name stays
// because the scenes read naturally through it.
const skrive = @import("ui/tokens.zig");

const Scene = enum { demo, toast, stress, settings, text_wall, buttons, showcase, card };

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
        /// Flip the card's toggle on entry, so an idle phase can prove both
        /// halves of the animation criterion: the transition repaints while it
        /// is moving (presents during warmup) and stops dead once it settles
        /// (0 presents through the measure window). --bench ignores the
        /// keyboard, so the only way to animate anything is from in here.
        kick_animation: bool = false,
    };
    const phases = [_]Phase{
        .{ .name = "stress-large", .scene = .stress },
        .{ .name = "stress-large-shadows", .scene = .stress, .shadows = true },
        .{ .name = "stress-small", .scene = .stress, .stress_size = .small },
        .{ .name = "toast", .scene = .toast },
        .{ .name = "settings", .scene = .settings },
        .{ .name = "text-wall", .scene = .text_wall },
        .{ .name = "buttons", .scene = .buttons },
        .{ .name = "card", .scene = .card },
        .{ .name = "idle-stress-on-demand", .scene = .stress, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
        .{ .name = "idle-settings-on-demand", .scene = .settings, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
        .{ .name = "idle-buttons-on-demand", .scene = .buttons, .continuous = false, .warmup_sec = 1, .measure_sec = 15 },
        .{ .name = "idle-card-after-toggle", .scene = .card, .continuous = false, .warmup_sec = 1, .measure_sec = 15, .kick_animation = true },
    };

    var active: bool = false;
    var phase_idx: usize = 0;
    var phase_start_ticks: u64 = 0;
    var measuring: bool = false;
    var presents: u64 = 0;
    var phase_presents: u64 = 0; // every render since the phase began
    var warmup_presents: u64 = 0; // the above, snapshotted when measuring starts
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
        if (p.kick_animation) state.bm_measure_rule = !state.bm_measure_rule;
        state.dirty = true;
        measuring = false;
        phase_presents = 0;
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
            warmup_presents = phase_presents;
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
        } else if (p.kick_animation) {
            std.debug.print("bench result: {s} | quads: {d} | draw calls: {d} | presents during the {d:.0}s settle window: {d} (the animation) | presents during {d:.0}s idle after: {d} (0 = the animation stopped marking the frame dirty)\n", .{
                p.name,
                state.batch.stats.quads,
                state.batch.stats.draw_calls,
                p.warmup_sec,
                warmup_presents,
                p.measure_sec,
                presents,
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
    var font_semibold: text_mod.Font = undefined;
    var font_light: text_mod.Font = undefined;
    // The settings pane title renders in --skrive-editor-font — Iowan Old
    // Style, an Apple system font. Loaded from the system at runtime (plan
    // 4.3's rule for fonts the lab may not vendor); null when the file is
    // missing, and the title falls back to Inter SemiBold with a log line.
    var font_serif: ?text_mod.Font = null;
    var serif_data: []u8 = &.{};
    var scene: Scene = .demo;
    var stress_shadows: bool = false;
    var stress_size: StressSize = .large;
    var stress_rects: [stress_count]StressRect = undefined;
    var dirty: bool = true; // first frame must render
    var continuous: bool = false;
    var present_count: u64 = 0;
    var pulse_phase: f32 = 0.0;
    // Buttons demo (Stage 3): the effects the demo buttons drive, plus the
    // immediate-mode context and the input accumulated between frames. Mouse
    // position is a level (logical px); pressed/released/tab/activate are
    // edges the event handler sets and the rendered frame clears once consumed.
    var clear_index: usize = 0;
    var toast_visible: bool = false;
    var ctx: ui_context.Context = .{};
    var mouse: [2]f32 = .{ -1, -1 };
    var mouse_down: bool = false;
    var ev_pressed: bool = false;
    var ev_released: bool = false;
    var ev_tab: bool = false;
    var ev_shift: bool = false;
    var ev_activate: bool = false;
    var ev_nav_prev: bool = false;
    var ev_nav_next: bool = false;
    // Wall clock of the last *rendered* frame, which under frame-on-demand is
    // not the display interval. The animation store takes dt from this.
    var last_frame_ticks: u64 = 0;
    // The benchmark scene's bound values (Stage 5): the real Editor pane's
    // Writing section, transcribed row for row from SettingsView.tsx.
    var bm_line_measure: usize = 1; // "Normal"
    var bm_measure_rule: bool = true;
    var bm_smart_typo: bool = true;
    var bm_spellcheck: bool = false;
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

/// The shipped settings title renders in Iowan Old Style at font-weight 600,
/// which CSS font matching resolves to the family's Bold face (the nearest
/// weight >= 600 the collection carries). Load exactly that face out of the
/// system .ttc so the benchmark's most prominent line compares typeface for
/// typeface. Failure is soft: the title falls back to Inter SemiBold and the
/// side-by-side notes it.
fn loadSystemSerif() void {
    // std.posix, not std.fs: Zig 0.16 routed fs reads through the new
    // std.Io interface, and threading an Io instance through sokol callbacks
    // is the same disproportion Stage 0 hit with timers. The posix layer is
    // still direct.
    const path = "/System/Library/Fonts/Supplemental/Iowan Old Style.ttc";
    const fd = std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY }, 0) catch {
        std.debug.print("serif: {s} not found; title falls back to Inter SemiBold\n", .{path});
        return;
    };
    defer _ = std.c.close(fd); // posix.close is gone in 0.16; libc is linked anyway
    // No fstat on this std surface either — read to EOF under a fixed cap.
    // The collection is ~3.4MB; 16MB is generous headroom, and the buffer
    // stays alive for the process lifetime because stbtt_fontinfo keeps
    // pointers into it.
    const cap: usize = 16 << 20;
    const data = std.heap.page_allocator.alloc(u8, cap) catch return;
    var off: usize = 0;
    while (off < cap) {
        const n = std.posix.read(fd, data[off..]) catch break;
        if (n == 0) break;
        off += n;
    }
    if (off == 0 or off == cap) {
        std.heap.page_allocator.free(data);
        std.debug.print("serif: unreadable or oversized; title falls back to Inter SemiBold\n", .{});
        return;
    }
    state.serif_data = data[0..off];

    var namebuf: [64]u8 = undefined;
    const n = text_mod.faceCount(state.serif_data);
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        const f = text_mod.Font.initFace(4, state.serif_data, i) catch continue;
        const sub = f.subfamily(&namebuf) orelse continue;
        if (std.mem.eql(u8, sub, "Bold")) {
            state.font_serif = f;
            std.debug.print("serif: Iowan Old Style Bold (face {d} of {d})\n", .{ i, n });
            return;
        }
    }
    std.debug.print("serif: no Bold face in {d}-face collection; title falls back to Inter SemiBold\n", .{n});
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
    // Distinct font ids: the atlas cache is keyed (font id, glyph, px), so a
    // new face with a reused id would serve another weight's bitmaps.
    state.font_semibold = text_mod.Font.init(2, inter_semibold_ttf) catch @panic("zig-ui: Inter SemiBold failed to parse");
    state.font_light = text_mod.Font.init(3, inter_light_ttf) catch @panic("zig-ui: Inter Light failed to parse");
    loadSystemSerif();
    initStressRects();
    std.debug.print("backend: {t}\n", .{sg.queryBackend()});
    std.debug.print("device pixel ratio: {d}\n", .{sapp.dpiScale()});
    std.debug.print("framebuffer: {d}x{d} px ({d}x{d} logical)\n", .{
        sapp.width(),
        sapp.height(),
        @as(f32, @floatFromInt(sapp.width())) / sapp.dpiScale(),
        @as(f32, @floatFromInt(sapp.height())) / sapp.dpiScale(),
    });
    std.debug.print("keys: 1 demo | 2 toast | 3 stress | 4 stress small | 5 settings | 6 text wall | 7 buttons | 8 showcase | 9 card | S stress shadows | Tab/Space/Enter buttons | space continuous\n", .{});
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

fn painter(b: *batch_mod.Batch) widgets.Painter {
    return .{
        .b = b,
        .atlas = &state.atlas,
        .dpi = sapp.dpiScale(),
        .font = &state.font_regular,
        .font_medium = &state.font_medium,
        .font_semibold = &state.font_semibold,
    };
}

// A single toast at (x, y), reusing the shipped-spec surface + text the toast
// scene already composes. The buttons demo pops this when "Toggle toast" fires.
fn buildDemoToast(b: *batch_mod.Batch, x: f32, y: f32) void {
    const w: f32 = 356;
    const h: f32 = 66;
    draw.rect(b, .{ .x = x, .y = y, .w = w, .h = h }, .{
        .fill = skrive.bg,
        .radius = skrive.radius_xl,
        .shadows = &skrive.shadow_sheet,
    });
    buildToastText(b, x, y, w);
}

// The live Stage 3 button row: real interaction through the immediate-mode
// context, each button wired to a visible effect. A fired button that changes
// the clear color or continuous mode marks the frame dirty so the change shows
// on the next frame (the clear is set before the scene builds).
fn buildButtonsScene(b: *batch_mod.Batch) void {
    const dpi = sapp.dpiScale();
    var p = painter(b);

    _ = draw.text(b, &state.atlas, dpi, .{ 80, 56 }, "Buttons", .{
        .font = &state.font_medium,
        .size = 20,
        .color = skrive.fg,
    });
    _ = draw.text(b, &state.atlas, dpi, .{ 80, 92 }, "Hover, click, Tab to move focus, Space or Enter to activate.", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });

    var fired = false;
    const gap: f32 = 12;
    const y: f32 = 132;
    var x: f32 = 80;

    const r_toast = widgets.button(&state.ctx, &p, x, y, "Toggle toast", .{ .variant = .primary });
    if (r_toast.fired) {
        state.toast_visible = !state.toast_visible;
        fired = true;
    }
    x += r_toast.rect.w + gap;

    const r_bg = widgets.button(&state.ctx, &p, x, y, "Cycle background", .{});
    if (r_bg.fired) {
        state.clear_index = (state.clear_index + 1) % clear_palette.len;
        fired = true;
    }
    x += r_bg.rect.w + gap;

    // Dynamic label, stable identity: hashing the display text would flip the
    // button's ID when the label changes and drop its hot/active/focus state,
    // so identity keys off id_label instead.
    const cont_label = if (state.continuous) "Continuous: on" else "Continuous: off";
    const r_cont = widgets.button(&state.ctx, &p, x, y, cont_label, .{ .id_label = "continuous-toggle", .min_width = 140 });
    if (r_cont.fired) {
        state.continuous = !state.continuous;
        state.pulse_phase = 0;
        fired = true;
    }
    x += r_cont.rect.w + gap;

    const r_reset = widgets.button(&state.ctx, &p, x, y, "Reset", .{ .variant = .secondary });
    if (r_reset.fired) {
        state.clear_index = 0;
        state.toast_visible = false;
        state.continuous = false;
        fired = true;
    }
    x += r_reset.rect.w + gap;

    _ = widgets.button(&state.ctx, &p, x, y, "Disabled", .{ .disabled = true });

    if (fired) state.dirty = true;
    if (state.toast_visible) buildDemoToast(b, 422, 470);
}

//------------------------------------------------------------------------------
//  The Stage 5 benchmark scene: the shipped Editor pane's "Writing" section,
//  transcribed row for row from SettingsView.tsx — same copy, same controls,
//  same specs (.settings-col / -pane-head / -section-cap / -card / -row, all
//  via ui/tokens.zig) — plus a CONTROLS strip underneath so Button and
//  IconButton appear in the side-by-side (labelled as such: the strip is kit
//  coverage, not part of the shipped section). The pane title renders in the
//  system's Iowan Old Style Bold, exactly the face the shipped CSS resolves
//  font-weight 600 to; everything else is Inter against the shipped system
//  stack (the typeface-flavour question the screenshots disclose).
//
//  Layout discipline unchanged from Stage 4: zero absolute coordinates;
//  every rect comes out of a Box, spacing is explicit spacer children where
//  the CSS uses margins.
//------------------------------------------------------------------------------
const CardControl = union(enum) {
    toggle: *bool,
    segmented: struct { options: []const []const u8, selected: *usize },
};

const CardRow = struct {
    label: []const u8,
    desc: []const u8,
    id: []const u8, // stable widget identity, independent of the visible text
    control: CardControl,
};

const line_measure_options = [_][]const u8{ "Narrow", "Normal", "Wide", "Full", "Custom" };

fn benchmarkRows() [4]CardRow {
    return .{
        .{
            .label = "Line measure",
            .desc = "Width of the writing column.",
            .id = "bm-line-measure",
            .control = .{ .segmented = .{ .options = &line_measure_options, .selected = &state.bm_line_measure } },
        },
        .{
            .label = "Measure rule",
            .desc = "A hairline at the writing column's edge.",
            .id = "bm-measure-rule",
            .control = .{ .toggle = &state.bm_measure_rule },
        },
        .{
            .label = "Smart typography",
            .desc = "Curly quotes, em dashes, and ellipses as you type.",
            .id = "bm-smart-typo",
            .control = .{ .toggle = &state.bm_smart_typo },
        },
        .{
            .label = "Check spelling",
            .desc = "Underline misspelled words as you write.",
            .id = "bm-spellcheck",
            .control = .{ .toggle = &state.bm_spellcheck },
        },
    };
}

fn buildCardScene(b: *batch_mod.Batch) void {
    const dpi = sapp.dpiScale();
    var p = painter(b);
    const rows = benchmarkRows();

    const win: draw.Rect = .{
        .x = 0,
        .y = 0,
        .w = @as(f32, @floatFromInt(sapp.width())) / dpi,
        .h = @as(f32, @floatFromInt(sapp.height())) / dpi,
    };

    const title_font: *const text_mod.Font = if (state.font_serif) |*f| f else &state.font_semibold;
    const label_m = draw.measureText(&state.font_medium, skrive.settings_label_size, dpi, "Hg", 0);
    const desc_m = draw.measureText(&state.font_regular, skrive.settings_desc_size, dpi, "Hg", 0);
    const title_m = draw.measureText(title_font, skrive.settings_title_size, dpi, "Hg", 0);
    const sub_m = draw.measureText(&state.font_regular, skrive.settings_sub_size, dpi, "Hg", 0);
    const cap_m = draw.measureText(&state.font_semibold, skrive.settings_cap_size, dpi, "HG", 0);
    // .settings-row-text: label (lh 18) + 3px gap + desc (lh 16).
    const row_text_gap: f32 = 3;
    const text_h = skrive.settings_label_line_height + row_text_gap + skrive.settings_desc_line_height;

    // .settings-col: max-width 720 (content-box), centred, 44px top padding.
    // Margins from the CSS become explicit spacer children.
    // CSS line boxes, not natural font line heights: the root line-height of
    // 1.5 applies to the title, sub, and cap (none declares its own), and the
    // browser centres each font box in its line box via half-leading. Using
    // natural heights here left the whole card sitting 11px higher than the
    // reference — measured off the first side-by-side, then fixed.
    const title_box = skrive.settings_title_size * skrive.ui_line_height; // 37.5
    const sub_box = skrive.settings_sub_size * skrive.ui_line_height; // 20.25
    const cap_box = skrive.settings_cap_size * skrive.ui_line_height; // 16.5

    var page = layout.Box.column(win, .{
        .padding = .xy(44, 40),
        .cross = .center,
    });
    const col_w = @min(720, win.w - 80);
    const i_title = page.add(.{ .main = .{ .content = title_box }, .cross = col_w });
    _ = page.add(.{ .main = .{ .fixed = 5.25 } }); // .settings-pane-sub margin-top 0.375rem
    const i_sub = page.add(.{ .main = .{ .content = sub_box }, .cross = col_w });
    _ = page.add(.{ .main = .{ .fixed = 28 } }); // .settings-pane-head margin-bottom
    const i_cap = page.add(.{ .main = .{ .content = cap_box }, .cross = col_w });
    _ = page.add(.{ .main = .{ .fixed = 10 } }); // .settings-section-cap margin-bottom
    const i_card = page.add(.{ .main = .{ .grow = 1 }, .cross = col_w });
    const page_rects = page.resolve();

    _ = draw.text(b, &state.atlas, dpi, .{
        page_rects[i_title].x,
        page_rects[i_title].y + (title_box - title_m.lineHeight()) / 2,
    }, "Editor", .{
        .font = title_font,
        .size = skrive.settings_title_size,
        .color = skrive.fg,
        .letter_spacing = -0.25, // -0.01em at 25px, per .settings-pane-title
    });
    _ = draw.text(b, &state.atlas, dpi, .{
        page_rects[i_sub].x,
        page_rects[i_sub].y + (sub_box - sub_m.lineHeight()) / 2,
    }, "Defaults for new documents and how writing behaves.", .{
        .font = &state.font_regular,
        .size = skrive.settings_sub_size,
        .color = skrive.muted,
    });
    _ = draw.text(b, &state.atlas, dpi, .{
        page_rects[i_cap].x + 2,
        page_rects[i_cap].y + (cap_box - cap_m.lineHeight()) / 2,
    }, "WRITING", .{
        .font = &state.font_semibold, // .settings-section-cap font-weight 600
        .size = skrive.settings_cap_size,
        .color = skrive.settings_cap,
        .letter_spacing = 0.77, // 0.07em at 11px
    });

    // The card column: one child per row, plus a hairline between them. Its
    // height is never written down anywhere — Fit.content computes it.
    var card = layout.Box.column(page_rects[i_card], .{ .main = .content });
    var row_slots: [rows.len]usize = undefined;
    for (rows, 0..) |row, i| {
        if (i > 0) _ = card.add(.{ .main = .{ .fixed = 1 } }); // .settings-row + .settings-row border-top
        const control_h: f32 = switch (row.control) {
            .toggle => widgets.toggle_h,
            .segmented => widgets.segmented_h,
        };
        row_slots[i] = card.add(.{ .main = .{ .fixed = 2 * skrive.settings_row_pad_y + @max(text_h, control_h) } });
    }
    const card_rects = card.resolve();
    const card_rect = card.resolvedBounds();

    // .settings-card: bg, rule border, lg radius, --skrive-card-shadow (the
    // Stage 4 by-eye shadow was 0 2px / sigma 4 — the token is quieter).
    draw.rect(b, card_rect, .{
        .fill = skrive.bg,
        .radius = skrive.radius_lg,
        .border = .{ .width = 1, .color = skrive.rule },
        .shadows = &skrive.card_shadow,
    });

    var fired = false;
    for (rows, 0..) |row, i| {
        if (i > 0) {
            const hair = card_rects[row_slots[i] - 1];
            // --settings-hair, the lightened hairline (was rule at 60%).
            draw.rect(b, hair, .{ .fill = skrive.settings_hair });
        }

        const control_w: f32 = switch (row.control) {
            .toggle => widgets.toggle_w,
            .segmented => |sg_ctl| widgets.segmentedWidth(&p, sg_ctl.options, sg_ctl.selected.*),
        };
        const control_h: f32 = switch (row.control) {
            .toggle => widgets.toggle_h,
            .segmented => widgets.segmented_h,
        };

        var r = layout.Box.row(card_rects[row_slots[i]], .{
            .padding = .xy(skrive.settings_row_pad_y, skrive.settings_row_pad_x),
            .gap = skrive.settings_row_gap,
            .cross = .center,
        });
        const i_text = r.add(.{ .main = .{ .grow = 1 } }); // flex: 1; min-width: 0
        const i_ctl = r.add(.{ .main = .{ .fixed = control_w }, .cross = control_h }); // flex-shrink: 0
        const row_rects = r.resolve();

        var tc = layout.Box.column(row_rects[i_text], .{ .gap = row_text_gap });
        const i_label = tc.add(.{ .main = .{ .content = skrive.settings_label_line_height } });
        const i_desc = tc.add(.{ .main = .{ .content = skrive.settings_desc_line_height } });
        const text_rects = tc.resolve();

        // Labels draw centred in their CSS line boxes (18px/16px), the same
        // half-leading placement the browser gives them.
        _ = draw.text(b, &state.atlas, dpi, .{
            text_rects[i_label].x,
            text_rects[i_label].y + (skrive.settings_label_line_height - label_m.lineHeight()) / 2,
        }, row.label, .{
            .font = &state.font_medium,
            .size = skrive.settings_label_size,
            .color = skrive.fg,
        });
        _ = draw.text(b, &state.atlas, dpi, .{
            text_rects[i_desc].x,
            text_rects[i_desc].y + (skrive.settings_desc_line_height - desc_m.lineHeight()) / 2,
        }, row.desc, .{
            .font = &state.font_regular,
            .size = skrive.settings_desc_size,
            .color = skrive.muted,
        });

        const ctl = row_rects[i_ctl];
        switch (row.control) {
            .toggle => |value| {
                if (widgets.toggle(&state.ctx, &p, ctl.x, ctl.y, row.id, value, .{}).changed) fired = true;
            },
            .segmented => |sg_ctl| {
                if (widgets.segmented(&state.ctx, &p, ctl.x, ctl.y, row.id, sg_ctl.options, sg_ctl.selected, .{}).changed) fired = true;
            },
        }
    }

    // The kit-coverage strip: Button variants + the three transcribed icons.
    // Not part of the shipped Writing section — the screenshots say so — but
    // present on both sides of the comparison, laid out like a settings row.
    var strip = layout.Box.column(.{
        .x = page_rects[i_card].x,
        .y = card_rect.y + card_rect.h,
        .w = col_w,
        .h = 200,
    }, .{});
    _ = strip.add(.{ .main = .{ .fixed = 28 } }); // .settings-section margin
    const i_strip_cap = strip.add(.{ .main = .{ .content = cap_m.lineHeight() } });
    _ = strip.add(.{ .main = .{ .fixed = 10 } });
    const i_strip_row = strip.add(.{ .main = .{ .content = widgets.button_h } });
    const strip_rects = strip.resolve();

    _ = draw.text(b, &state.atlas, dpi, .{ strip_rects[i_strip_cap].x + 2, strip_rects[i_strip_cap].y }, "CONTROLS", .{
        .font = &state.font_semibold,
        .size = skrive.settings_cap_size,
        .color = skrive.settings_cap,
        .letter_spacing = 0.77,
    });

    var controls = layout.Box.row(strip_rects[i_strip_row], .{ .gap = 12, .cross = .center });
    const i_b1 = controls.add(.{ .main = .{ .content = widgets.buttonWidth(&p, "Save", .{}) }, .cross = widgets.button_h });
    const i_b2 = controls.add(.{ .main = .{ .content = widgets.buttonWidth(&p, "Check for updates\u{2026}", .{}) }, .cross = widgets.button_h });
    const i_b3 = controls.add(.{ .main = .{ .content = widgets.buttonWidth(&p, "Cancel", .{}) }, .cross = widgets.button_h });
    const i_b4 = controls.add(.{ .main = .{ .content = widgets.buttonWidth(&p, "Add", .{}) }, .cross = widgets.button_h });
    _ = controls.add(.{ .main = .{ .fixed = 8 } });
    const i_ic1 = controls.add(.{ .main = .{ .fixed = 26 }, .cross = 26 });
    const i_ic2 = controls.add(.{ .main = .{ .fixed = 26 }, .cross = 26 });
    const i_ic3 = controls.add(.{ .main = .{ .fixed = 26 }, .cross = 26 });
    const c_rects = controls.resolve();

    _ = widgets.button(&state.ctx, &p, c_rects[i_b1].x, c_rects[i_b1].y, "Save", .{ .variant = .primary });
    if (widgets.button(&state.ctx, &p, c_rects[i_b2].x, c_rects[i_b2].y, "Check for updates\u{2026}", .{}).fired) {
        state.toast_visible = !state.toast_visible;
        fired = true;
    }
    _ = widgets.button(&state.ctx, &p, c_rects[i_b3].x, c_rects[i_b3].y, "Cancel", .{ .variant = .secondary });
    _ = widgets.button(&state.ctx, &p, c_rects[i_b4].x, c_rects[i_b4].y, "Add", .{ .disabled = true });
    if (widgets.iconButton(&state.ctx, &p, c_rects[i_ic1].x, c_rects[i_ic1].y, .pin, "bm-pin", .{}).fired) {
        state.toast_visible = !state.toast_visible;
        fired = true;
    }
    _ = widgets.iconButton(&state.ctx, &p, c_rects[i_ic2].x, c_rects[i_ic2].y, .search, "bm-search", .{});
    _ = widgets.iconButton(&state.ctx, &p, c_rects[i_ic3].x, c_rects[i_ic3].y, .plus, "bm-plus", .{});

    if (state.toast_visible) buildDemoToast(b, win.w / 2 - 178, win.h - 110);
    if (fired) state.dirty = true;
}

// The screenshot deliverable: every visual state rendered at once, driven by
// forced state rather than live input, so the states are deterministic and no
// mouse-warping is needed. It goes through the exact resolve()+draw path the
// live widget uses, so it is honest about how each state looks.
fn buildShowcaseScene(b: *batch_mod.Batch) void {
    const dpi = sapp.dpiScale();
    var p = painter(b);

    _ = draw.text(b, &state.atlas, dpi, .{ 80, 56 }, "Component states", .{
        .font = &state.font_medium,
        .size = 20,
        .color = skrive.fg,
    });

    const states = [_]widgets.ShowcaseState{ .normal, .hovered, .pressed, .focused, .disabled };
    const state_labels = [_][]const u8{ "Default", "Hover", "Pressed", "Focused", "Disabled" };
    const rows = [_]struct { variant: widgets.Variant, name: []const u8 }{
        .{ .variant = .primary, .name = "Primary" },
        .{ .variant = .default, .name = "Default" },
        .{ .variant = .secondary, .name = "Secondary" },
    };

    // Column captions.
    const col_x0: f32 = 200;
    const col_w: f32 = 190;
    for (state_labels, 0..) |lbl, i| {
        _ = draw.text(b, &state.atlas, dpi, .{ col_x0 + @as(f32, @floatFromInt(i)) * col_w, 104 }, lbl, .{
            .font = &state.font_regular,
            .size = 11,
            .color = skrive.muted,
        });
    }

    var y: f32 = 132;
    for (rows) |row| {
        _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 9 }, row.name, .{
            .font = &state.font_regular,
            .size = 12,
            .color = skrive.muted,
        });
        for (states, 0..) |s, i| {
            _ = widgets.buttonShowcase(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, "Button", row.variant, s);
        }
        y += 64;
    }

    // Stage 4 widgets, same five states. The toggle gets two rows because its
    // states multiply against on/off, which is the whole point of it.
    const toggle_rows = [_]struct { on: bool, name: []const u8 }{
        .{ .on = false, .name = "Toggle off" },
        .{ .on = true, .name = "Toggle on" },
    };
    y += 12;
    for (toggle_rows) |row| {
        _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 3 }, row.name, .{
            .font = &state.font_regular,
            .size = 12,
            .color = skrive.muted,
        });
        for (states, 0..) |s, i| {
            _ = widgets.toggleShowcase(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, row.on, s);
        }
        y += 44;
    }

    const seg_options = [_][]const u8{ "Light", "Dark", "System" };
    y += 12;
    _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 8 }, "Segmented", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });
    for (states, 0..) |s, i| {
        _ = widgets.segmentedShowcase(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, &seg_options, 1, s);
    }

    // IconButton (Stage 5): the five states on the search glyph, then the
    // three transcribed icons at rest — the pin is the vocabulary-edge case.
    y += 44;
    _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 5 }, "IconButton", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });
    for (states, 0..) |s, i| {
        _ = widgets.iconButtonShowcase(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, .search, s);
    }
    y += 36;
    _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 5 }, "Icons", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });
    const icon_set = [_]widgets.icons.Icon{ .pin, .search, .plus };
    for (icon_set, 0..) |ic, i| {
        _ = widgets.iconButtonShowcase(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, ic, .normal);
    }

    // The animated in-between states, sampled along the transition the
    // animation store drives. Not a caught frame — see toggleShowcaseAt.
    y += 56;
    _ = draw.text(b, &state.atlas, dpi, .{ 80, y + 3 }, "Mid-transition", .{
        .font = &state.font_regular,
        .size = 12,
        .color = skrive.muted,
    });
    const ladder = [_]f32{ 0, 0.25, 0.5, 0.75, 1 };
    for (ladder, 0..) |t, i| {
        _ = widgets.toggleShowcaseAt(&p, col_x0 + @as(f32, @floatFromInt(i)) * col_w, y, t);
    }
}

export fn frame() void {
    if (bench.active) bench.tick();
    if (!state.continuous and !state.dirty) {
        return;
    }
    state.dirty = false;

    // Seconds since the last rendered frame. Measured here rather than from
    // sapp.frameDuration() because on-demand frames are separated by however
    // long the user sat still, and the animation store is written to take
    // exactly that.
    const frame_ticks = stime.now();
    const dt: f32 = if (state.last_frame_ticks == 0)
        0
    else
        @floatCast(stime.sec(stime.diff(frame_ticks, state.last_frame_ticks)));
    state.last_frame_ticks = frame_ticks;

    // The benchmark scene sits on --skrive-bg like the shipped settings
    // content area (an editor-frame white card); every other scene keeps the
    // neutral grey so AA and shadows stay judgeable against a non-white field.
    const clear_base = if (state.scene == .card) [3]f32{ 1, 1, 1 } else clear_palette[state.clear_index];
    state.pass_action.colors[0].clear_value.r = clear_base[0];
    state.pass_action.colors[0].clear_value.b = clear_base[2];
    if (state.continuous) {
        // Subtle brightness pulse so continuous mode is visibly on.
        state.pulse_phase += @floatCast(sapp.frameDuration());
        const pulse = 0.02 * @sin(state.pulse_phase * 2.0);
        state.pass_action.colors[0].clear_value.g = clear_base[1] + pulse;
    } else {
        state.pass_action.colors[0].clear_value.g = clear_base[1];
    }

    // Immediate-mode input for this frame, built from the accumulated event
    // state. begin() resolves Tab against last frame's focusables, so a Tab
    // this frame lands the focus ring on the new widget in this same frame.
    state.ctx.begin(.{
        .mouse = state.mouse,
        .mouse_down = state.mouse_down,
        .pressed = state.ev_pressed,
        .released = state.ev_released,
        .tab = state.ev_tab,
        .shift = state.ev_shift,
        .activate = state.ev_activate,
        .nav_prev = state.ev_nav_prev,
        .nav_next = state.ev_nav_next,
    }, dt);

    const t_build = stime.now();
    state.batch.begin();
    switch (state.scene) {
        .demo => buildDemoScene(&state.batch),
        .toast => buildToastScene(&state.batch),
        .stress => buildStressScene(&state.batch),
        .settings => buildSettingsScene(&state.batch),
        .text_wall => buildTextWallScene(&state.batch),
        .buttons => buildButtonsScene(&state.batch),
        .showcase => buildShowcaseScene(&state.batch),
        .card => buildCardScene(&state.batch),
    }
    // Bench runs keep the terminal HUD so scene quad counts stay pure.
    if (!bench.active) buildHud(&state.batch);
    // Input edges consumed this frame; end() swaps the focusable list and
    // returns the cursor to show. Clear the one-shot edges (levels persist).
    sapp.setMouseCursor(state.ctx.end());
    state.ev_pressed = false;
    state.ev_released = false;
    state.ev_tab = false;
    state.ev_activate = false;
    state.ev_nav_prev = false;
    state.ev_nav_next = false;

    // The animation half of frame-on-demand, and the only place it can be
    // decided: *after* the scene is built, because a widget retargets its
    // animation while drawing. An in-flight value asks for the next frame; the
    // frame that lands on the target asks for nothing, and the app goes quiet.
    if (state.ctx.anim.animating()) state.dirty = true;
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

    if (bench.active) bench.phase_presents += 1;
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
    if (bench.active) return; // input must not contaminate a bench run
    const dpi = sapp.dpiScale();
    switch (e.type) {
        // Mouse position arrives in framebuffer px; hit tests are in logical
        // px, so divide by the DPI scale here once.
        .MOUSE_MOVE, .MOUSE_ENTER => state.mouse = .{ e.mouse_x / dpi, e.mouse_y / dpi },
        .MOUSE_LEAVE => state.mouse = .{ -1, -1 }, // drop hover when the pointer leaves
        .MOUSE_DOWN => if (e.mouse_button == .LEFT) {
            state.mouse = .{ e.mouse_x / dpi, e.mouse_y / dpi };
            state.mouse_down = true;
            state.ev_pressed = true;
        },
        .MOUSE_UP => if (e.mouse_button == .LEFT) {
            state.mouse = .{ e.mouse_x / dpi, e.mouse_y / dpi };
            state.mouse_down = false;
            state.ev_released = true;
        },
        .KEY_DOWN => switch (e.key_code) {
            .SPACE => {
                // In the buttons scene Space activates the focused widget;
                // elsewhere it stays the continuous-mode debug toggle. Guarded
                // against key-repeat so holding it does not machine-gun.
                if (state.scene == .buttons or state.scene == .card) {
                    if (!e.key_repeat) state.ev_activate = true;
                } else {
                    state.continuous = !state.continuous;
                    state.pulse_phase = 0.0;
                    std.debug.print("mode: {s}\n", .{if (state.continuous) "continuous" else "on-demand"});
                }
            },
            .ENTER => if (!e.key_repeat) {
                state.ev_activate = true;
            },
            .TAB => {
                state.ev_tab = true;
                state.ev_shift = (e.modifiers & sapp.modifier_shift) != 0;
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
            ._7 => state.scene = .buttons,
            ._8 => state.scene = .showcase,
            ._9 => state.scene = .card,
            // Directional selection inside a focused radiogroup (the segmented
            // control). Guarded against key-repeat so holding an arrow does not
            // machine-gun through the options.
            .LEFT => if (!e.key_repeat) {
                state.ev_nav_prev = true;
            },
            .RIGHT => if (!e.key_repeat) {
                state.ev_nav_next = true;
            },
            .S => {
                state.stress_shadows = !state.stress_shadows;
                std.debug.print("stress shadows: {s}\n", .{if (state.stress_shadows) "on (10% of rects)" else "off"});
            },
            else => {},
        },
        else => {},
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
    // initAllocator, not init: `init` is @compileError on Windows (the command
    // line arrives as one WTF-16 string that has to be split and re-encoded),
    // and it is a plain no-op wrapper on posix. Found by the Stage 4 Windows
    // smoke build — it was the *only* thing that stood between this and a
    // clean cross-compile.
    var args = std.process.Args.Iterator.initAllocator(process.args, std.heap.page_allocator) catch
        @panic("zig-ui: could not read the command line");
    defer args.deinit();
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
        } else if (std.mem.eql(u8, arg, "--buttons")) {
            state.scene = .buttons;
        } else if (std.mem.eql(u8, arg, "--showcase")) {
            state.scene = .showcase;
        } else if (std.mem.eql(u8, arg, "--card")) {
            state.scene = .card;
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
