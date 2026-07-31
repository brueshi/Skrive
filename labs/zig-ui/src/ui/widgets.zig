//------------------------------------------------------------------------------
//  widgets.zig — the widgets (Stage 3: button. Stage 4: toggle, segmented).
//
//  A widget is a function you call every frame. It sizes itself, routes
//  interaction through the immediate-mode context, resolves its visual state
//  honestly (default / hover / pressed / focused / disabled), and returns what
//  happened. There is no widget object and no retained tree.
//
//  Styling reads ui/tokens.zig (Stage 5) — the mechanical transcription of the
//  shipped kit's tokens.css + index.css token blocks. Where the Stage 3/4
//  by-eye values disagreed with the tokens, the tokens won; the log records
//  what moved. One deliberate divergence is kept: a distinct pressed state
//  (the shipped Button has no :active rule, so a shipped press shows only the
//  hover look — the lab's deeper press wash is more tactile and was reviewed
//  favourably in Stage 3).
//
//  Hover is animated (Stage 4's carried debt): the shipped CSS transitions
//  hover colour over --skrive-duration-quick; each widget runs a hover_t
//  value through the same per-ID animation store as its state transitions,
//  and the visual resolution interpolates rather than steps.
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
const tokens = @import("tokens.zig");
const batch = @import("../gfx/batch.zig");
const atlas_mod = @import("../gfx/atlas.zig");
const text_mod = @import("../gfx/text.zig");

const Context = context.Context;
const Color = draw.Color;

/// Bundles the drawing dependencies so widget signatures stay short. Three
/// weights of the UI face: Regular (400) for labels — including the button,
/// whose shipped CSS sets no font-weight anywhere, even on primary — Medium
/// (500) for the settings-row label and inactive segmented options, SemiBold
/// (600) for the active segmented option and section caps.
pub const Painter = struct {
    b: *batch.Batch,
    atlas: *atlas_mod.Atlas,
    dpi: f32,
    font: *const text_mod.Font, // Inter Regular
    font_medium: *const text_mod.Font, // Inter Medium
    font_semibold: *const text_mod.Font, // Inter SemiBold
};

// Button geometry, from tokens. The Stage 3 by-eye values were 13px label /
// 9px radius / 34px tall / 16px pads; the tokens say 11.375px (0.8125rem
// against the app's 14px root — see tokens.zig on the rem trap) / 8px /
// 33.06px / 15.4px. Tokens win.
const font_size: f32 = tokens.button_font_size;
const height: f32 = tokens.button_height;
const radius: f32 = tokens.button_radius;
const pad_x: f32 = tokens.button_pad_x;

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

/// Map the states onto fill / border / text. `hover_t` is the animated hover
/// blend (0..1) so the 110ms colour transition the shipped CSS declares reads
/// as a fade, not a step. States per the shipped module CSS: secondary hover
/// lifts border rule->muted and text muted->fg (no fill); primary hover is
/// `opacity: 0.85` (the whole element fades toward the surface). The bare
/// default's subtle hover wash and every pressed state are the kept lab
/// divergences (the shipped CSS has no rule for either).
fn resolve(variant: Variant, hover_t: f32, pressed: bool, disabled: bool) Visual {
    var v: Visual = switch (variant) {
        .default => .{
            .fill = tokens.fg.withAlpha(0.05 * hover_t),
            .border = .{ .width = 1, .color = tokens.button_border },
            .text = tokens.button_fg,
        },
        .secondary => .{
            .fill = tokens.fg.withAlpha(0),
            .border = .{ .width = 1, .color = mix(tokens.button_border, tokens.muted, hover_t) },
            .text = mix(tokens.muted, tokens.fg, hover_t),
        },
        .primary => .{
            .fill = tokens.button_primary_bg.withAlpha(1 - (1 - tokens.button_primary_hover_opacity) * hover_t),
            .border = null,
            .text = tokens.button_primary_fg.withAlpha(1 - (1 - tokens.button_primary_hover_opacity) * hover_t),
        },
    };

    if (pressed) {
        switch (variant) {
            .default => v.fill = tokens.fg.withAlpha(0.10),
            .secondary => {
                v.fill = tokens.fg.withAlpha(0.09);
                v.border = .{ .width = 1, .color = tokens.muted };
                v.text = tokens.fg;
            },
            .primary => v.fill = mix(tokens.button_primary_bg, Color.hex(0x000000), 0.18),
        }
    }

    if (disabled) {
        // CSS `:disabled { opacity: 0.5 }` — scale every layer's alpha.
        const o = tokens.button_disabled_opacity;
        v.fill = v.fill.withAlpha(v.fill.a * o);
        v.text = v.text.withAlpha(v.text.a * o);
        if (v.border) |*bd| bd.color = bd.color.withAlpha(bd.color.a * o);
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
    // Weight 400 for every variant: the shipped .button sets `font: inherit`
    // and no rule anywhere adds a font-weight — primary included (verified
    // against computed styles; Stage 3's Medium primary was a by-eye guess).
    const m = draw.measureText(p.font, font_size, p.dpi, label, 0);
    const w = @max(opts.min_width, @ceil(m.width) + 2 * pad_x);
    const rect: draw.Rect = .{ .x = x, .y = y, .w = w, .h = height };

    const wid = Context.id(opts.id_label orelse label, opts.disc);
    const it = ctx.interact(wid, rect, .{ .disabled = opts.disabled });
    const hover_t = ctx.anim.value(anim.Store.key(wid, 2), if (it.hovered and !it.pressed) 1 else 0);
    const v = resolve(opts.variant, hover_t, it.pressed, opts.disabled);

    draw.rect(p.b, rect, .{ .fill = v.fill, .radius = radius, .border = v.border });
    _ = draw.text(p.b, p.atlas, p.dpi, .{
        x + (w - m.width) / 2,
        y + (height - m.lineHeight()) / 2,
    }, label, .{ .font = p.font, .size = font_size, .color = v.text });

    if (it.focused) drawFocusRing(p, rect, radius);
    return .{ .fired = it.fired, .rect = rect };
}

/// Screenshot-only: render one button in a forced visual state, no context or
/// live input involved. Goes through the same resolve()+draw path as button(),
/// so it shows each state exactly as the interactive widget would.
pub const ShowcaseState = enum { normal, hovered, pressed, focused, disabled };

pub fn buttonShowcase(p: *const Painter, x: f32, y: f32, label: []const u8, variant: Variant, s: ShowcaseState) draw.Rect {
    const m = draw.measureText(p.font, font_size, p.dpi, label, 0);
    const w = @ceil(m.width) + 2 * pad_x;
    const rect: draw.Rect = .{ .x = x, .y = y, .w = w, .h = height };

    const v = resolve(variant, if (s == .hovered) 1 else 0, s == .pressed, s == .disabled);
    draw.rect(p.b, rect, .{ .fill = v.fill, .radius = radius, .border = v.border });
    _ = draw.text(p.b, p.atlas, p.dpi, .{
        x + (w - m.width) / 2,
        y + (height - m.lineHeight()) / 2,
    }, label, .{ .font = p.font, .size = font_size, .color = v.text });
    if (s == .focused) drawFocusRing(p, rect, radius);
    return rect;
}

/// The shipped global :focus-visible outline: 2px solid, --skrive-focus-ring
/// at 50%, offset 2px outside the control (was 3px by eye; tokens win). The
/// drawn rect is expanded by offset + width so the ring's inner edge sits
/// exactly `offset` off the control; fill alpha 0 so only the ring paints.
fn drawFocusRing(p: *const Painter, r: draw.Rect, ring_radius: f32) void {
    const gap = tokens.focus_outline_offset + tokens.focus_outline_width;
    draw.rect(p.b, .{ .x = r.x - gap, .y = r.y - gap, .w = r.w + 2 * gap, .h = r.h + 2 * gap }, .{
        .fill = tokens.focus_outline_color.withAlpha(0),
        .radius = ring_radius + gap,
        .border = .{ .width = tokens.focus_outline_width, .color = tokens.focus_outline_color },
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
pub const toggle_w: f32 = tokens.toggle_w;
pub const toggle_h: f32 = tokens.toggle_h;
const toggle_pad: f32 = tokens.toggle_pad;
const knob_size: f32 = tokens.toggle_knob;
const knob_stretch: f32 = tokens.toggle_knob_stretch;
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

    // Three animated values per toggle: `on_t` drives both the knob's travel
    // and the track's colour (they are the same transition), `knob_w` the
    // press stretch, `hover_t` the 110ms hover wash the shipped CSS
    // transitions. All retargetable, so a double-flick reverses mid-slide.
    const on_t = ctx.anim.value(anim.Store.key(r.wid, 0), if (value.*) 1 else 0);
    const knob_w = ctx.anim.value(anim.Store.key(r.wid, 1), if (r.it.pressed) knob_stretch else knob_size);
    const hover_t = ctx.anim.value(anim.Store.key(r.wid, 2), if (r.it.hovered) 1 else 0);

    drawToggle(p, rect, on_t, knob_w, .{
        .hover_t = hover_t,
        .disabled = opts.disabled,
    });
    if (r.it.focused) drawFocusRing(p, rect, toggle_h / 2);
    return .{ .changed = r.changed, .rect = rect };
}

const ToggleVisual = struct {
    hover_t: f32 = 0,
    disabled: bool = false,
};

/// Painting only, so the showcase can force states through the identical path.
fn drawToggle(p: *const Painter, rect: draw.Rect, on_t: f32, knob_w: f32, v: ToggleVisual) void {
    const alpha: f32 = if (v.disabled) 0.5 else 1;
    // Track colours from tokens: --toggle-track-off (the computed fg-14%/rule
    // mix) and --toggle-track-on (accent). Hover per the module CSS — off
    // mixes 8% toward fg, on darkens 10% — blended by the animated hover_t.
    const off_c = mix(tokens.toggle_track_off, tokens.fg, tokens.toggle_hover_mix * v.hover_t);
    const on_c = mix(tokens.toggle_track_on, Color.hex(0x000000), tokens.toggle_on_hover_darken * v.hover_t);

    // The CSS's `inset 0 0 0 1px` rim (fg 6% off, #000 7% on — near-equal
    // colours, mixed for fidelity); the second inset layer (a 1.5px-blur top
    // shadow, and a white top highlight when on) has no equivalent in an SDF
    // that draws no inset blur, and is dropped rather than approximated
    // badly — the recorded renderer gap.
    const rim = mix(tokens.toggle_rim, tokens.toggle_on_rim, on_t);
    draw.rect(p.b, rect, .{
        .fill = mix(off_c, on_c, on_t).withAlpha(alpha),
        .radius = rect.h / 2,
        .border = .{ .width = 1, .color = rim.withAlpha(rim.a * alpha) },
    });

    // Leading-edge pin: off grows rightward from the pad, on grows leftward
    // from the inner edge, so the extra width is subtracted in proportion to
    // how far along the travel the knob is.
    const knob_x = rect.x + toggle_pad + on_t * knob_travel - (knob_w - knob_size) * on_t;
    draw.rect(p.b, .{ .x = knob_x, .y = rect.y + toggle_pad, .w = knob_w, .h = knob_size }, .{
        .fill = Color.hex(0xffffff).withAlpha(alpha),
        .radius = knob_size / 2,
        .border = .{ .width = 0.5, .color = tokens.knob_ring.withAlpha(tokens.knob_ring.a * alpha) },
        .shadows = &.{
            .{ .offset = tokens.knob_shadow[0].offset, .sigma = tokens.knob_shadow[0].sigma, .color = tokens.knob_shadow[0].color.withAlpha(tokens.knob_shadow[0].color.a * alpha) },
            .{ .offset = tokens.knob_shadow[1].offset, .sigma = tokens.knob_shadow[1].sigma, .color = tokens.knob_shadow[1].color.withAlpha(tokens.knob_shadow[1].color.a * alpha) },
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
pub const segmented_h: f32 = tokens.segmented_h;
const segmented_pad: f32 = tokens.segmented_pad;
const segmented_gap: f32 = tokens.segmented_gap;
const segmented_option_h: f32 = segmented_h - 2 * segmented_pad; // 26
const segmented_option_pad_x: f32 = tokens.segmented_option_pad_x;
const segmented_font_size: f32 = tokens.segmented_font_size;
const segmented_track_radius: f32 = tokens.segmented_track_radius;
const segmented_option_radius: f32 = tokens.segmented_option_radius;

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
        // Measured on the weight the option currently renders in: the shipped
        // kit steps 500 -> 600 on the active option with no reserved bold
        // width, so the real strip resizes by a fraction of a px on selection
        // — transcribed faithfully rather than smoothed away.
        const f = if (i == selected.*) p.font_semibold else p.font_medium;
        widths[i] = draw.measureText(f, segmented_font_size, p.dpi, label, 0).width;
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
        .fill = tokens.segmented_track.withAlpha(alpha),
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
            .fill = tokens.bg.withAlpha(alpha),
            .radius = segmented_option_radius,
            .shadows = &.{.{
                .offset = tokens.segmented_thumb_shadow[0].offset,
                .sigma = tokens.segmented_thumb_shadow[0].sigma,
                .color = tokens.segmented_thumb_shadow[0].color.withAlpha(tokens.segmented_thumb_shadow[0].color.a * alpha),
            }},
        });
    }

    // Nearest option to the animated thumb reads as active, so the label
    // darkens as the thumb arrives rather than a frame early or late.
    const active: usize = @intFromFloat(@round(std.math.clamp(pos, 0, @as(f32, @floatFromInt(@max(l.len, 1) - 1)))));
    for (options, 0..) |label, i| {
        const r = l.options[i];
        // The shipped active option steps to weight 600 — SemiBold, vendored
        // for exactly this (the Stage 2/4 weight-inventory gap, closed).
        const f = if (i == active) p.font_semibold else p.font_medium;
        const m = draw.measureText(f, segmented_font_size, p.dpi, label, 0);
        _ = draw.text(p.b, p.atlas, p.dpi, .{
            r.x + (r.w - m.width) / 2,
            r.y + (r.h - m.lineHeight()) / 2,
        }, label, .{
            .font = f,
            .size = segmented_font_size,
            .color = (if (i == active) tokens.fg else tokens.muted).withAlpha(alpha),
        });
    }
}

//------------------------------------------------------------------------------
//  IconButton (Stage 5). The shipped IconButton.module.css: a transparent
//  glyph square (26px default; 22 sm, 28 lg), sm radius, muted glyph that
//  lifts to fg on hover over a 7% fg wash, both transitioned over the quick
//  duration — so hover_t animates here exactly as on the button. Disabled is
//  opacity 0.4 (not the button's 0.5). Icons come from ui/icons.zig at the
//  shipped 16px glyph size, centred in the square.
//------------------------------------------------------------------------------
pub const IconButtonSize = enum {
    sm,
    md,
    lg,

    fn px(self: IconButtonSize) f32 {
        return switch (self) {
            .sm => tokens.icon_button_size_sm,
            .md => tokens.icon_button_size,
            .lg => tokens.icon_button_size_lg,
        };
    }
};

pub const IconButtonOpts = struct {
    size: IconButtonSize = .md,
    disabled: bool = false,
    disc: u64 = 0,
};

pub fn iconButton(
    ctx: *Context,
    p: *const Painter,
    x: f32,
    y: f32,
    icon: icons.Icon,
    id_label: []const u8,
    opts: IconButtonOpts,
) ButtonResult {
    const side = opts.size.px();
    const rect: draw.Rect = .{ .x = x, .y = y, .w = side, .h = side };
    const wid = Context.id(id_label, opts.disc);
    const it = ctx.interact(wid, rect, .{ .disabled = opts.disabled });
    const hover_t = ctx.anim.value(anim.Store.key(wid, 2), if (it.hovered) 1 else 0);
    drawIconButton(p, rect, icon, hover_t, opts.disabled);
    if (it.focused) drawFocusRing(p, rect, tokens.icon_button_radius);
    return .{ .fired = it.fired, .rect = rect };
}

fn drawIconButton(p: *const Painter, rect: draw.Rect, icon: icons.Icon, hover_t: f32, disabled: bool) void {
    const alpha: f32 = if (disabled) tokens.icon_button_disabled_opacity else 1;
    if (hover_t > 0 and !disabled) {
        draw.rect(p.b, rect, .{
            .fill = tokens.icon_button_bg_hover.withAlpha(tokens.icon_button_bg_hover.a * hover_t),
            .radius = tokens.icon_button_radius,
        });
    }
    const glyph = if (disabled)
        tokens.icon_button_fg.withAlpha(alpha)
    else
        mix(tokens.icon_button_fg, tokens.icon_button_fg_hover, hover_t);
    const icon_px: f32 = 16; // the shipped 16-grid icons at their native size
    icons.drawIcon(p.b, icon, rect.x + (rect.w - icon_px) / 2, rect.y + (rect.h - icon_px) / 2, icon_px, glyph);
}

/// Screenshot-only forced states, identical paint path.
pub fn iconButtonShowcase(p: *const Painter, x: f32, y: f32, icon: icons.Icon, s: ShowcaseState) draw.Rect {
    const side = tokens.icon_button_size;
    const rect: draw.Rect = .{ .x = x, .y = y, .w = side, .h = side };
    drawIconButton(p, rect, icon, if (s == .hovered or s == .pressed) 1 else 0, s == .disabled);
    if (s == .focused) drawFocusRing(p, rect, tokens.icon_button_radius);
    return rect;
}

pub const icons = @import("icons.zig");

//------------------------------------------------------------------------------
//  Intrinsic sizes. A layout box needs a child's natural width before the
//  child draws itself (layout.zig's one real cost), so each widget exposes the
//  measurement its drawing half would have made.
//------------------------------------------------------------------------------
pub fn buttonWidth(p: *const Painter, label: []const u8, opts: ButtonOpts) f32 {
    const m = draw.measureText(p.font, font_size, p.dpi, label, 0);
    return @max(opts.min_width, @ceil(m.width) + 2 * pad_x);
}

pub const button_h: f32 = height;

pub fn segmentedWidth(p: *const Painter, options: []const []const u8, selected: usize) f32 {
    var w: f32 = 2 * segmented_pad;
    for (options, 0..) |label, i| {
        if (i > 0) w += segmented_gap;
        const f = if (i == selected) p.font_semibold else p.font_medium;
        w += @ceil(draw.measureText(f, segmented_font_size, p.dpi, label, 0).width) + 2 * segmented_option_pad_x;
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
        .hover_t = if (s == .hovered) 1 else 0,
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
        const f = if (i == selected) p.font_semibold else p.font_medium;
        widths[i] = draw.measureText(f, segmented_font_size, p.dpi, label, 0).width;
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
