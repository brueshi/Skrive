//------------------------------------------------------------------------------
//  widgets.zig — the widgets (Stage 3: button. Stage 4: toggle, segmented).
//
//  A widget is a function you call every frame. It sizes itself, routes
//  interaction through the immediate-mode context, resolves its visual state
//  honestly (default / hover / pressed / focused / disabled), and returns what
//  happened. There is no widget object and no retained tree.
//
//  Styling is by-eye from the shipped kit (app/src/components/ui), NOT a
//  transcription of tokens.css — exact tokens arrive in Stage 5. Values here
//  are plausible round numbers picked to sit next to the real components:
//  13px label, 9px radius, ~34px tall buttons, the slate-indigo focus ring;
//  the 40x23 toggle track and 30px segmented strip the real CSS specifies.
//
//  Stage 4 splits each widget in two: a `*Interact` half that is pure state
//  (context in, decision out, no drawing) and a drawing half that calls it.
//  That is not ceremony — the lab's window cannot be hand-driven from the
//  agent shell, so the half that decides things has to be runnable headless
//  under `zig build test`, exactly as Stage 3 made end() return the cursor
//  instead of calling sokol. The split also keeps the side effect at the edge.
//------------------------------------------------------------------------------
const std = @import("std");
const draw = @import("draw.zig");
const context = @import("context.zig");
const layout = @import("layout.zig");
const anim = @import("anim.zig");
const batch = @import("../gfx/batch.zig");
const atlas_mod = @import("../gfx/atlas.zig");
const text_mod = @import("../gfx/text.zig");

const Context = context.Context;
const Color = draw.Color;

/// Bundles the drawing dependencies so widget signatures stay short. The two
/// weights match the shipped UI face (Inter Regular for body labels, Medium
/// for the primary action's bit of extra presence).
pub const Painter = struct {
    b: *batch.Batch,
    atlas: *atlas_mod.Atlas,
    dpi: f32,
    font: *const text_mod.Font, // Inter Regular
    font_medium: *const text_mod.Font, // Inter Medium
};

// By-eye palette (light theme), the same hexes the toast scene already reads
// from index.css. Not tokens.css — Stage 5 replaces these with the real set.
pub const pal = struct {
    const fg = Color.hex(0x1a1a1d); // --skrive-fg
    const muted = Color.hex(0x73737a); // --skrive-muted
    const rule = Color.hex(0xd8d9dd); // --skrive-rule
    const accent = Color.hex(0x4c5ba6); // --skrive-accent / focus ring
    const on_primary = Color.hex(0xffffff);
    pub const bg = Color.hex(0xffffff); // --skrive-bg
};

// Geometry, by eye from the shipped Button (radius 9, ~13px label, snug pads).
const font_size: f32 = 13;
const height: f32 = 34;
const radius: f32 = 9;
const pad_x: f32 = 16;

pub const Variant = enum { default, secondary, primary };

pub const ButtonOpts = struct {
    variant: Variant = .default,
    disabled: bool = false,
    min_width: f32 = 0,
    /// Disambiguates repeated labels; only needed when two buttons share text.
    disc: u64 = 0,
    /// A stable identity string for buttons whose visible label changes each
    /// frame (a toggle showing "on"/"off"). When null, identity keys off the
    /// display label.
    id_label: ?[]const u8 = null,
};

pub const ButtonResult = struct {
    fired: bool,
    rect: draw.Rect, // measured geometry, so a caller can advance a row
};

const Visual = struct {
    fill: Color,
    border: ?draw.Border,
    text: Color,
};

/// Map the five honest states onto fill / border / text. Hover and pressed
/// deepen a translucent wash for the outline variants; primary dims toward the
/// background on hover (CSS `opacity: 0.85`) and darkens when pressed.
fn resolve(variant: Variant, it: context.Interaction, disabled: bool) Visual {
    var v: Visual = switch (variant) {
        .default => .{ .fill = pal.fg.withAlpha(0), .border = .{ .width = 1, .color = pal.rule }, .text = pal.fg },
        .secondary => .{ .fill = pal.fg.withAlpha(0), .border = .{ .width = 1, .color = pal.rule }, .text = pal.muted },
        .primary => .{ .fill = pal.fg, .border = null, .text = pal.on_primary },
    };

    if (it.pressed) {
        switch (variant) {
            .default => v.fill = pal.fg.withAlpha(0.10),
            .secondary => {
                v.fill = pal.fg.withAlpha(0.09);
                v.border = .{ .width = 1, .color = pal.muted };
                v.text = pal.fg;
            },
            .primary => v.fill = mix(pal.fg, Color.hex(0x000000), 0.18),
        }
    } else if (it.hovered) {
        switch (variant) {
            .default => v.fill = pal.fg.withAlpha(0.05),
            .secondary => {
                v.fill = pal.fg.withAlpha(0.04);
                v.border = .{ .width = 1, .color = pal.muted };
                v.text = pal.fg;
            },
            .primary => {
                // CSS opacity 0.85: fade the whole element toward the surface.
                v.fill = pal.fg.withAlpha(0.85);
                v.text = pal.on_primary.withAlpha(0.85);
            },
        }
    }

    if (disabled) {
        // CSS `:disabled { opacity: 0.5 }` — scale every layer's alpha.
        v.fill = v.fill.withAlpha(v.fill.a * 0.5);
        v.text = v.text.withAlpha(v.text.a * 0.5);
        if (v.border) |*bd| bd.color = bd.color.withAlpha(bd.color.a * 0.5);
    }
    return v;
}

fn mix(a: Color, b: Color, t: f32) Color {
    return .{
        .r = a.r + (b.r - a.r) * t,
        .g = a.g + (b.g - a.g) * t,
        .b = a.b + (b.b - a.b) * t,
        .a = a.a + (b.a - a.a) * t,
    };
}

pub fn button(ctx: *Context, p: *const Painter, x: f32, y: f32, label: []const u8, opts: ButtonOpts) ButtonResult {
    const label_font = if (opts.variant == .primary) p.font_medium else p.font;
    const m = draw.measureText(label_font, font_size, p.dpi, label, 0);
    const w = @max(opts.min_width, @ceil(m.width) + 2 * pad_x);
    const rect: draw.Rect = .{ .x = x, .y = y, .w = w, .h = height };

    const wid = Context.id(opts.id_label orelse label, opts.disc);
    const it = ctx.interact(wid, rect, .{ .disabled = opts.disabled });
    const v = resolve(opts.variant, it, opts.disabled);

    draw.rect(p.b, rect, .{ .fill = v.fill, .radius = radius, .border = v.border });
    _ = draw.text(p.b, p.atlas, p.dpi, .{
        x + (w - m.width) / 2,
        y + (height - m.lineHeight()) / 2,
    }, label, .{ .font = label_font, .size = font_size, .color = v.text });

    if (it.focused) drawFocusRing(p, rect, radius);
    return .{ .fired = it.fired, .rect = rect };
}

/// Screenshot-only: render one button in a forced visual state, no context or
/// live input involved. Goes through the same resolve()+draw path as button(),
/// so it shows each state exactly as the interactive widget would.
pub const ShowcaseState = enum { normal, hovered, pressed, focused, disabled };

pub fn buttonShowcase(p: *const Painter, x: f32, y: f32, label: []const u8, variant: Variant, s: ShowcaseState) draw.Rect {
    const it: context.Interaction = switch (s) {
        .normal, .disabled => .{},
        .hovered => .{ .hovered = true },
        .pressed => .{ .pressed = true },
        .focused => .{ .focused = true },
    };
    const disabled = s == .disabled;
    const label_font = if (variant == .primary) p.font_medium else p.font;
    const m = draw.measureText(label_font, font_size, p.dpi, label, 0);
    const w = @ceil(m.width) + 2 * pad_x;
    const rect: draw.Rect = .{ .x = x, .y = y, .w = w, .h = height };

    const v = resolve(variant, it, disabled);
    draw.rect(p.b, rect, .{ .fill = v.fill, .radius = radius, .border = v.border });
    _ = draw.text(p.b, p.atlas, p.dpi, .{
        x + (w - m.width) / 2,
        y + (height - m.lineHeight()) / 2,
    }, label, .{ .font = label_font, .size = font_size, .color = v.text });
    if (it.focused) drawFocusRing(p, rect, radius);
    return rect;
}

/// A 2px slate-indigo ring, offset a few px outside the control — the shipped
/// :focus-visible outline. Fill alpha 0 so only the ring paints; drawn last so
/// it sits above the fill.
fn drawFocusRing(p: *const Painter, r: draw.Rect, ring_radius: f32) void {
    const gap: f32 = 3;
    draw.rect(p.b, .{ .x = r.x - gap, .y = r.y - gap, .w = r.w + 2 * gap, .h = r.h + 2 * gap }, .{
        .fill = pal.accent.withAlpha(0),
        .radius = ring_radius + gap,
        .border = .{ .width = 2, .color = pal.accent.withAlpha(0.5) },
    });
}

//------------------------------------------------------------------------------
//  Toggle (Stage 4).
//
//  Geometry is the shipped Toggle.module.css, which states it outright: a
//  40x23 track with 2px padding holds a 19px knob with 17px of travel, and the
//  press-stretch widens the knob to 22px toward its leading edge (off grows
//  rightward from the pinned left pad; on grows leftward, which the CSS spells
//  as translateX dropping 17 -> 14). Those constants are tied together, so
//  they live next to each other here too.
//
//  Two things the CSS does that the Stage 1 shape shader cannot: `inset`
//  shadows (the sunken track rim) and a 0-blur 0.5px shadow ring under the
//  knob. The rim becomes a 1px border at the same colour and the ring becomes
//  a 0.5px border — visually the same thing at this scale, and honest about
//  what the renderer supports. Logged rather than faked.
//
//  The widget carries no visible label: neither does the shipped one (it is a
//  bare switch with an aria-label, and the settings row supplies the text).
//  The label string here is identity only.
//------------------------------------------------------------------------------
pub const toggle_w: f32 = 40;
pub const toggle_h: f32 = 23;
const toggle_pad: f32 = 2;
const knob_size: f32 = 19;
const knob_stretch: f32 = 22;
const knob_travel: f32 = toggle_w - 2 * toggle_pad - knob_size; // 17

pub const ToggleOpts = struct {
    disabled: bool = false,
    disc: u64 = 0,
};

pub const ToggleResult = struct {
    changed: bool,
    rect: draw.Rect,
};

/// The decision half: hit test, fire, flip. `value` is written in place, the
/// way an immediate-mode toggle is normally called (`toggle(ctx, "wrap", &on)`
/// rather than plumbing a callback). Pure over the context — no drawing, so
/// this runs headless in tests.
pub fn toggleInteract(
    ctx: *Context,
    id_label: []const u8,
    rect: draw.Rect,
    value: *bool,
    opts: ToggleOpts,
) struct { it: context.Interaction, changed: bool, wid: u64 } {
    const wid = Context.id(id_label, opts.disc);
    const it = ctx.interact(wid, rect, .{ .disabled = opts.disabled });
    if (it.fired) value.* = !value.*;
    // The ID travels back out with the decision so the drawing half animates
    // the same identity it interacted as: computing it twice is how a widget
    // quietly detaches from its own state (the Stage 3 dynamic-label bug).
    return .{ .it = it, .changed = it.fired, .wid = wid };
}

pub fn toggle(
    ctx: *Context,
    p: *const Painter,
    x: f32,
    y: f32,
    id_label: []const u8,
    value: *bool,
    opts: ToggleOpts,
) ToggleResult {
    const rect: draw.Rect = .{ .x = x, .y = y, .w = toggle_w, .h = toggle_h };
    const r = toggleInteract(ctx, id_label, rect, value, opts);

    // Two animated values per toggle: `on_t` drives both the knob's travel and
    // the track's colour (they are the same transition), `knob_w` the press
    // stretch. Both are retargetable, so a double-flick reverses mid-slide.
    const on_t = ctx.anim.value(anim.Store.key(r.wid, 0), if (value.*) 1 else 0);
    const knob_w = ctx.anim.value(anim.Store.key(r.wid, 1), if (r.it.pressed) knob_stretch else knob_size);

    drawToggle(p, rect, on_t, knob_w, .{
        .hovered = r.it.hovered,
        .disabled = opts.disabled,
    });
    if (r.it.focused) drawFocusRing(p, rect, toggle_h / 2);
    return .{ .changed = r.changed, .rect = rect };
}

const ToggleVisual = struct {
    hovered: bool = false,
    disabled: bool = false,
};

/// Painting only, so the showcase can force states through the identical path.
fn drawToggle(p: *const Painter, rect: draw.Rect, on_t: f32, knob_w: f32, v: ToggleVisual) void {
    const alpha: f32 = if (v.disabled) 0.5 else 1;
    // color-mix(in srgb, --skrive-fg 14%, --skrive-rule); the hover variants
    // are the CSS's 8% fg wash and, on the filled track, a 10% darken.
    const track_off = mix(pal.rule, pal.fg, 0.14);
    const track_on = pal.accent;
    const off_c = if (v.hovered) mix(track_off, pal.fg, 0.08) else track_off;
    const on_c = if (v.hovered) mix(track_on, Color.hex(0x000000), 0.10) else track_on;

    draw.rect(p.b, rect, .{
        .fill = mix(off_c, on_c, on_t).withAlpha(alpha),
        .radius = rect.h / 2,
        // The CSS's `inset 0 0 0 1px fg 6%` rim; the second inset layer (a
        // 1.5px top shadow) has no equivalent in an SDF that draws no inset
        // blur, and is dropped rather than approximated badly.
        .border = .{ .width = 1, .color = pal.fg.withAlpha(0.06 * alpha) },
    });

    // Leading-edge pin: off grows rightward from the pad, on grows leftward
    // from the inner edge, so the extra width is subtracted in proportion to
    // how far along the travel the knob is.
    const knob_x = rect.x + toggle_pad + on_t * knob_travel - (knob_w - knob_size) * on_t;
    draw.rect(p.b, .{ .x = knob_x, .y = rect.y + toggle_pad, .w = knob_w, .h = knob_size }, .{
        .fill = Color.hex(0xffffff).withAlpha(alpha),
        .radius = knob_size / 2,
        .border = .{ .width = 0.5, .color = Color.hex(0x000000).withAlpha(0.04 * alpha) },
        .shadows = &.{
            .{ .offset = .{ 0, 1 }, .sigma = 0.5, .color = Color.hex(0x000000).withAlpha(0.10 * alpha) },
            .{ .offset = .{ 0, 2 }, .sigma = 2.5, .color = Color.hex(0x000000).withAlpha(0.12 * alpha) },
        },
    });
}

//------------------------------------------------------------------------------
//  Segmented (Stage 4).
//
//  Geometry from the shipped Segmented.module.css: a 30px track (2px padding,
//  2px gap, md radius) over 26px options (13px horizontal padding, sm radius,
//  12px label), and a single raised thumb that slides between options rather
//  than one background per option.
//
//  This is the widget that pushed on the Stage 3 primitive. It is a
//  radiogroup: one Tab stop, arrows to move the selection, but every option
//  still hovers and clicks on its own. See context.Interact.focusable for the
//  addition that made that expressible and why it went into the primitive
//  rather than into this file.
//
//  The thumb animates on a single value — the selected index as a float — and
//  the drawn rect is interpolated between the two option rects it sits
//  between. Doing it that way rather than animating x and w separately is what
//  keeps it correct when the options have different label widths.
//------------------------------------------------------------------------------
pub const max_options = 8;
pub const segmented_h: f32 = 30;
const segmented_pad: f32 = 2;
const segmented_gap: f32 = 2;
const segmented_option_h: f32 = segmented_h - 2 * segmented_pad; // 26
const segmented_option_pad_x: f32 = 13;
const segmented_font_size: f32 = 12;
const segmented_track_radius: f32 = 8; // --skrive-radius-md
const segmented_option_radius: f32 = 6; // --skrive-radius-sm

pub const SegmentedOpts = struct {
    disabled: bool = false,
    disc: u64 = 0,
};

pub const SegmentedResult = struct {
    changed: bool,
    rect: draw.Rect,
};

pub const SegmentedLayout = struct {
    track: draw.Rect,
    options: [max_options]draw.Rect = undefined,
    len: usize = 0,

    pub fn slice(self: *const SegmentedLayout) []const draw.Rect {
        return self.options[0..self.len];
    }
};

/// Lay the strip out from measured label widths. The track sizes itself to its
/// content, which is the layout module's Fit.content doing exactly the job it
/// exists for — no hand-summed widths anywhere.
pub fn segmentedLayout(x: f32, y: f32, label_widths: []const f32) SegmentedLayout {
    var box = layout.Box.row(.{ .x = x, .y = y, .w = 0, .h = segmented_h }, .{
        .padding = .all(segmented_pad),
        .gap = segmented_gap,
        .cross = .center,
        .main = .content,
    });
    for (label_widths) |w| {
        _ = box.add(.{
            .main = .{ .content = @ceil(w) + 2 * segmented_option_pad_x },
            .cross = segmented_option_h,
        });
    }
    const rects = box.resolve();
    var out: SegmentedLayout = .{ .track = box.resolvedBounds(), .len = rects.len };
    @memcpy(out.options[0..rects.len], rects);
    return out;
}

/// The decision half: per-option hit testing plus radiogroup keyboard. Pure
/// over the context, so the tab-stop count and the arrow-key wrap are testable
/// without a GPU.
pub fn segmentedInteract(
    ctx: *Context,
    id_label: []const u8,
    l: *const SegmentedLayout,
    selected: *usize,
    opts: SegmentedOpts,
) struct { group: context.Interaction, wid: u64 } {
    const group_id = Context.id(id_label, opts.disc);
    // The group owns the Tab stop and the keyboard; it is registered first so
    // it is the focus target a click on any option leaves behind.
    const group = ctx.interact(group_id, l.track, .{ .disabled = opts.disabled });

    for (l.slice(), 0..) |r, i| {
        const opt = ctx.interact(
            Context.id(id_label, opts.disc ^ (i + 1)),
            r,
            .{ .disabled = opts.disabled, .focusable = false },
        );
        if (opt.fired) selected.* = i;
    }

    // Arrows wrap, per the ARIA radiogroup pattern. Space/Enter on the group
    // does nothing: in a radiogroup the focused option *is* the selection, so
    // there is nothing left to activate (group.fired is deliberately unread).
    const n = l.len;
    if (group.has_focus and n > 0) {
        if (ctx.input.nav_next) selected.* = (selected.* + 1) % n;
        if (ctx.input.nav_prev) selected.* = (selected.* + n - 1) % n;
    }
    if (selected.* >= n and n > 0) selected.* = n - 1;
    return .{ .group = group, .wid = group_id };
}

pub fn segmented(
    ctx: *Context,
    p: *const Painter,
    x: f32,
    y: f32,
    id_label: []const u8,
    options: []const []const u8,
    selected: *usize,
    opts: SegmentedOpts,
) SegmentedResult {
    std.debug.assert(options.len <= max_options);
    var widths: [max_options]f32 = undefined;
    for (options, 0..) |label, i| {
        // Measured on the weight the option will actually be drawn in, so the
        // strip does not jiggle when the selection moves.
        widths[i] = draw.measureText(p.font_medium, segmented_font_size, p.dpi, label, 0).width;
    }
    const l = segmentedLayout(x, y, widths[0..options.len]);

    const before = selected.*;
    const r = segmentedInteract(ctx, id_label, &l, selected, opts);
    const changed = selected.* != before;

    const pos = ctx.anim.value(anim.Store.key(r.wid, 0), @floatFromInt(selected.*));
    drawSegmented(p, &l, options, pos, opts.disabled);
    if (r.group.focused) drawFocusRing(p, l.track, segmented_track_radius);
    return .{ .changed = changed, .rect = l.track };
}

/// Painting only. `pos` is the animated selected index; the thumb rect is
/// interpolated between the option rects on either side of it, so uneven
/// option widths interpolate correctly.
fn drawSegmented(
    p: *const Painter,
    l: *const SegmentedLayout,
    options: []const []const u8,
    pos: f32,
    disabled: bool,
) void {
    const alpha: f32 = if (disabled) 0.5 else 1;
    draw.rect(p.b, l.track, .{
        .fill = mix(pal.rule, pal.fg, 0.08).withAlpha(alpha),
        .radius = segmented_track_radius,
    });

    if (l.len > 0) {
        const lo: usize = @intFromFloat(@floor(std.math.clamp(pos, 0, @as(f32, @floatFromInt(l.len - 1)))));
        const hi: usize = @min(lo + 1, l.len - 1);
        const t = std.math.clamp(pos - @as(f32, @floatFromInt(lo)), 0, 1);
        const a = l.options[lo];
        const b = l.options[hi];
        draw.rect(p.b, .{
            .x = a.x + (b.x - a.x) * t,
            .y = a.y,
            .w = a.w + (b.w - a.w) * t,
            .h = a.h,
        }, .{
            .fill = pal.bg.withAlpha(alpha),
            .radius = segmented_option_radius,
            .shadows = &.{.{ .offset = .{ 0, 1 }, .sigma = 1, .color = pal.fg.withAlpha(0.09 * alpha) }},
        });
    }

    // Nearest option to the animated thumb reads as active, so the label
    // darkens as the thumb arrives rather than a frame early or late.
    const active: usize = @intFromFloat(@round(std.math.clamp(pos, 0, @as(f32, @floatFromInt(@max(l.len, 1) - 1)))));
    for (options, 0..) |label, i| {
        const r = l.options[i];
        const m = draw.measureText(p.font_medium, segmented_font_size, p.dpi, label, 0);
        _ = draw.text(p.b, p.atlas, p.dpi, .{
            r.x + (r.w - m.width) / 2,
            r.y + (r.h - m.lineHeight()) / 2,
        }, label, .{
            .font = p.font_medium,
            .size = segmented_font_size,
            // The shipped kit steps 500 -> 600 on the active option; the lab
            // carries Regular and Medium only (the Stage 2 weight-inventory
            // gap), so the state reads through colour alone.
            .color = (if (i == active) pal.fg else pal.muted).withAlpha(alpha),
        });
    }
}

//------------------------------------------------------------------------------
//  Intrinsic sizes. A layout box needs a child's natural width before the
//  child draws itself (layout.zig's one real cost), so each widget exposes the
//  measurement its drawing half would have made.
//------------------------------------------------------------------------------
pub fn buttonWidth(p: *const Painter, label: []const u8, opts: ButtonOpts) f32 {
    const label_font = if (opts.variant == .primary) p.font_medium else p.font;
    const m = draw.measureText(label_font, font_size, p.dpi, label, 0);
    return @max(opts.min_width, @ceil(m.width) + 2 * pad_x);
}

pub const button_h: f32 = height;

pub fn segmentedWidth(p: *const Painter, options: []const []const u8) f32 {
    var w: f32 = 2 * segmented_pad;
    for (options, 0..) |label, i| {
        if (i > 0) w += segmented_gap;
        w += @ceil(draw.measureText(p.font_medium, segmented_font_size, p.dpi, label, 0).width) + 2 * segmented_option_pad_x;
    }
    return w;
}

//------------------------------------------------------------------------------
//  Showcase renderers: forced visual states for the screenshot deliverable, no
//  live input involved. Each goes through the identical paint path as the
//  interactive widget, so what the screenshot shows is what the widget does.
//------------------------------------------------------------------------------
pub fn toggleShowcase(p: *const Painter, x: f32, y: f32, on: bool, s: ShowcaseState) draw.Rect {
    const rect: draw.Rect = .{ .x = x, .y = y, .w = toggle_w, .h = toggle_h };
    drawToggle(p, rect, if (on) 1 else 0, if (s == .pressed) knob_stretch else knob_size, .{
        .hovered = s == .hovered,
        .disabled = s == .disabled,
    });
    if (s == .focused) drawFocusRing(p, rect, toggle_h / 2);
    return rect;
}

/// The toggle rendered at an arbitrary point along its transition, through the
/// identical paint path the animation drives. The transition is 150ms, which a
/// shell-driven screencapture cannot reliably land inside, so this is how the
/// in-between states get shown: a deterministic ladder rather than a lucky
/// frame. (That the animation *runs* is measured instead — see the bench's
/// settle-window present count.)
pub fn toggleShowcaseAt(p: *const Painter, x: f32, y: f32, on_t: f32) draw.Rect {
    const rect: draw.Rect = .{ .x = x, .y = y, .w = toggle_w, .h = toggle_h };
    drawToggle(p, rect, on_t, knob_size, .{});
    return rect;
}

pub fn segmentedShowcase(
    p: *const Painter,
    x: f32,
    y: f32,
    options: []const []const u8,
    selected: usize,
    s: ShowcaseState,
) draw.Rect {
    var widths: [max_options]f32 = undefined;
    for (options, 0..) |label, i| {
        widths[i] = draw.measureText(p.font_medium, segmented_font_size, p.dpi, label, 0).width;
    }
    const l = segmentedLayout(x, y, widths[0..options.len]);
    drawSegmented(p, &l, options, @floatFromInt(selected), s == .disabled);
    if (s == .focused) drawFocusRing(p, l.track, segmented_track_radius);
    return l.track;
}

//------------------------------------------------------------------------------
//  Tests — the Stage 4 widgets' decision halves, run headless. Stage 3's tests
//  cover the shared state machine in context.zig; these cover what each widget
//  adds on top of it: flipping a bool, one Tab stop for a group of options,
//  and the arrow-key wrap. Visuals are verified by the showcase screenshot,
//  and the tactile pass is Joe's.
//------------------------------------------------------------------------------
const testing = std.testing;

const t_toggle: draw.Rect = .{ .x = 0, .y = 0, .w = toggle_w, .h = toggle_h };
const t_inside: [2]f32 = .{ 20, 11 };
const t_outside: [2]f32 = .{ 300, 11 };

test "toggle: a click flips it, and only on release" {
    var ctx: Context = .{};
    var on = false;

    ctx.begin(.{ .mouse = t_inside, .mouse_down = true, .pressed = true }, 0);
    var r = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    try testing.expect(!r.changed and !on);
    try testing.expect(r.it.pressed); // the press-stretch cue is armed

    ctx.begin(.{ .mouse = t_inside, .released = true }, 0);
    r = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    try testing.expect(r.changed and on);
}

test "toggle: release outside cancels, leaving the value alone" {
    var ctx: Context = .{};
    var on = false;
    ctx.begin(.{ .mouse = t_inside, .mouse_down = true, .pressed = true }, 0);
    _ = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    ctx.begin(.{ .mouse = t_outside, .released = true }, 0);
    const r = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    try testing.expect(!r.changed and !on);
}

test "toggle: Space flips the focused toggle; disabled is inert" {
    var ctx: Context = .{};
    var on = false;
    ctx.begin(.{ .tab = true }, 0);
    _ = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    ctx.begin(.{ .tab = true }, 0); // now focusable list is populated
    _ = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    ctx.begin(.{ .activate = true }, 0);
    const r = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    try testing.expect(r.changed and on);

    var off = false;
    ctx.begin(.{ .mouse = t_inside, .pressed = true, .released = true }, 0);
    const d = toggleInteract(&ctx, "other", t_toggle, &off, .{ .disabled = true });
    _ = ctx.end();
    try testing.expect(!d.changed and !off);
}

test "toggle: identity is the id_label, so the value flipping cannot drop state" {
    // The Stage 3 lesson (a dynamic label reshuffles the ID and silently drops
    // hot/active/focus) applied to the first genuinely stateful widget: press,
    // flip the value mid-gesture, and the widget must still be the same one.
    var ctx: Context = .{};
    var on = false;
    ctx.begin(.{ .mouse = t_inside, .mouse_down = true, .pressed = true }, 0);
    _ = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    const armed = ctx.active_id;
    on = true; // as if something else changed the bound value
    ctx.begin(.{ .mouse = t_inside, .mouse_down = true }, 0);
    _ = toggleInteract(&ctx, "wrap", t_toggle, &on, .{});
    _ = ctx.end();
    try testing.expectEqual(armed, ctx.active_id);
}

fn threeOptions() SegmentedLayout {
    // Stand-in label widths; the real ones come from measureText.
    return segmentedLayout(0, 0, &.{ 30, 40, 50 });
}

test "segmented: the strip lays itself out from its labels" {
    const l = threeOptions();
    try testing.expectEqual(@as(usize, 3), l.len);
    // 2 pad + (30+26) + 2 gap + (40+26) + 2 gap + (50+26) + 2 pad = 206
    try testing.expectApproxEqAbs(@as(f32, 206), l.track.w, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 30), l.track.h, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 2), l.options[0].x, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 60), l.options[1].x, 0.001); // 2 + 56 + 2
    try testing.expectApproxEqAbs(@as(f32, 26), l.options[0].h, 0.001);
}

test "segmented: clicking an option selects it" {
    var ctx: Context = .{};
    const l = threeOptions();
    var sel: usize = 0;
    const mid = l.options[1];
    const p: [2]f32 = .{ mid.x + mid.w / 2, mid.y + mid.h / 2 };

    ctx.begin(.{ .mouse = p, .mouse_down = true, .pressed = true }, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    ctx.begin(.{ .mouse = p, .released = true }, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 1), sel);
}

test "segmented: three options are one Tab stop, and focus stays on the group" {
    var ctx: Context = .{};
    const l = threeOptions();
    var sel: usize = 0;
    ctx.begin(.{}, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 1), ctx.focusables_len);
    try testing.expectEqual(Context.id("theme", 0), ctx.focusables[0]);

    // A click on an option must leave focus on the group, or the arrows below
    // would stop working after a mouse selection.
    const last = l.options[2];
    ctx.begin(.{ .mouse = .{ last.x + 2, last.y + 2 }, .mouse_down = true, .pressed = true }, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    try testing.expectEqual(Context.id("theme", 0), ctx.focus_id);
}

test "segmented: arrows move the selection and wrap, but only when focused" {
    var ctx: Context = .{};
    const l = threeOptions();
    var sel: usize = 0;

    // Not focused: arrows do nothing.
    ctx.begin(.{ .nav_next = true }, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 0), sel);

    ctx.begin(.{ .tab = true }, 0); // Tab onto the group (list is populated now)
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
    _ = ctx.end();
    try testing.expectEqual(Context.id("theme", 0), ctx.focus_id);

    const steps = [_]struct { next: bool, want: usize }{
        .{ .next = true, .want = 1 },
        .{ .next = true, .want = 2 },
        .{ .next = true, .want = 0 }, // wraps forward
        .{ .next = false, .want = 2 }, // wraps backward
        .{ .next = false, .want = 1 },
    };
    for (steps) |s| {
        ctx.begin(.{ .nav_next = s.next, .nav_prev = !s.next }, 0);
        _ = segmentedInteract(&ctx, "theme", &l, &sel, .{});
        _ = ctx.end();
        try testing.expectEqual(s.want, sel);
    }
}

test "segmented: disabled takes no Tab stop and ignores clicks" {
    var ctx: Context = .{};
    const l = threeOptions();
    var sel: usize = 0;
    const mid = l.options[1];
    ctx.begin(.{ .mouse = .{ mid.x + 2, mid.y + 2 }, .pressed = true, .released = true }, 0);
    _ = segmentedInteract(&ctx, "theme", &l, &sel, .{ .disabled = true });
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 0), sel);
    try testing.expectEqual(@as(usize, 0), ctx.focusables_len);
}
