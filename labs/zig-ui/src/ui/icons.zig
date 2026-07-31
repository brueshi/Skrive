//------------------------------------------------------------------------------
//  icons.zig — hand-transcribed Skrive icons as SDF primitives (Stage 5).
//
//  Three of the shipped line icons (app/src/components/icons/), flattened to
//  what the Stage 1 shape shader can express: axis-aligned rounded rects.
//  This is deliberately NOT an SVG renderer — each icon is a handful of
//  primitive calls transcribed from its source path, and the transcription
//  records exactly where the primitive vocabulary runs out:
//
//  - A round-capped straight stroke IS a pill-radius rect (plus): exact.
//  - A stroked circle IS a border-mode rect at half-size radius (search
//    lens): exact, because the SDF's rounded-rect degenerates to a circle.
//  - A 45-degree stroke (the search handle) has NO primitive: the vertex
//    format carries no rotation, so it is approximated by stamping filled
//    circles along the segment. Overlapping AA fringes double-blend, which
//    reads as a faintly darker seam at 1x and disappears at 2x. A real
//    renderer grows a rotated-quad transform here (GPUI and Dear ImGui both
//    have one); a finding for the verdict, not a reason to build it.
//  - An ellipse (the pin's head) and a cubic bezier (the pin's base plate)
//    have no primitive either. The pin head becomes a stadium (pill) of the
//    same bounds — at 16px the difference is a sub-pixel bulge — and the
//    plate becomes a stroked rounded rect. The pin is the icon that names
//    the vocabulary's edge; the verdict says so.
//
//  Icons draw in the source art's 16-grid, scaled to the requested size, at
//  stroke 1.25 (the shipped 16px stroke width). Colour rides the caller,
//  exactly like currentColor.
//------------------------------------------------------------------------------
const draw = @import("draw.zig");
const batch = @import("../gfx/batch.zig");

const Color = draw.Color;

pub const Icon = enum { plus, search, pin };

const stroke: f32 = 1.25; // the shipped 16px icons' stroke-width

/// Draw `icon` into a size x size box whose top-left is (x, y).
pub fn drawIcon(b: *batch.Batch, icon: Icon, x: f32, y: f32, size: f32, color: Color) void {
    const s = size / 16.0; // icons are authored on the shipped 16-grid
    switch (icon) {
        .plus => drawPlus(b, x, y, s, color),
        .search => drawSearch(b, x, y, s, color),
        .pin => drawPin(b, x, y, s, color),
    }
}

/// A round-capped stroke between two points on the same axis — a pill rect.
/// Exact for horizontal/vertical strokes; callers pass grid coordinates.
fn cap_stroke(b: *batch.Batch, x0: f32, y0: f32, x1: f32, y1: f32, w: f32, color: Color) void {
    const half = w / 2;
    b_rect(b, .{
        .x = @min(x0, x1) - half,
        .y = @min(y0, y1) - half,
        .w = @abs(x1 - x0) + w,
        .h = @abs(y1 - y0) + w,
    }, w / 2, color);
}

fn b_rect(b: *batch.Batch, r: draw.Rect, radius: f32, color: Color) void {
    draw.rect(b, r, .{ .fill = color, .radius = radius });
}

fn ring(b: *batch.Batch, cx: f32, cy: f32, rx: f32, ry: f32, w: f32, color: Color) void {
    // A centred stroke: the shape's outer edge sits at r + w/2 and the
    // border (drawn inside the edge, CSS model) is w wide.
    draw.rect(b, .{
        .x = cx - rx - w / 2,
        .y = cy - ry - w / 2,
        .w = 2 * rx + w,
        .h = 2 * ry + w,
    }, .{
        .fill = color.withAlpha(0),
        .radius = @min(rx, ry) + w / 2,
        .border = .{ .width = w, .color = color },
    });
}

// IconPlus (16): line 8,3 -> 8,13 + line 3,8 -> 13,8, round caps. Exact.
fn drawPlus(b: *batch.Batch, x: f32, y: f32, s: f32, color: Color) void {
    cap_stroke(b, x + 8 * s, y + 3 * s, x + 8 * s, y + 13 * s, stroke * s, color);
    cap_stroke(b, x + 3 * s, y + 8 * s, x + 13 * s, y + 8 * s, stroke * s, color);
}

// IconSearch (16): circle cx 7, cy 7, r 4.25 + line 10.2,10.2 -> 13.5,13.5.
// The lens is exact; the 45-degree handle is the circle-chain approximation
// described in the header.
fn drawSearch(b: *batch.Batch, x: f32, y: f32, s: f32, color: Color) void {
    ring(b, x + 7 * s, y + 7 * s, 4.25 * s, 4.25 * s, stroke * s, color);
    const steps = 12;
    const r = stroke * s / 2;
    var i: usize = 0;
    while (i <= steps) : (i += 1) {
        const t = @as(f32, @floatFromInt(i)) / steps;
        const px = x + (10.2 + (13.5 - 10.2) * t) * s;
        const py = y + (10.2 + (13.5 - 10.2) * t) * s;
        b_rect(b, .{ .x = px - r, .y = py - r, .w = 2 * r, .h = 2 * r }, r, color);
    }
}

// IconPin, transcribed from its 88-grid viewBox onto the 16-grid (scale
// 16/88, origin 14,13) and simplified to the primitive vocabulary: stadium
// head (source: ellipse), two vertical flank strokes (source: near-vertical
// lines, slant < 0.2px at 16px), stroked rounded-rect plate (source: cubic
// beziers), square-capped needle. The least faithful of the three by
// construction — see the header.
fn drawPin(b: *batch.Batch, x: f32, y: f32, s: f32, color: Color) void {
    const w = stroke * s;
    // Head: ellipse centre (8, 2.7), rx 2.85, ry 1.07 -> stadium bounds.
    ring(b, x + 8 * s, y + 2.7 * s, 2.85 * s, 1.07 * s, w, color);
    // Flanks: from the head's underside down to the plate.
    cap_stroke(b, x + 5.95 * s, y + 3.6 * s, x + 5.95 * s, y + 7.0 * s, w, color);
    cap_stroke(b, x + 10.15 * s, y + 3.7 * s, x + 10.15 * s, y + 7.0 * s, w, color);
    // Plate: the domed base flattened to a stroked rounded rect.
    ring(b, x + 8 * s, y + 8.0 * s, 3.5 * s, 1.1 * s, w, color);
    // Needle: square caps in the source (strokeLinecap on the path is
    // square) — a plain rect, no pill radius.
    b_rect(b, .{
        .x = x + 8 * s - w / 2,
        .y = y + 9.1 * s,
        .w = w,
        .h = 5.3 * s,
    }, 0, color);
}
