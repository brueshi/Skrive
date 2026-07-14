//------------------------------------------------------------------------------
//  atlas.zig — the glyph atlas: a single-channel (R8) texture the batcher
//  binds once per frame, shelf-packed, cached by (font id, glyph, px size).
//
//  Packing is the plan's shelf algorithm (Ghostty uses skyline; shelf is
//  strictly simpler and no eviction means fragmentation cannot accumulate
//  into a problem the lab would ever notice). Every glyph gets a 1px empty
//  border so a half-texel sampling wobble can never bleed a neighbor in.
//
//  Growth: starts 1024x1024, doubles by reallocation when a glyph does not
//  fit — CPU pixels are copied row-by-row into the bigger square (packed
//  coordinates stay valid), the GPU image is destroyed and recreated, and
//  the whole texture re-uploads on the next commit(). Growth events print
//  to the terminal per the plan.
//
//  sokol constraints shaping this file: sg.updateImage replaces the whole
//  image (no partial updates) and is allowed at most once per image per
//  frame — hence the CPU-side pixel buffer as source of truth and a single
//  dirty-flagged commit() per frame, mirroring the batcher's upload().
//------------------------------------------------------------------------------
const std = @import("std");
const sg = @import("sokol").gfx;
const text = @import("text.zig");

const initial_size: u32 = 1024;
const max_size: u32 = 8192;
const pad: u32 = 1;

pub const Key = struct {
    font_id: u8,
    glyph: i32,
    px: u16, // device px size the glyph was rasterized at
};

/// A cached glyph: its pixel rect in the atlas (uv derived at push time so
/// growth never invalidates entries) plus placement and advance metrics,
/// all in device px. Empty glyphs (whitespace) have w == h == 0.
pub const Entry = struct {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    off_x: i16,
    off_y: i16,
    advance: f32,
};

pub const Atlas = struct {
    allocator: std.mem.Allocator,
    size: u32 = initial_size,
    pixels: []u8,
    cache: std.AutoHashMapUnmanaged(Key, Entry) = .empty,
    shelf_x: u32 = pad,
    shelf_y: u32 = pad,
    shelf_h: u32 = 0,
    img: sg.Image = .{},
    view: sg.View = .{}, // texture view of img; what the batcher binds
    smp: sg.Sampler = .{},
    dirty: bool = false,
    growth_count: u32 = 0,

    /// Requires a live sokol_gfx context.
    pub fn init(allocator: std.mem.Allocator) Atlas {
        var self: Atlas = .{
            .allocator = allocator,
            .pixels = allocator.alloc(u8, initial_size * initial_size) catch @panic("zig-ui: atlas OOM"),
        };
        @memset(self.pixels, 0);
        self.img = makeImage(self.size);
        self.view = sg.makeView(.{ .texture = .{ .image = self.img }, .label = "glyph-atlas-view" });
        // Nearest: glyph quads are pixel-snapped to exact texel alignment,
        // so filtering has nothing to interpolate and nearest is exact.
        self.smp = sg.makeSampler(.{
            .min_filter = .NEAREST,
            .mag_filter = .NEAREST,
            .wrap_u = .CLAMP_TO_EDGE,
            .wrap_v = .CLAMP_TO_EDGE,
            .label = "glyph-atlas-sampler",
        });
        return self;
    }

    fn makeImage(size: u32) sg.Image {
        return sg.makeImage(.{
            .width = @intCast(size),
            .height = @intCast(size),
            .pixel_format = .R8,
            .usage = .{ .dynamic_update = true },
            .label = "glyph-atlas",
        });
    }

    /// Cache lookup; rasterizes and packs on miss. Never returns null for a
    /// valid font — missing codepoints arrive here as glyph 0 (.notdef) and
    /// render as the missing-glyph box, which is the honest failure mode.
    pub fn getGlyph(self: *Atlas, font: *const text.Font, glyph: i32, px: u16) Entry {
        const key: Key = .{ .font_id = font.id, .glyph = glyph, .px = px };
        if (self.cache.get(key)) |entry| return entry;

        const scale = font.scaleForPx(@floatFromInt(px));
        const bitmap = font.rasterize(self.allocator, glyph, scale) catch @panic("zig-ui: glyph raster OOM");
        defer text.Font.free(self.allocator, bitmap);

        var entry: Entry = .{
            .x = 0,
            .y = 0,
            .w = @intCast(bitmap.w),
            .h = @intCast(bitmap.h),
            .off_x = @intCast(bitmap.off_x),
            .off_y = @intCast(bitmap.off_y),
            .advance = font.advance(glyph, scale),
        };
        if (bitmap.w > 0) {
            const pos = self.pack(bitmap.w, bitmap.h);
            entry.x = @intCast(pos[0]);
            entry.y = @intCast(pos[1]);
            var row: u32 = 0;
            while (row < bitmap.h) : (row += 1) {
                const dst = (pos[1] + row) * self.size + pos[0];
                @memcpy(self.pixels[dst .. dst + bitmap.w], bitmap.pixels[row * bitmap.w .. (row + 1) * bitmap.w]);
            }
            self.dirty = true;
        }
        self.cache.put(self.allocator, key, entry) catch @panic("zig-ui: atlas cache OOM");
        return entry;
    }

    /// Shelf packing: fill left to right along the current shelf, open a new
    /// shelf when the row is full, grow the atlas when the shelves are.
    fn pack(self: *Atlas, w: u32, h: u32) [2]u32 {
        while (true) {
            if (self.shelf_x + w + pad <= self.size and self.shelf_y + h + pad <= self.size) {
                const pos: [2]u32 = .{ self.shelf_x, self.shelf_y };
                self.shelf_x += w + pad;
                self.shelf_h = @max(self.shelf_h, h);
                return pos;
            }
            // Next shelf, then retry; grow when even a fresh shelf can't fit.
            if (self.shelf_x > pad and self.shelf_y + self.shelf_h + pad + h + pad <= self.size) {
                self.shelf_y += self.shelf_h + pad;
                self.shelf_x = pad;
                self.shelf_h = 0;
                continue;
            }
            self.grow();
        }
    }

    fn grow(self: *Atlas) void {
        const new_size = self.size * 2;
        if (new_size > max_size) @panic("zig-ui: glyph atlas exceeded 8192x8192 (no eviction at lab tier)");
        const new_pixels = self.allocator.alloc(u8, new_size * new_size) catch @panic("zig-ui: atlas OOM");
        @memset(new_pixels, 0);
        var row: u32 = 0;
        while (row < self.size) : (row += 1) {
            @memcpy(new_pixels[row * new_size .. row * new_size + self.size], self.pixels[row * self.size .. (row + 1) * self.size]);
        }
        self.allocator.free(self.pixels);
        self.pixels = new_pixels;
        sg.destroyView(self.view);
        sg.destroyImage(self.img);
        self.img = makeImage(new_size);
        self.view = sg.makeView(.{ .texture = .{ .image = self.img }, .label = "glyph-atlas-view" });
        self.growth_count += 1;
        std.debug.print("atlas: grew {d} -> {d} ({d} glyphs cached)\n", .{ self.size, new_size, self.cache.count() });
        self.size = new_size;
        self.dirty = true;
    }

    /// Upload the atlas if any glyph landed this frame. Call once per frame
    /// after the scene is built, before the render pass (sokol allows one
    /// updateImage per image per frame).
    pub fn commit(self: *Atlas) void {
        if (!self.dirty) return;
        var data: sg.ImageData = .{};
        data.mip_levels[0] = sg.asRange(self.pixels);
        sg.updateImage(self.img, data);
        self.dirty = false;
    }

    /// Occupancy estimate for the HUD: fraction of shelf area consumed.
    pub fn occupancy(self: *const Atlas) f32 {
        const used = self.shelf_y * self.size + self.shelf_x * self.shelf_h;
        return @as(f32, @floatFromInt(used)) / @as(f32, @floatFromInt(self.size * self.size));
    }
};
