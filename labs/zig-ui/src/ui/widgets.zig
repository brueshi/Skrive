//------------------------------------------------------------------------------
//  widgets.zig — the widgets (Stage 3: button).
//
//  A widget is a function you call every frame. button() sizes itself around
//  its label, routes interaction through the immediate-mode context, resolves
//  its visual state honestly (default / hover / pressed / focused / disabled),
//  and returns whether it fired. There is no widget object and no retained
//  tree.
//
//  Styling is by-eye from the shipped kit (app/src/components/ui), NOT a
//  transcription of tokens.css — exact tokens arrive in Stage 5. Values here
//  are plausible round numbers picked to sit next to the real Button: 13px
//  label, 9px radius, ~34px tall, the slate-indigo focus ring. Stage 4 adds
//  layout so buttons stop being hand-placed; for now the caller passes a
//  top-left and reads back the measured rect to advance a row.
//------------------------------------------------------------------------------
const std = @import("std");
const draw = @import("draw.zig");
const context = @import("context.zig");
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
const pal = struct {
    const fg = Color.hex(0x1a1a1d); // --skrive-fg
    const muted = Color.hex(0x73737a); // --skrive-muted
    const rule = Color.hex(0xd8d9dd); // --skrive-rule
    const accent = Color.hex(0x4c5ba6); // --skrive-accent / focus ring
    const on_primary = Color.hex(0xffffff);
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
    const it = ctx.interact(wid, rect, opts.disabled);
    const v = resolve(opts.variant, it, opts.disabled);

    draw.rect(p.b, rect, .{ .fill = v.fill, .radius = radius, .border = v.border });
    _ = draw.text(p.b, p.atlas, p.dpi, .{
        x + (w - m.width) / 2,
        y + (height - m.lineHeight()) / 2,
    }, label, .{ .font = label_font, .size = font_size, .color = v.text });

    if (it.focused) drawFocusRing(p, rect);
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
    if (it.focused) drawFocusRing(p, rect);
    return rect;
}

/// A 2px slate-indigo ring, offset a few px outside the button — the shipped
/// :focus-visible outline. Fill alpha 0 so only the ring paints; drawn last so
/// it sits above the fill.
fn drawFocusRing(p: *const Painter, r: draw.Rect) void {
    const gap: f32 = 3;
    draw.rect(p.b, .{ .x = r.x - gap, .y = r.y - gap, .w = r.w + 2 * gap, .h = r.h + 2 * gap }, .{
        .fill = pal.accent.withAlpha(0),
        .radius = radius + gap,
        .border = .{ .width = 2, .color = pal.accent.withAlpha(0.5) },
    });
}
