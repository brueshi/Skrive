//------------------------------------------------------------------------------
//  draw.zig — the high-level draw API: rect(r, style) and text(pos, str,
//  style), plus measureText for the widgets Stage 3 will need.
//
//  Rects: shadows first (painter's order, back to front), then the
//  fill+border shape. Shadow layering follows CSS box-shadow: a style
//  carries a list of shadows because Skrive's own elevation tokens are
//  multi-layer (--skrive-shadow-sheet is two). Like CSS, the shadow is also
//  drawn underneath the shape, so a translucent fill over its own shadow
//  darkens; Skrive surfaces are opaque, so this stays faithful where it
//  matters.
//
//  Text: positions are the top-left of the line box (CSS mental model);
//  the baseline sits ascent below it. The pen advances in float device px
//  (kerning included) but every glyph's origin is snapped to an integer
//  device pixel before the quad is pushed — unsnapped origins sample the
//  atlas off-texel and the text shimmers when the window moves. Sizes are
//  CSS-equivalent em sizes in logical px; dpi converts to device px, so
//  callers pass sapp.dpiScale() through.
//------------------------------------------------------------------------------
const std = @import("std");
const batch = @import("../gfx/batch.zig");
const atlas_mod = @import("../gfx/atlas.zig");
const text_mod = @import("../gfx/text.zig");

pub const Color = struct {
    r: f32,
    g: f32,
    b: f32,
    a: f32 = 1,

    /// 0xRRGGBB, alpha 1 — the shape CSS hex tokens transcribe to.
    pub fn hex(v: u24) Color {
        return .{
            .r = @as(f32, @floatFromInt((v >> 16) & 0xff)) / 255.0,
            .g = @as(f32, @floatFromInt((v >> 8) & 0xff)) / 255.0,
            .b = @as(f32, @floatFromInt(v & 0xff)) / 255.0,
        };
    }

    pub fn withAlpha(self: Color, a: f32) Color {
        return .{ .r = self.r, .g = self.g, .b = self.b, .a = a };
    }

    pub fn toU8(self: Color) [4]u8 {
        return .{
            @intFromFloat(std.math.clamp(self.r, 0, 1) * 255.0),
            @intFromFloat(std.math.clamp(self.g, 0, 1) * 255.0),
            @intFromFloat(std.math.clamp(self.b, 0, 1) * 255.0),
            @intFromFloat(std.math.clamp(self.a, 0, 1) * 255.0),
        };
    }
};

pub const Rect = struct {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
};

pub const Border = struct {
    width: f32 = 1,
    color: Color,
};

/// CSS box-shadow terms: sigma is the Gaussian standard deviation, which is
/// half the CSS blur-radius. No spread; grow the rect instead if ever needed.
pub const Shadow = struct {
    offset: [2]f32 = .{ 0, 0 },
    sigma: f32,
    color: Color,
};

pub const Style = struct {
    fill: Color,
    radius: f32 = 0,
    border: ?Border = null,
    shadows: []const Shadow = &.{},
};

pub fn rect(b: *batch.Batch, r: Rect, style: Style) void {
    const radius = std.math.clamp(style.radius, 0, @min(r.w, r.h) / 2);

    for (style.shadows) |sh| {
        // The blurred field is negligible beyond 3 sigma; the quad covers
        // the shadow-casting rect (offset applied) expanded by that much.
        const sigma = @max(sh.sigma, 0.1);
        const pad = 3.0 * sigma;
        const sx = r.x + sh.offset[0];
        const sy = r.y + sh.offset[1];
        b.pushQuad(.{
            .x = sx - pad,
            .y = sy - pad,
            .w = r.w + 2 * pad,
            .h = r.h + 2 * pad,
            .rect_center = .{ sx + r.w / 2, sy + r.h / 2 },
            .rect_half = .{ r.w / 2, r.h / 2 },
            .radius = radius,
            .param = sigma,
            .mode = .shadow,
            .color = sh.color.toU8(),
        });
    }

    b.pushQuad(.{
        .x = r.x,
        .y = r.y,
        .w = r.w,
        .h = r.h,
        .rect_center = .{ r.x + r.w / 2, r.y + r.h / 2 },
        .rect_half = .{ r.w / 2, r.h / 2 },
        .radius = radius,
        .param = if (style.border) |bd| bd.width else 0,
        .mode = .shape,
        .color = style.fill.toU8(),
        .border_color = if (style.border) |bd| bd.color.toU8() else .{ 0, 0, 0, 0 },
    });
}

pub const TextStyle = struct {
    font: *const text_mod.Font,
    size: f32, // CSS-equivalent em size, logical px
    color: Color,
    letter_spacing: f32 = 0, // logical px, CSS letter-spacing
};

pub const TextMetrics = struct {
    width: f32, // logical px
    ascent: f32,
    descent: f32, // negative, below the baseline
    line_gap: f32,

    /// CSS `line-height: normal` equivalent.
    pub fn lineHeight(self: TextMetrics) f32 {
        return self.ascent - self.descent + self.line_gap;
    }
};

/// Draw a single line. `pos` is the top-left of the line box. Returns the
/// advance width in logical px. Newlines are not interpreted here — that is
/// textWrapped's job.
pub fn text(b: *batch.Batch, a: *atlas_mod.Atlas, dpi: f32, pos: [2]f32, str: []const u8, style: TextStyle) f32 {
    const px_device: u16 = @intFromFloat(@round(style.size * dpi));
    const scale = style.font.scaleForPx(@floatFromInt(px_device));
    const vm = style.font.lineMetrics(@floatFromInt(px_device));
    // One snap per line for the baseline, one per glyph for the origin.
    const baseline_y: f32 = @round(pos[1] * dpi + vm.ascent);
    var pen_x: f32 = pos[0] * dpi;
    const origin_x = pen_x;

    var prev_glyph: i32 = -1;
    var it = std.unicode.Utf8View.initUnchecked(str).iterator();
    while (it.nextCodepoint()) |cp| {
        const glyph = style.font.glyphIndex(cp);
        if (prev_glyph >= 0) {
            pen_x += style.font.kern(prev_glyph, glyph, scale) + style.letter_spacing * dpi;
        }
        const entry = a.getGlyph(style.font, glyph, px_device);
        if (entry.w > 0) {
            const gx = @round(pen_x) + @as(f32, @floatFromInt(entry.off_x));
            const gy = baseline_y + @as(f32, @floatFromInt(entry.off_y));
            const gw: f32 = @floatFromInt(entry.w);
            const gh: f32 = @floatFromInt(entry.h);
            const atlas_size: f32 = @floatFromInt(a.size);
            b.pushQuad(.{
                .x = gx / dpi,
                .y = gy / dpi,
                .w = gw / dpi,
                .h = gh / dpi,
                .rect_center = .{ 0, 0 }, // unused in glyph mode
                .rect_half = .{ 0, 0 },
                .mode = .glyph,
                .color = style.color.toU8(),
                .uv0 = .{ @as(f32, @floatFromInt(entry.x)) / atlas_size, @as(f32, @floatFromInt(entry.y)) / atlas_size },
                .uv1 = .{ (@as(f32, @floatFromInt(entry.x)) + gw) / atlas_size, (@as(f32, @floatFromInt(entry.y)) + gh) / atlas_size },
            });
        }
        pen_x += entry.advance;
        prev_glyph = glyph;
    }
    return (pen_x - origin_x) / dpi;
}

/// Measure without drawing — same pen math as text(), no atlas involved,
/// so widgets can measure before anything is rasterized.
pub fn measureText(font: *const text_mod.Font, size: f32, dpi: f32, str: []const u8, letter_spacing: f32) TextMetrics {
    const px_device: f32 = @round(size * dpi);
    const scale = font.scaleForPx(px_device);
    const vm = font.lineMetrics(px_device);
    var width: f32 = 0;
    var prev_glyph: i32 = -1;
    var it = std.unicode.Utf8View.initUnchecked(str).iterator();
    while (it.nextCodepoint()) |cp| {
        const glyph = font.glyphIndex(cp);
        if (prev_glyph >= 0) {
            width += font.kern(prev_glyph, glyph, scale) + letter_spacing * dpi;
        }
        width += font.advance(glyph, scale);
        prev_glyph = glyph;
    }
    return .{
        .width = width / dpi,
        .ascent = vm.ascent / dpi,
        .descent = vm.descent / dpi,
        .line_gap = vm.line_gap / dpi,
    };
}

/// Naive greedy wrap at spaces only (plan 4.3 defers real line breaking).
/// `\n` forces a break; a word wider than max_width overflows its line
/// rather than being split. Returns the total height consumed.
pub fn textWrapped(b: *batch.Batch, a: *atlas_mod.Atlas, dpi: f32, pos: [2]f32, max_width: f32, line_height: f32, str: []const u8, style: TextStyle) f32 {
    var y = pos[1];
    var line_start: usize = 0;
    var line_width: f32 = 0;
    const space_width = measureText(style.font, style.size, dpi, " ", 0).width;

    var word_it = std.mem.splitAny(u8, str, " \n");
    var cursor: usize = 0; // byte offset of the current word within str
    while (word_it.next()) |word| {
        const word_end = cursor + word.len;
        const word_width = measureText(style.font, style.size, dpi, word, style.letter_spacing).width;
        const fits = line_width == 0 or line_width + space_width + word_width <= max_width;
        const forced = cursor > line_start and str[cursor - 1] == '\n';
        if ((!fits or forced) and cursor > line_start) {
            _ = text(b, a, dpi, .{ pos[0], y }, std.mem.trimEnd(u8, str[line_start .. cursor - 1], " "), style);
            y += line_height;
            line_start = cursor;
            line_width = word_width;
        } else {
            line_width += if (line_width == 0) word_width else space_width + word_width;
        }
        cursor = word_end + 1;
    }
    if (line_start < str.len) {
        _ = text(b, a, dpi, .{ pos[0], y }, std.mem.trimEnd(u8, str[line_start..], " "), style);
        y += line_height;
    }
    return y - pos[1];
}
