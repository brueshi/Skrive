//------------------------------------------------------------------------------
//  draw.zig — the high-level draw API. Stage 1: rect(r, style).
//
//  Translates styled rectangles into batcher quads: shadows first (painter's
//  order, back to front), then the fill+border shape. Shadow layering follows
//  CSS box-shadow: a style carries a list of shadows because Skrive's own
//  elevation tokens are multi-layer (--skrive-shadow-sheet is two). Like CSS,
//  the shadow is also drawn underneath the shape, so a translucent fill over
//  its own shadow darkens; Skrive surfaces are opaque, so this stays faithful
//  where it matters.
//------------------------------------------------------------------------------
const std = @import("std");
const batch = @import("../gfx/batch.zig");

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
