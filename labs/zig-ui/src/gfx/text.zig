//------------------------------------------------------------------------------
//  text.zig — the stb_truetype wrapper. Load a font, scale metrics,
//  rasterize glyph bitmaps.
//
//  Scale semantics: sizes are CSS-equivalent em sizes. stb's
//  ScaleForPixelHeight maps (ascent - descent) to the pixel size, which for
//  Inter (hhea ascent+descent > unitsPerEm) renders ~19% smaller than the
//  same nominal size in a browser; ScaleForMappingEmToPixels matches what
//  CSS font-size means, so the side-by-side comparison compares like with
//  like. All rasterization happens in device pixels — callers convert
//  logical px to device px before asking for glyphs.
//
//  Lab tier only (plan 4.3): no shaping, no subpixel AA, no hinting.
//  Kerning comes from stb's kern/GPOS pair support.
//------------------------------------------------------------------------------
const std = @import("std");
const c = @cImport({
    @cInclude("stb_truetype.h");
});

/// Scaled vertical metrics for one (font, device px size) pair.
/// ascent is positive up from the baseline, descent negative below it.
pub const LineMetrics = struct {
    ascent: f32,
    descent: f32,
    line_gap: f32,
};

/// A rasterized glyph bitmap: tight single-channel coverage, plus the
/// offset of its top-left from the pen position on the baseline.
pub const GlyphBitmap = struct {
    pixels: []u8, // w*h, caller frees via free()
    w: u32,
    h: u32,
    off_x: i32, // pen + off is the bitmap's top-left, device px
    off_y: i32, // negative: bitmaps start above the baseline
};

pub const Font = struct {
    info: c.stbtt_fontinfo,
    id: u8, // atlas cache key component; assign uniquely per loaded font

    pub fn init(id: u8, ttf: []const u8) !Font {
        var font: Font = .{ .info = undefined, .id = id };
        const offset = c.stbtt_GetFontOffsetForIndex(ttf.ptr, 0);
        if (offset < 0) return error.InvalidFont;
        if (c.stbtt_InitFont(&font.info, ttf.ptr, offset) == 0) return error.InvalidFont;
        return font;
    }

    /// Unitless font-space -> device-px scale for a CSS-equivalent em size.
    pub fn scaleForPx(self: *const Font, px: f32) f32 {
        return c.stbtt_ScaleForMappingEmToPixels(&self.info, px);
    }

    pub fn lineMetrics(self: *const Font, px: f32) LineMetrics {
        const scale = self.scaleForPx(px);
        var ascent: c_int = 0;
        var descent: c_int = 0;
        var line_gap: c_int = 0;
        c.stbtt_GetFontVMetrics(&self.info, &ascent, &descent, &line_gap);
        return .{
            .ascent = @as(f32, @floatFromInt(ascent)) * scale,
            .descent = @as(f32, @floatFromInt(descent)) * scale,
            .line_gap = @as(f32, @floatFromInt(line_gap)) * scale,
        };
    }

    /// 0 = the .notdef glyph, which renders as the missing-glyph box.
    pub fn glyphIndex(self: *const Font, codepoint: u21) i32 {
        return c.stbtt_FindGlyphIndex(&self.info, @intCast(codepoint));
    }

    /// Advance width in device px at the given scale.
    pub fn advance(self: *const Font, glyph: i32, scale: f32) f32 {
        var adv: c_int = 0;
        var lsb: c_int = 0;
        c.stbtt_GetGlyphHMetrics(&self.info, glyph, &adv, &lsb);
        return @as(f32, @floatFromInt(adv)) * scale;
    }

    /// Kerning adjustment between two glyphs in device px (kern table or
    /// GPOS pair kerning, whichever the font carries — Inter is GPOS-only).
    pub fn kern(self: *const Font, g1: i32, g2: i32, scale: f32) f32 {
        return @as(f32, @floatFromInt(c.stbtt_GetGlyphKernAdvance(&self.info, g1, g2))) * scale;
    }

    /// Rasterize a glyph at the given device-px scale. Whitespace and other
    /// empty glyphs return a 0x0 bitmap with a null pixels slice.
    pub fn rasterize(self: *const Font, allocator: std.mem.Allocator, glyph: i32, scale: f32) !GlyphBitmap {
        var x0: c_int = 0;
        var y0: c_int = 0;
        var x1: c_int = 0;
        var y1: c_int = 0;
        c.stbtt_GetGlyphBitmapBox(&self.info, glyph, scale, scale, &x0, &y0, &x1, &y1);
        const w: u32 = @intCast(@max(x1 - x0, 0));
        const h: u32 = @intCast(@max(y1 - y0, 0));
        if (w == 0 or h == 0) {
            return .{ .pixels = &.{}, .w = 0, .h = 0, .off_x = 0, .off_y = 0 };
        }
        const pixels = try allocator.alloc(u8, w * h);
        c.stbtt_MakeGlyphBitmap(&self.info, pixels.ptr, @intCast(w), @intCast(h), @intCast(w), scale, scale, glyph);
        return .{ .pixels = pixels, .w = w, .h = h, .off_x = x0, .off_y = y0 };
    }

    pub fn free(allocator: std.mem.Allocator, bitmap: GlyphBitmap) void {
        if (bitmap.pixels.len > 0) allocator.free(bitmap.pixels);
    }
};
