//------------------------------------------------------------------------------
//  layout.zig — flexbox-lite: immediate-mode row/column boxes with padding,
//  gap, per-child main-axis sizing (fixed / content / grow) and cross-axis
//  alignment (start / center / end / stretch).
//
//  Scope is deliberately the ~20% of flexbox Skrive's own components use. A
//  read of app/src/components/ui/*.module.css plus the settings-row rules in
//  app/src/index.css turns up exactly this vocabulary and nothing else:
//
//      .settings-row       display:flex; align-items:center;
//                          justify-content:space-between; gap:24px;
//                          padding:16px 18px
//      .settings-row-text  display:flex; flex-direction:column; gap:3px;
//                          flex:1; min-width:0
//      .settings-row-ctl   flex-shrink:0
//      (the ui/ kit itself)  inline-flex + align-items:center
//                            + justify-content:center + a gap
//
//  So: two directions, one gap, per-side padding, three sizing modes, four
//  cross alignments. No wrapping, no percentages, no order/basis/auto-margins,
//  no CSS parity — all of that is out of Stage 4's scope by the plan.
//  `justify-content: space-between` is not a separate feature here: it is what
//  a grow child between two content children already does, which is how the
//  real settings row achieves it (flex:1 on the text block, not on the row).
//
//  THE DESIGN CALL WORTH RECORDING. dvui's BoxWidget distributes grow space
//  from the *previous* frame's measurements (`data_prev.min_space_taken`) and
//  calls refresh() when this frame diverges; the long Dear ImGui layout thread
//  lands in the same place — a one-frame lag is the accepted price of letting
//  children be emitted before the container knows its own content. That price
//  is much higher here than it is there. Both of those libraries render
//  continuously, so the lag is invisible; this lab renders on demand, where a
//  layout that is wrong on the frame an event arrives needs a *second* repaint
//  that nothing would schedule — the same trap Stage 3 avoided by hit-testing
//  this frame instead of last frame.
//
//  So a Box takes its children as declarations up front (the third option in
//  that ImGui thread), resolves them in one measure+arrange pass, and hands
//  back rects the caller then draws into. Widgets are emitted *after* the
//  arithmetic instead of during it. The cost is real and worth naming: a
//  child's natural size is the caller's to supply (`.content = measured`),
//  so this cannot infer a deeply nested subtree's intrinsic size the way a
//  retained tree can. At kit scale — a card of rows, a strip of segments —
//  that is a two-line measureText call, and it buys exactness with no frame
//  lag, no refresh loop, and no persistent layout state at all.
//------------------------------------------------------------------------------
const std = @import("std");
const draw = @import("draw.zig");

pub const Axis = enum { row, column };

/// Cross-axis placement. `stretch` fills the container's cross extent, which
/// is also what a child with no cross size gets (CSS: a row child with height
/// auto stretches).
pub const Align = enum { start, center, end, stretch };

/// Container main-axis sizing. `fill` spans the bounds it was given;
/// `content` shrinks the container to exactly what its children need, which is
/// what lets a card be as tall as its rows without anyone doing the addition.
pub const Fit = enum { fill, content };

pub const Padding = struct {
    top: f32 = 0,
    right: f32 = 0,
    bottom: f32 = 0,
    left: f32 = 0,

    pub fn all(v: f32) Padding {
        return .{ .top = v, .right = v, .bottom = v, .left = v };
    }

    /// CSS shorthand order: vertical, horizontal.
    pub fn xy(vertical: f32, horizontal: f32) Padding {
        return .{ .top = vertical, .right = horizontal, .bottom = vertical, .left = horizontal };
    }
};

/// Main-axis sizing for one child.
///   fixed   — never grows, never shrinks (CSS flex: 0 0 <n>)
///   content — its natural size, usually from measureText; gives space back
///             when the container is over-subscribed (CSS flex: 0 1 auto)
///   grow    — a weight; base 0, takes a share of what is left over
///             (CSS flex: <w> 1 0)
pub const Size = union(enum) {
    fixed: f32,
    content: f32,
    grow: f32,
};

pub const Item = struct {
    main: Size,
    /// Cross-axis extent. null stretches to the container's cross content box.
    cross: ?f32 = null,
    /// Overrides the container's cross alignment for this child only.
    cross_align: ?Align = null,
    /// Floor for shrinking. A grow child's base size, too.
    min_main: f32 = 0,
};

pub const Options = struct {
    padding: Padding = .{},
    gap: f32 = 0,
    cross: Align = .start,
    main: Fit = .fill,
};

pub const max_items = 32;

pub const Box = struct {
    axis: Axis,
    bounds: draw.Rect,
    opts: Options,
    items: [max_items]Item = undefined,
    rects: [max_items]draw.Rect = undefined,
    len: usize = 0,
    /// Main-axis extent the children actually consumed, including padding and
    /// gaps. Valid after resolve(); equals the bounds' main extent under
    /// Fit.fill unless the children overflowed it.
    used_main: f32 = 0,

    pub fn init(axis: Axis, bounds: draw.Rect, opts: Options) Box {
        return .{ .axis = axis, .bounds = bounds, .opts = opts };
    }

    pub fn row(bounds: draw.Rect, opts: Options) Box {
        return init(.row, bounds, opts);
    }

    pub fn column(bounds: draw.Rect, opts: Options) Box {
        return init(.column, bounds, opts);
    }

    /// Declare a child. Returns its index, which is also its index into the
    /// resolved rects. Silently caps at max_items — a lab-scale box that wants
    /// more children wants a nested box instead.
    pub fn add(self: *Box, item: Item) usize {
        if (self.len >= max_items) return max_items - 1;
        self.items[self.len] = item;
        self.len += 1;
        return self.len - 1;
    }

    /// Measure, arrange, and hand back one rect per child in declaration
    /// order. Single pass over the children twice: once to total the bases,
    /// once to place. No state survives the call.
    pub fn resolve(self: *Box) []const draw.Rect {
        const pad_main = self.padMain();
        const pad_cross = self.padCross();
        const gaps = if (self.len > 1) self.opts.gap * @as(f32, @floatFromInt(self.len - 1)) else 0;

        var base_total: f32 = 0;
        var grow_weight: f32 = 0;
        var shrinkable: f32 = 0; // content children's room above their floors
        for (self.items[0..self.len]) |item| {
            const b = baseOf(item);
            base_total += b;
            switch (item.main) {
                .grow => |w| grow_weight += @max(w, 0),
                .content => shrinkable += @max(b - item.min_main, 0),
                .fixed => {},
            }
        }

        const avail_main = mainOf(self.bounds, self.axis) - pad_main;
        const inner_main = if (self.opts.main == .content) base_total + gaps else avail_main;
        const free = inner_main - gaps - base_total;

        // Over-subscribed: grow children are already at their base (their
        // floor), so the deficit comes out of content children in proportion
        // to the room they have above their own floors — CSS's flex-shrink
        // with fixed children opted out. If it still does not fit, the box
        // overflows rather than lying about the space, exactly as the real
        // settings row does when a control refuses to shrink.
        const deficit = if (free < 0) @min(-free, shrinkable) else 0;
        const shrink_ratio = if (deficit > 0 and shrinkable > 0) deficit / shrinkable else 0;
        const per_weight = if (free > 0 and grow_weight > 0) free / grow_weight else 0;

        const content_cross = crossOf(self.bounds, self.axis) - pad_cross;
        var cursor = mainStart(self.bounds, self.axis) + self.padMainStart();
        const cross_start = crossStart(self.bounds, self.axis) + self.padCrossStart();

        for (self.items[0..self.len], 0..) |item, i| {
            var main_size = baseOf(item);
            switch (item.main) {
                .grow => |w| main_size += per_weight * @max(w, 0),
                .content => main_size -= @max(main_size - item.min_main, 0) * shrink_ratio,
                .fixed => {},
            }

            const cross_size = item.cross orelse content_cross;
            const align_mode: Align = if (item.cross == null) .stretch else (item.cross_align orelse self.opts.cross);
            const placed_cross = switch (align_mode) {
                .stretch => content_cross,
                else => @min(cross_size, content_cross),
            };
            const cross_off = switch (align_mode) {
                .start, .stretch => 0,
                .center => (content_cross - placed_cross) / 2,
                .end => content_cross - placed_cross,
            };

            self.rects[i] = switch (self.axis) {
                .row => .{ .x = cursor, .y = cross_start + cross_off, .w = main_size, .h = placed_cross },
                .column => .{ .x = cross_start + cross_off, .y = cursor, .w = placed_cross, .h = main_size },
            };
            cursor += main_size;
            if (i + 1 < self.len) cursor += self.opts.gap;
        }

        self.used_main = cursor - mainStart(self.bounds, self.axis) + self.padMainEnd();
        return self.rects[0..self.len];
    }

    /// The container's own rect after resolve(). Under Fit.content the main
    /// extent is the children's; this is what a card draws its surface with,
    /// so nobody has to add up row heights by hand.
    pub fn resolvedBounds(self: *const Box) draw.Rect {
        var r = self.bounds;
        switch (self.axis) {
            .row => r.w = if (self.opts.main == .content) self.used_main else r.w,
            .column => r.h = if (self.opts.main == .content) self.used_main else r.h,
        }
        return r;
    }

    fn padMain(self: *const Box) f32 {
        return self.padMainStart() + self.padMainEnd();
    }
    fn padMainStart(self: *const Box) f32 {
        return switch (self.axis) {
            .row => self.opts.padding.left,
            .column => self.opts.padding.top,
        };
    }
    fn padMainEnd(self: *const Box) f32 {
        return switch (self.axis) {
            .row => self.opts.padding.right,
            .column => self.opts.padding.bottom,
        };
    }
    fn padCross(self: *const Box) f32 {
        return switch (self.axis) {
            .row => self.opts.padding.top + self.opts.padding.bottom,
            .column => self.opts.padding.left + self.opts.padding.right,
        };
    }
    fn padCrossStart(self: *const Box) f32 {
        return switch (self.axis) {
            .row => self.opts.padding.top,
            .column => self.opts.padding.left,
        };
    }
};

fn baseOf(item: Item) f32 {
    return switch (item.main) {
        .fixed, .content => |v| @max(v, item.min_main),
        .grow => item.min_main,
    };
}

fn mainOf(r: draw.Rect, axis: Axis) f32 {
    return switch (axis) {
        .row => r.w,
        .column => r.h,
    };
}

fn crossOf(r: draw.Rect, axis: Axis) f32 {
    return switch (axis) {
        .row => r.h,
        .column => r.w,
    };
}

fn mainStart(r: draw.Rect, axis: Axis) f32 {
    return switch (axis) {
        .row => r.x,
        .column => r.y,
    };
}

fn crossStart(r: draw.Rect, axis: Axis) f32 {
    return switch (axis) {
        .row => r.y,
        .column => r.x,
    };
}

/// Inset a rect on every side — the one-liner that keeps a caller from doing
/// x + pad arithmetic when it needs a content box outside a Box.
pub fn inset(r: draw.Rect, by: f32) draw.Rect {
    return .{ .x = r.x + by, .y = r.y + by, .w = r.w - 2 * by, .h = r.h - 2 * by };
}

//------------------------------------------------------------------------------
//  Tests — the arithmetic is the whole module, and it is exactly the kind of
//  thing that looks right on screen while being subtly wrong (a gap counted
//  once too often, a cross offset applied to the wrong axis). Pinned here.
//------------------------------------------------------------------------------
const testing = std.testing;
const test_bounds: draw.Rect = .{ .x = 0, .y = 0, .w = 400, .h = 200 };

fn expectRect(r: draw.Rect, x: f32, y: f32, w: f32, h: f32) !void {
    try testing.expectApproxEqAbs(x, r.x, 0.001);
    try testing.expectApproxEqAbs(y, r.y, 0.001);
    try testing.expectApproxEqAbs(w, r.w, 0.001);
    try testing.expectApproxEqAbs(h, r.h, 0.001);
}

test "row: padding, gap, and fixed children" {
    var b = Box.row(test_bounds, .{ .padding = .all(10), .gap = 8 });
    _ = b.add(.{ .main = .{ .fixed = 40 }, .cross = 20 });
    _ = b.add(.{ .main = .{ .fixed = 60 }, .cross = 20 });
    const r = b.resolve();
    try expectRect(r[0], 10, 10, 40, 20);
    try expectRect(r[1], 58, 10, 60, 20); // 10 + 40 + 8
}

test "row: grow takes the remainder after fixed children and gaps" {
    var b = Box.row(test_bounds, .{ .padding = .xy(0, 20), .gap = 10 });
    _ = b.add(.{ .main = .{ .fixed = 100 } });
    _ = b.add(.{ .main = .{ .grow = 1 } });
    _ = b.add(.{ .main = .{ .fixed = 50 } });
    const r = b.resolve();
    // inner 360, minus 150 fixed, minus 2 gaps = 190 for the grow child
    try expectRect(r[1], 130, 0, 190, 200);
    try expectRect(r[2], 330, 0, 50, 200);
}

test "row: two grow children split by weight" {
    var b = Box.row(test_bounds, .{});
    _ = b.add(.{ .main = .{ .grow = 1 } });
    _ = b.add(.{ .main = .{ .grow = 3 } });
    const r = b.resolve();
    try testing.expectApproxEqAbs(@as(f32, 100), r[0].w, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 300), r[1].w, 0.001);
}

test "cross alignment: start, center, end, stretch, and per-child override" {
    var b = Box.row(test_bounds, .{ .cross = .center });
    _ = b.add(.{ .main = .{ .fixed = 10 }, .cross = 40 });
    _ = b.add(.{ .main = .{ .fixed = 10 }, .cross = 40, .cross_align = .start });
    _ = b.add(.{ .main = .{ .fixed = 10 }, .cross = 40, .cross_align = .end });
    _ = b.add(.{ .main = .{ .fixed = 10 }, .cross = 40, .cross_align = .stretch });
    _ = b.add(.{ .main = .{ .fixed = 10 } }); // no cross size: stretches
    const r = b.resolve();
    try testing.expectApproxEqAbs(@as(f32, 80), r[0].y, 0.001); // (200-40)/2
    try testing.expectApproxEqAbs(@as(f32, 0), r[1].y, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 160), r[2].y, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 200), r[3].h, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 200), r[4].h, 0.001);
}

test "column: Fit.content sizes the container to its children" {
    var b = Box.column(.{ .x = 0, .y = 0, .w = 300, .h = 9999 }, .{
        .padding = .xy(16, 18),
        .gap = 4,
        .main = .content,
    });
    _ = b.add(.{ .main = .{ .fixed = 30 } });
    _ = b.add(.{ .main = .{ .fixed = 1 } }); // a hairline divider is just a child
    _ = b.add(.{ .main = .{ .fixed = 30 } });
    const r = b.resolve();
    try expectRect(r[0], 18, 16, 264, 30);
    try expectRect(r[2], 18, 55, 264, 30); // 16 + 30 + 4 + 1 + 4
    // 16 top + 30 + 4 + 1 + 4 + 30 + 16 bottom
    try testing.expectApproxEqAbs(@as(f32, 101), b.used_main, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 101), b.resolvedBounds().h, 0.001);
}

test "overflow: content children shrink, fixed children do not" {
    var b = Box.row(.{ .x = 0, .y = 0, .w = 100, .h = 50 }, .{});
    _ = b.add(.{ .main = .{ .content = 80 } });
    _ = b.add(.{ .main = .{ .fixed = 60 } });
    const r = b.resolve();
    try testing.expectApproxEqAbs(@as(f32, 40), r[0].w, 0.001); // gave up all 40
    try testing.expectApproxEqAbs(@as(f32, 60), r[1].w, 0.001);
}

test "overflow: shrinking stops at min_main and the box overflows honestly" {
    var b = Box.row(.{ .x = 0, .y = 0, .w = 100, .h = 50 }, .{});
    _ = b.add(.{ .main = .{ .content = 80 }, .min_main = 60 });
    _ = b.add(.{ .main = .{ .fixed = 60 } });
    const r = b.resolve();
    try testing.expectApproxEqAbs(@as(f32, 60), r[0].w, 0.001);
    try testing.expectApproxEqAbs(@as(f32, 120), b.used_main, 0.001); // overflows, and says so
}

test "the real settings row: text grows, control never shrinks" {
    // .settings-row { display:flex; align-items:center; gap:24px;
    //                 padding:16px 18px }
    // .settings-row-text { flex:1; min-width:0 } .settings-row-control { flex-shrink:0 }
    var b = Box.row(.{ .x = 0, .y = 0, .w = 640, .h = 69 }, .{
        .padding = .xy(16, 18),
        .gap = 24,
        .cross = .center,
    });
    const text = b.add(.{ .main = .{ .grow = 1 } });
    const control = b.add(.{ .main = .{ .fixed = 40 }, .cross = 23 });
    const r = b.resolve();
    try expectRect(r[text], 18, 16, 540, 37); // 640 - 36 pad - 24 gap - 40
    try expectRect(r[control], 582, 23, 40, 23); // centered in the 37px content box
}

test "nesting: a column inside a resolved row rect" {
    var outer = Box.row(test_bounds, .{ .padding = .all(10), .gap = 10 });
    const left = outer.add(.{ .main = .{ .grow = 1 } });
    _ = outer.add(.{ .main = .{ .fixed = 80 } });
    const outer_rects = outer.resolve();

    var inner = Box.column(outer_rects[left], .{ .gap = 6 });
    _ = inner.add(.{ .main = .{ .content = 18 } });
    _ = inner.add(.{ .main = .{ .content = 16 } });
    const r = inner.resolve();
    try expectRect(r[0], 10, 10, 290, 18); // 400 - 20 pad - 10 gap - 80
    try expectRect(r[1], 10, 34, 290, 16);
}
