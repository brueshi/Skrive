//------------------------------------------------------------------------------
//  Skrive Zig UI Lab — Stage 0: window, render loop, instrumentation.
//
//  Renders on demand. sokol_app has no public frame-on-demand mode at the
//  pinned commit (its display-link pause is internal, occlusion-only), so the
//  frame callback ticks at display refresh while the window is visible; all
//  GPU work is skipped unless an event marked the frame dirty, which leaves
//  the GPU fully idle and costs one early-out per tick on the CPU.
//
//  Space toggles continuous rendering for benchmarking (the clear color
//  pulses subtly so the mode is visible). HUD is terminal prints only:
//  render CPU time and present count, at most once per second.
//------------------------------------------------------------------------------
const std = @import("std");
const sokol = @import("sokol");
const slog = sokol.log;
const sg = sokol.gfx;
const sapp = sokol.app;
const sglue = sokol.glue;
const stime = sokol.time;

const hud_print_interval_sec: f64 = 1.0;
// Base clear color: neutral warm grey, placeholder until Stage 5 tokens.
const clear_r: f32 = 0.949;
const clear_g: f32 = 0.949;
const clear_b: f32 = 0.941;

const state = struct {
    var pass_action: sg.PassAction = .{};
    var dirty: bool = true; // first frame must render
    var continuous: bool = false;
    var present_count: u64 = 0;
    var pulse_phase: f32 = 0.0;
    // HUD accumulators, reset on each print
    var hud_last_print_ticks: u64 = 0;
    var hud_presents: u64 = 0;
    var hud_render_cpu_ticks: u64 = 0;
    var hud_frame_dur_sec: f64 = 0.0;
};

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
    std.debug.print("backend: {t}\n", .{sg.queryBackend()});
    std.debug.print("device pixel ratio: {d}\n", .{sapp.dpiScale()});
    std.debug.print("framebuffer: {d}x{d} px ({d}x{d} logical)\n", .{
        sapp.width(),
        sapp.height(),
        @as(f32, @floatFromInt(sapp.width())) / sapp.dpiScale(),
        @as(f32, @floatFromInt(sapp.height())) / sapp.dpiScale(),
    });
    std.debug.print("mode: on-demand (space toggles continuous)\n", .{});
}

export fn frame() void {
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

    // Acquire the swapchain outside the timed span: under vsync backpressure
    // Metal's nextDrawable blocks here, which is wait time, not render cost.
    const swapchain = sglue.swapchain();
    const t0 = stime.now();
    sg.beginPass(.{ .action = state.pass_action, .swapchain = swapchain });
    sg.endPass();
    sg.commit();
    const now = stime.now();

    state.present_count += 1;
    state.hud_presents += 1;
    state.hud_render_cpu_ticks += stime.diff(now, t0);
    state.hud_frame_dur_sec += sapp.frameDuration();

    if (stime.sec(stime.diff(now, state.hud_last_print_ticks)) >= hud_print_interval_sec) {
        const presents_f: f64 = @floatFromInt(state.hud_presents);
        const avg_cpu_us = stime.us(state.hud_render_cpu_ticks) / presents_f;
        const avg_frame_ms = state.hud_frame_dur_sec / presents_f * std.time.ms_per_s;
        std.debug.print("presents: {d} total (+{d}) | render cpu avg: {d:.1} us | frame avg: {d:.2} ms ({d:.1} fps) | mode: {s}\n", .{
            state.present_count,
            state.hud_presents,
            avg_cpu_us,
            avg_frame_ms,
            1000.0 / avg_frame_ms,
            if (state.continuous) "continuous" else "on-demand",
        });
        state.hud_last_print_ticks = now;
        state.hud_presents = 0;
        state.hud_render_cpu_ticks = 0;
        state.hud_frame_dur_sec = 0.0;
    }
}

export fn event(ev: ?*const sapp.Event) void {
    const e = ev.?;
    if (e.type == .KEY_DOWN and e.key_code == .SPACE) {
        state.continuous = !state.continuous;
        state.pulse_phase = 0.0;
        std.debug.print("mode: {s}\n", .{if (state.continuous) "continuous" else "on-demand"});
    }
    // Any event invalidates the frame; rendering is cheap enough at Stage 0
    // that finer-grained damage tracking would be premature.
    state.dirty = true;
}

export fn cleanup() void {
    sg.shutdown();
}

pub fn main(process: std.process.Init.Minimal) void {
    // --continuous starts in continuous mode, so benchmark runs don't need
    // a keypress in the window.
    var args = std.process.Args.Iterator.init(process.args);
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--continuous")) {
            state.continuous = true;
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
