//------------------------------------------------------------------------------
//  batch.zig — the quad batcher, the narrow waist of the renderer.
//
//  Everything above this file speaks "push quad"; everything below it is
//  sokol_gfx. Quads accumulate in a growable CPU vertex array and go to the
//  GPU once per frame: sokol allows a single updateBuffer per buffer per
//  frame, so capacity is handled by growing the GPU buffer at upload time
//  rather than by mid-frame flushes. flush() closes the current draw range;
//  Stage 1 never needs it mid-frame, but it is the seam where Stage 2's
//  texture-change splits land.
//
//  Frame protocol (upload happens outside the render pass, draw inside):
//      batch.begin()
//      ... pushQuad() ...
//      batch.upload()
//      sg.beginPass(...); batch.draw(fb_size, dpi_scale); sg.endPass();
//------------------------------------------------------------------------------
const std = @import("std");
const sg = @import("sokol").gfx;
const shd = @import("sdf_shapes.glsl.zig");

/// Matches the vertex layout of sdf_shapes.glsl. 52 bytes.
pub const Vertex = extern struct {
    pos: [2]f32,
    rect: [4]f32, // target rounded rect: center.xy, half_size.xy
    uv: [2]f32,
    geom: [2]f32, // radius, border width (shape) / sigma (shadow)
    mode: f32,
    color: [4]u8,
    border_color: [4]u8,
};

pub const Mode = enum(u8) {
    shape = 0, // fill + optional border
    shadow = 1,
    glyph = 2, // uv samples the atlas as coverage, tinted by color
};

/// One rasterized quad. `x y w h` is the geometry actually covered by the
/// two triangles; the shape it renders is the rounded rect described by
/// `rect_center`/`rect_half` (they differ for shadows, whose quads are
/// expanded by 3*sigma). All coordinates are logical px.
pub const Quad = struct {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    rect_center: [2]f32,
    rect_half: [2]f32,
    radius: f32 = 0,
    param: f32 = 0,
    mode: Mode = .shape,
    color: [4]u8,
    border_color: [4]u8 = .{ 0, 0, 0, 0 },
    uv0: [2]f32 = .{ 0, 0 },
    uv1: [2]f32 = .{ 1, 1 },
};

const DrawRange = struct {
    base: u32,
    count: u32,
};

pub const FrameStats = struct {
    quads: u32 = 0,
    draw_calls: u32 = 0,
};

pub const Batch = struct {
    allocator: std.mem.Allocator,
    verts: std.ArrayList(Vertex) = .empty,
    ranges: std.ArrayList(DrawRange) = .empty,
    range_base: u32 = 0,
    pip: sg.Pipeline = .{},
    buf: sg.Buffer = .{},
    buf_capacity: usize = 0,
    stats: FrameStats = .{},

    /// Requires a live sokol_gfx context (call from sokol's init callback).
    pub fn init(allocator: std.mem.Allocator) Batch {
        var desc: sg.PipelineDesc = .{
            .shader = sg.makeShader(shd.sdfShapesShaderDesc(sg.queryBackend())),
            .label = "sdf-shapes",
        };
        desc.layout.buffers[0].stride = @sizeOf(Vertex);
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_pos] = .{ .format = .FLOAT2, .offset = @offsetOf(Vertex, "pos") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_rect] = .{ .format = .FLOAT4, .offset = @offsetOf(Vertex, "rect") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_uv] = .{ .format = .FLOAT2, .offset = @offsetOf(Vertex, "uv") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_geom] = .{ .format = .FLOAT2, .offset = @offsetOf(Vertex, "geom") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_mode] = .{ .format = .FLOAT, .offset = @offsetOf(Vertex, "mode") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_color] = .{ .format = .UBYTE4N, .offset = @offsetOf(Vertex, "color") };
        desc.layout.attrs[shd.ATTR_sdf_shapes_in_border_color] = .{ .format = .UBYTE4N, .offset = @offsetOf(Vertex, "border_color") };
        // Non-premultiplied alpha over whatever is already in the target.
        desc.colors[0].blend = .{
            .enabled = true,
            .src_factor_rgb = .SRC_ALPHA,
            .dst_factor_rgb = .ONE_MINUS_SRC_ALPHA,
            .src_factor_alpha = .ONE,
            .dst_factor_alpha = .ONE_MINUS_SRC_ALPHA,
        };
        return .{ .allocator = allocator, .pip = sg.makePipeline(desc) };
    }

    pub fn begin(self: *Batch) void {
        self.verts.clearRetainingCapacity();
        self.ranges.clearRetainingCapacity();
        self.range_base = 0;
        self.stats = .{};
    }

    pub fn pushQuad(self: *Batch, q: Quad) void {
        self.verts.ensureUnusedCapacity(self.allocator, 6) catch @panic("zig-ui: vertex array OOM");
        const rect: [4]f32 = .{ q.rect_center[0], q.rect_center[1], q.rect_half[0], q.rect_half[1] };
        const geom: [2]f32 = .{ q.radius, q.param };
        const mode: f32 = @floatFromInt(@intFromEnum(q.mode));
        const x1 = q.x + q.w;
        const y1 = q.y + q.h;
        const v = [4]Vertex{
            .{ .pos = .{ q.x, q.y }, .rect = rect, .uv = q.uv0, .geom = geom, .mode = mode, .color = q.color, .border_color = q.border_color },
            .{ .pos = .{ x1, q.y }, .rect = rect, .uv = .{ q.uv1[0], q.uv0[1] }, .geom = geom, .mode = mode, .color = q.color, .border_color = q.border_color },
            .{ .pos = .{ x1, y1 }, .rect = rect, .uv = q.uv1, .geom = geom, .mode = mode, .color = q.color, .border_color = q.border_color },
            .{ .pos = .{ q.x, y1 }, .rect = rect, .uv = .{ q.uv0[0], q.uv1[1] }, .geom = geom, .mode = mode, .color = q.color, .border_color = q.border_color },
        };
        self.verts.appendSliceAssumeCapacity(&.{ v[0], v[1], v[2], v[0], v[2], v[3] });
        self.stats.quads += 1;
    }

    /// Close the current draw range. A later range becomes its own draw call;
    /// Stage 2 calls this when the bound texture must change mid-frame.
    pub fn flush(self: *Batch) void {
        const len: u32 = @intCast(self.verts.items.len);
        if (len == self.range_base) return;
        self.ranges.append(self.allocator, .{
            .base = self.range_base,
            .count = len - self.range_base,
        }) catch @panic("zig-ui: draw range OOM");
        self.range_base = len;
    }

    /// Upload the frame's vertices. Call after the last pushQuad and before
    /// the render pass; grows the GPU buffer when the frame outgrows it.
    pub fn upload(self: *Batch) void {
        self.flush();
        if (self.verts.items.len == 0) return;
        const needed = self.verts.items.len * @sizeOf(Vertex);
        if (needed > self.buf_capacity) {
            if (self.buf.id != 0) sg.destroyBuffer(self.buf);
            // 1.5x headroom so steady growth does not reallocate every frame.
            self.buf_capacity = needed + needed / 2;
            self.buf = sg.makeBuffer(.{
                .size = self.buf_capacity,
                .usage = .{ .vertex_buffer = true, .stream_update = true },
                .label = "batch-vertices",
            });
        }
        sg.updateBuffer(self.buf, sg.asRange(self.verts.items));
    }

    /// Issue the frame's draw calls. Call inside the render pass. The glyph
    /// atlas is bound unconditionally: with exactly one texture in the
    /// renderer there is never a texture change mid-frame, so shapes and
    /// glyphs share one draw call and the flush() seam stays in reserve for
    /// a second texture (images/icons) that Stage 2 deliberately lacks.
    pub fn draw(self: *Batch, fb_size: [2]f32, dpi_scale: f32, atlas_view: sg.View, atlas_smp: sg.Sampler) void {
        if (self.ranges.items.len == 0) return;
        sg.applyPipeline(self.pip);
        var bindings: sg.Bindings = .{};
        bindings.vertex_buffers[0] = self.buf;
        bindings.views[shd.VIEW_atlas_tex] = atlas_view;
        bindings.samplers[shd.SMP_atlas_smp] = atlas_smp;
        sg.applyBindings(bindings);
        const params: shd.VsParams = .{ .fb_size = fb_size, .dpi_scale = dpi_scale };
        sg.applyUniforms(shd.UB_vs_params, sg.asRange(&params));
        for (self.ranges.items) |range| {
            sg.draw(range.base, range.count, 1);
            self.stats.draw_calls += 1;
        }
    }
};
