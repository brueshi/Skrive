//------------------------------------------------------------------------------
//  context.zig — the immediate-mode identity and input core (Stage 3).
//
//  There are no widget objects. Every frame, application code *calls* widget
//  functions, and the only state that survives between frames is which ID is
//  hot (pointer over it), active (mouse held down on it), and focused
//  (receiving keyboard). IDs are 64-bit hashes of a label plus an optional
//  caller-supplied discriminator; 0 is reserved for "none".
//
//  The three-state scheme is Casey Muratori's (used by Dear ImGui and dvui):
//    hot    — the pointer is over it this frame
//    active — the mouse went down over it and has not been released
//    focus  — the keyboard target; Tab moves it in draw order
//
//  Two design choices worth stating, both in service of the lab's standing
//  frame-on-demand requirement (idle = 0 presents):
//
//  1. Hover and the press/release machine read *this frame's* hit test, not a
//     value carried from last frame. A mouse-move event marks the frame dirty
//     (main.zig), the frame re-runs, and the widget under the new pointer
//     position renders hovered in that same frame. Nothing is scheduled on a
//     timer, so a still pointer produces no repaint — hover appears and holds
//     without spinning the GPU. The known cost: single-pass hit testing cannot
//     arbitrate two *overlapping* interactive widgets within one frame (both
//     would read hit=true). The lab's scenes never stack interactive widgets;
//     hot_id is still accumulated last-drawn-wins for the cursor and as the
//     seam where real overlap arbitration (popovers/menus — explicit Stage 3
//     non-goals) would plug in.
//
//  2. Tab is resolved in begin() against the *previous* frame's focusable
//     list. Because the scene is stable frame to frame, that list equals this
//     frame's, so the focus ring lands on the new widget in the same frame as
//     the Tab keypress — no one-frame lag, no nudge repaint.
//------------------------------------------------------------------------------
const std = @import("std");
const sapp = @import("sokol").app;
const draw = @import("draw.zig");
const anim = @import("anim.zig");
const ax = @import("ax.zig");

/// The per-frame input snapshot main.zig hands to begin(). Positions are
/// logical px (sokol reports mouse in framebuffer px; main divides by the DPI
/// scale so hit tests match the logical-px rects widgets draw in). `mouse_down`
/// is a level (button currently held); `pressed`/`released`/`tab`/`activate`
/// are edges the owner sets on the triggering event and clears once the frame
/// that renders has consumed them.
pub const Input = struct {
    mouse: [2]f32 = .{ -1, -1 }, // offscreen until the first mouse event
    mouse_down: bool = false,
    pressed: bool = false, // left button went down this frame
    released: bool = false, // left button came up this frame
    tab: bool = false, // Tab pressed this frame
    shift: bool = false, // Shift held (with Tab = focus backward)
    activate: bool = false, // Space/Enter pressed this frame
    // Directional selection within a focused widget (Left/Right today; named
    // for the axis-neutral role so a vertical list could reuse them). Stage 4
    // added these for the segmented control — see the design-smell note on
    // Interact.focusable below.
    nav_prev: bool = false,
    nav_next: bool = false,
    // Stage 6: an assistive-tech activation, by widget identity. A VoiceOver
    // press arrives from the AX bridge as this edge, and interact() fires the
    // matching widget through the identical machinery a Space press uses —
    // synthetic input, not a parallel code path. Unlike Space it does not
    // require focus: the AX cursor is its own point of regard, and moving
    // keyboard focus under it would fight the user. 0 = none.
    ax_activate_id: u64 = 0,
};

/// What a widget learns from a single interact() call. `hovered` and `pressed`
/// are the mutually-exclusive visual states (never both); `focused` is true
/// only when focus arrived via keyboard, matching :focus-visible — a mouse
/// click focuses the control (so Space/Enter work) but shows no ring.
/// `has_focus` is the underlying fact regardless of the ring: a widget that
/// reads arrow keys needs to know it is the keyboard target even when it was
/// focused by a click.
pub const Interaction = struct {
    hovered: bool = false,
    pressed: bool = false,
    focused: bool = false,
    has_focus: bool = false,
    fired: bool = false,
};

/// Per-call interaction options.
///
/// `focusable = false` is Stage 4's one addition to the primitive, and it is
/// worth naming as the design smell the plan asked to watch for. A segmented
/// control is a radiogroup: it is *one* Tab stop whose options are selected
/// with arrow keys, but each option still needs its own hit test, hover, and
/// press. Stage 3's interact() fused "is a keyboard target" with "is
/// interactive", which cannot express that. Rather than let the widget reach
/// around the primitive (hand-rolling its own hit test, or registering a fake
/// ID), the distinction moved into the primitive itself: the group takes the
/// Tab stop, its options interact with focusable = false. A non-focusable
/// widget also does not steal focus on press, which is what keeps a click on
/// an option leaving focus on the group.
pub const Interact = struct {
    disabled: bool = false,
    focusable: bool = true,
};

const max_focusables = 64;

pub const Context = struct {
    input: Input = .{},
    hot_id: u64 = 0, // accumulated this frame, last-drawn-wins; drives cursor
    active_id: u64 = 0,
    focus_id: u64 = 0,
    focus_ring_visible: bool = false,

    // Focus order = draw (call) order. `focusables` is last frame's list, used
    // to resolve Tab at begin(); `next` fills during this frame and is swapped
    // in at end().
    focusables: [max_focusables]u64 = undefined,
    focusables_len: usize = 0,
    next: [max_focusables]u64 = undefined,
    next_len: usize = 0,

    /// Per-widget animation state (Stage 4). Lives here because it is keyed by
    /// widget identity and has the same lifetime as hot/active/focus; see
    /// anim.zig for why it is a separate file all the same.
    anim: anim.Store = .{},

    // The Stage 6 widening of the registration: alongside the focusable list,
    // widgets declare what they *are* — role, label, value, rect — and this
    // frame's declarations become the AX projection's input (see ax.zig).
    // Rebuilt every frame like the focusables; the diff against the retained
    // tree happens outside the Context, in the projection.
    ax_nodes: [ax.max_nodes]ax.Node = undefined,
    ax_len: usize = 0,

    /// 64-bit hash of label + discriminator. The discriminator disambiguates
    /// repeated labels (two "OK" buttons). 0 is remapped to 1 so a real ID
    /// never collides with the "none" sentinel.
    pub fn id(label: []const u8, disc: u64) u64 {
        var h = std.hash.Wyhash.init(0x2026_5c17_1de5_a1b0);
        h.update(label);
        h.update(std.mem.asBytes(&disc));
        const v = h.final();
        return if (v == 0) 1 else v;
    }

    /// Frame start. `dt` is the wall time since the last *rendered* frame, in
    /// seconds — under frame-on-demand that is not the display interval, and
    /// the animation store is written to expect exactly that.
    pub fn begin(self: *Context, input: Input, dt: f32) void {
        self.input = input;
        self.hot_id = 0;
        self.next_len = 0;
        self.ax_len = 0;
        self.anim.tickGeneration();
        self.anim.advance(dt);
        if (input.tab and self.focusables_len > 0) {
            self.focus_id = self.tabTarget(input.shift);
            self.focus_ring_visible = true;
        }
    }

    fn tabTarget(self: *const Context, backward: bool) u64 {
        const n = self.focusables_len;
        var cur: ?usize = null;
        for (self.focusables[0..n], 0..) |fid, i| {
            if (fid == self.focus_id) {
                cur = i;
                break;
            }
        }
        // No current focus in the list: forward starts at the first focusable,
        // backward at the last.
        const i = cur orelse return if (backward) self.focusables[n - 1] else self.focusables[0];
        if (backward) return self.focusables[if (i == 0) n - 1 else i - 1];
        return self.focusables[if (i + 1 >= n) 0 else i + 1];
    }

    /// The one interaction primitive every widget routes through: register for
    /// Tab order, hit-test, run the canonical press/release state machine, and
    /// report the visual + fired result. `rect` is the widget's logical-px hit
    /// area. A disabled widget is inert and unfocusable but still occupies its
    /// space.
    pub fn interact(self: *Context, wid: u64, rect: draw.Rect, opts: Interact) Interaction {
        const disabled = opts.disabled;
        if (!disabled and opts.focusable and self.next_len < max_focusables) {
            self.next[self.next_len] = wid;
            self.next_len += 1;
        }
        const hit = !disabled and pointIn(self.input.mouse, rect);
        if (hit) self.hot_id = wid; // last-drawn-wins

        var fired = false;
        if (!disabled) {
            // Press and release are checked without an else between them, so a
            // press and release landing in the same frame (a very fast click,
            // or two events arriving before one repaint) still fires.
            if (hit and self.input.pressed) {
                self.active_id = wid;
                // A non-focusable part (a segmented option) must not take
                // focus off the group it belongs to.
                if (opts.focusable) {
                    self.focus_id = wid;
                    self.focus_ring_visible = false; // mouse focus shows no ring
                }
            }
            if (self.active_id == wid and self.input.released) {
                if (hit) fired = true; // release-inside fires; release-outside cancels
                self.active_id = 0; // a release always ends the active state
            }
            if (opts.focusable and self.focus_id == wid and self.input.activate) {
                fired = true; // Space/Enter on the focused widget
            }
            if (self.input.ax_activate_id == wid) {
                fired = true; // a VoiceOver press, routed here as synthetic input
            }
        }

        return .{
            // Pressing on the widget (or holding and dragging back over it)
            // shows the pressed look; hover shows only when nothing is held.
            .pressed = self.active_id == wid and hit,
            .hovered = hit and self.active_id == 0,
            .focused = self.focus_id == wid and self.focus_ring_visible,
            .has_focus = !disabled and opts.focusable and self.focus_id == wid,
            .fired = fired,
        };
    }

    /// Declare an accessible element for this frame. Called by widgets right
    /// next to their interact() — the same per-frame registration discipline
    /// as the focusable list, widened to say what the widget is. Order of
    /// registration is draw order, which becomes VoiceOver's reading order.
    /// Over-capacity registrations are dropped (assert in debug): the cap is
    /// shared with max_focusables and no lab scene approaches it.
    pub fn axRegister(self: *Context, node: ax.Node) void {
        std.debug.assert(self.ax_len < ax.max_nodes);
        if (self.ax_len >= ax.max_nodes) return;
        self.ax_nodes[self.ax_len] = node;
        self.ax_len += 1;
    }

    /// This frame's AX declarations, for the projection to diff.
    pub fn axNodes(self: *const Context) []const ax.Node {
        return self.ax_nodes[0..self.ax_len];
    }

    /// Swap in this frame's focusable list and report the cursor the platform
    /// should show — a pointing hand over any interactive widget. Returning the
    /// decision instead of calling sokol keeps side effects at the edge (main
    /// applies it) and keeps this whole file unit-testable without a live GPU.
    pub fn end(self: *Context) sapp.MouseCursor {
        @memcpy(self.focusables[0..self.next_len], self.next[0..self.next_len]);
        self.focusables_len = self.next_len;
        return if (self.hot_id != 0) .POINTING_HAND else .DEFAULT;
    }
};

fn pointIn(p: [2]f32, r: draw.Rect) bool {
    return p[0] >= r.x and p[0] <= r.x + r.w and p[1] >= r.y and p[1] <= r.y + r.h;
}

//------------------------------------------------------------------------------
//  Tests — the state machine is the heart of Stage 3, and the lab's window is
//  driven by a person, so the correctness claims (fire on release-inside,
//  cancel on release-outside, focus order, keyboard activation) are pinned here
//  where they can be checked deterministically without a GPU. end() makes no
//  sokol call, so the whole file runs headless under `zig build test`.
//------------------------------------------------------------------------------
const testing = std.testing;
const box: draw.Rect = .{ .x = 0, .y = 0, .w = 100, .h = 30 };
const inside: [2]f32 = .{ 50, 15 };
const outside: [2]f32 = .{ 300, 15 };

test "hover sets hovered + hot, fires nothing" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside }, 0);
    const it = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(it.hovered and !it.pressed and !it.fired);
    try testing.expectEqual(id, ctx.hot_id);
}

test "click inside: press arms, release fires" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside, .mouse_down = true, .pressed = true }, 0);
    const down = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(!down.fired and down.pressed);
    try testing.expectEqual(id, ctx.active_id);

    ctx.begin(.{ .mouse = inside, .released = true }, 0);
    const up = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(up.fired);
    try testing.expectEqual(@as(u64, 0), ctx.active_id);
}

test "release outside cancels" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside, .mouse_down = true, .pressed = true }, 0);
    _ = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expectEqual(id, ctx.active_id);

    ctx.begin(.{ .mouse = outside, .released = true }, 0);
    const up = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(!up.fired);
    try testing.expectEqual(@as(u64, 0), ctx.active_id);
}

test "drag off then back on still fires (armed across frames)" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside, .mouse_down = true, .pressed = true }, 0);
    _ = ctx.interact(id, box, .{});
    _ = ctx.end();
    // held, dragged outside: still active, not pressed-look, no fire
    ctx.begin(.{ .mouse = outside, .mouse_down = true }, 0);
    const off = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(!off.pressed and !off.fired);
    try testing.expectEqual(id, ctx.active_id);
    // dragged back and released inside: fires
    ctx.begin(.{ .mouse = inside, .released = true }, 0);
    const up = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(up.fired);
}

test "press and release in one frame fires" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside, .pressed = true, .released = true }, 0);
    const it = ctx.interact(id, box, .{});
    _ = ctx.end();
    try testing.expect(it.fired);
    try testing.expectEqual(@as(u64, 0), ctx.active_id);
}

test "disabled is inert and unfocusable" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .mouse = inside, .pressed = true }, 0);
    const it = ctx.interact(id, box, .{ .disabled = true });
    _ = ctx.end();
    try testing.expect(!it.hovered and !it.pressed and !it.fired);
    try testing.expectEqual(@as(u64, 0), ctx.active_id);
    try testing.expectEqual(@as(u64, 0), ctx.hot_id);
}

const test_ids = [_]u64{ Context.id("a", 0), Context.id("b", 0), Context.id("c", 0) };

fn runFrame(ctx: *Context, input: Input, ids: []const u64) void {
    ctx.begin(input, 0);
    var x: f32 = 0;
    for (ids) |wid| {
        _ = ctx.interact(wid, .{ .x = x, .y = 0, .w = 40, .h = 20 }, .{});
        x += 50;
    }
    _ = ctx.end();
}

test "Tab walks focus in draw order and wraps both ways" {
    var ctx: Context = .{};
    const a = test_ids[0];
    const b = test_ids[1];
    const c = test_ids[2];
    runFrame(&ctx, .{}, &test_ids); // populate the focusable list
    try testing.expectEqual(@as(u64, 0), ctx.focus_id);

    runFrame(&ctx, .{ .tab = true }, &test_ids); // none -> first
    try testing.expectEqual(a, ctx.focus_id);
    try testing.expect(ctx.focus_ring_visible);
    runFrame(&ctx, .{ .tab = true }, &test_ids);
    try testing.expectEqual(b, ctx.focus_id);
    runFrame(&ctx, .{ .tab = true }, &test_ids);
    try testing.expectEqual(c, ctx.focus_id);
    runFrame(&ctx, .{ .tab = true }, &test_ids); // wrap forward
    try testing.expectEqual(a, ctx.focus_id);
    runFrame(&ctx, .{ .tab = true, .shift = true }, &test_ids); // wrap backward
    try testing.expectEqual(c, ctx.focus_id);
}

test "AX activation is indistinguishable from Space on the focused widget" {
    // Two identical widgets in two contexts: one activated by keyboard focus +
    // Space, one by an AX press. The Interaction result must match — same
    // fired, and neither leaves an armed active state behind.
    const id = Context.id("a", 0);

    var kb: Context = .{};
    kb.begin(.{}, 0);
    _ = kb.interact(id, box, .{});
    _ = kb.end();
    kb.begin(.{ .tab = true }, 0); // focus it
    _ = kb.interact(id, box, .{});
    _ = kb.end();
    kb.begin(.{ .activate = true }, 0); // Space
    const via_space = kb.interact(id, box, .{});
    _ = kb.end();

    var vo: Context = .{};
    vo.begin(.{ .ax_activate_id = id }, 0);
    const via_ax = vo.interact(id, box, .{});
    _ = vo.end();

    try testing.expect(via_space.fired and via_ax.fired);
    try testing.expectEqual(@as(u64, 0), kb.active_id);
    try testing.expectEqual(@as(u64, 0), vo.active_id);
}

test "AX activation needs no focus and does not move it" {
    // The AX cursor is its own point of regard: a VO press on an unfocused
    // widget fires it without stealing keyboard focus.
    var ctx: Context = .{};
    const a = test_ids[0];
    const b = test_ids[1];
    runFrame(&ctx, .{}, &test_ids);
    runFrame(&ctx, .{ .tab = true }, &test_ids); // keyboard focus on a
    try testing.expectEqual(a, ctx.focus_id);

    ctx.begin(.{ .ax_activate_id = b }, 0);
    _ = ctx.interact(a, .{ .x = 0, .y = 0, .w = 40, .h = 20 }, .{});
    const it_b = ctx.interact(b, .{ .x = 50, .y = 0, .w = 40, .h = 20 }, .{});
    _ = ctx.end();
    try testing.expect(it_b.fired);
    try testing.expectEqual(a, ctx.focus_id); // focus did not move
}

test "a disabled widget is inert to AX activation" {
    var ctx: Context = .{};
    const id = Context.id("a", 0);
    ctx.begin(.{ .ax_activate_id = id }, 0);
    const it = ctx.interact(id, box, .{ .disabled = true });
    _ = ctx.end();
    try testing.expect(!it.fired);
}

test "AX activation reaches non-focusable widgets (segmented options)" {
    var ctx: Context = .{};
    const id = Context.id("opt", 0);
    ctx.begin(.{ .ax_activate_id = id }, 0);
    const it = ctx.interact(id, box, .{ .focusable = false });
    _ = ctx.end();
    try testing.expect(it.fired);
}

test "AX registration: draw order in, same order out, cleared each frame" {
    var ctx: Context = .{};
    ctx.begin(.{}, 0);
    ctx.axRegister(.{ .id = 1, .role = .button, .label = "Save", .rect = box });
    ctx.axRegister(.{ .id = 2, .role = .checkbox, .label = "Check spelling", .value = 1, .rect = box });
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 2), ctx.axNodes().len);
    try testing.expectEqual(@as(u64, 1), ctx.axNodes()[0].id);
    try testing.expectEqual(@as(u64, 2), ctx.axNodes()[1].id);

    ctx.begin(.{}, 0); // a new frame starts a fresh registration list
    _ = ctx.end();
    try testing.expectEqual(@as(usize, 0), ctx.axNodes().len);
}

test "mouse focus shows no ring; Space activates the focused widget" {
    var ctx: Context = .{};
    const a = test_ids[0];
    // click focuses without a ring
    ctx.begin(.{ .mouse = .{ 20, 10 }, .pressed = true }, 0);
    _ = ctx.interact(a, .{ .x = 0, .y = 0, .w = 40, .h = 20 }, .{});
    _ = ctx.end();
    try testing.expectEqual(a, ctx.focus_id);
    try testing.expect(!ctx.focus_ring_visible);

    // Space on the focused widget fires
    ctx.begin(.{ .activate = true }, 0);
    const it = ctx.interact(a, .{ .x = 0, .y = 0, .w = 40, .h = 20 }, .{});
    _ = ctx.end();
    try testing.expect(it.fired);
}
