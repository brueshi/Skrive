//------------------------------------------------------------------------------
//  ax.zig — the accessibility projection, pure-Zig half (Stage 6).
//
//  macOS accessibility wants a retained object tree; this UI is immediate-mode
//  and has no widget objects. The bridge between the two is a *projection*:
//  widgets already register themselves with the Context every frame (the
//  focusables list — how Tab order has worked since Stage 3), and Stage 6
//  widens that registration to carry role, label, value, and rect. This file
//  is the projection's data model and its diff: each rendered frame's
//  registrations are compared against the previous frame's, and the delta —
//  appear / update / disappear, with a per-field change mask — is what the
//  objc side (ax_bridge.zig) applies to its retained NSAccessibilityElement
//  map. Create on appear, update on change, remove on disappear, notify only
//  on real diffs.
//
//  Everything in this file is platform-free and runs headless under
//  `zig build test`; no objc type appears anywhere. That split is the
//  verification story: the diff transitions are pinned here
//  deterministically, and the objc side stays a thin applier whose output is
//  verified from outside the process (the AX dump, and VoiceOver itself).
//
//  Frames the projection never sees cost nothing: an idle window renders no
//  frame, so no registration list is produced, no diff runs, and the retained
//  element tree simply persists for VoiceOver to read. AX reads never touch
//  the render path — the standing idle = 0 presents requirement is preserved
//  by construction, not by care.
//------------------------------------------------------------------------------
const std = @import("std");
const draw = @import("draw.zig");

/// The roles the kit needs, named after the AX wire strings they project to.
/// Buttons and icon buttons are AXButton; the toggle is AXCheckBox (a switch
/// whose value flips 0/1, exactly how the shipped aria pattern reads); the
/// segmented control is AXRadioGroup with one AXRadioButton per option; pane
/// titles and row labels/descs are AXStaticText.
pub const Role = enum {
    button,
    checkbox,
    radio_group,
    radio_button,
    static_text,
};

/// No value. Roles that carry none (buttons, groups, static text) use this;
/// checkboxes and radio buttons carry 0/1.
pub const no_value: i32 = -1;

/// One frame's declaration of one accessible element. `label` must point at
/// storage that outlives the projection's retained snapshot — at lab scale
/// every label is a static string (scene copy or an option list), so this
/// holds for free; a UI with genuinely dynamic AX labels would need to copy,
/// and that is a finding, not a feature.
pub const Node = struct {
    id: u64, // widget identity (the same Wyhash the Context uses); never 0
    parent: u64 = 0, // 0 = the window's content view; else a group's id
    role: Role,
    label: []const u8,
    value: i32 = no_value,
    rect: draw.Rect, // logical px, top-left origin (the bridge converts)
    disabled: bool = false,
};

/// Scenes register a handful of controls; 64 matches the Context's focusable
/// cap and leaves room for the static-text rows.
pub const max_nodes = 64;

pub const ChangeMask = struct {
    label: bool = false,
    value: bool = false,
    rect: bool = false,
    disabled: bool = false,

    pub fn any(self: ChangeMask) bool {
        return self.label or self.value or self.rect or self.disabled;
    }
};

pub const Op = union(enum) {
    appear: Node,
    update: struct { node: Node, changed: ChangeMask },
    disappear: Node, // the retained copy, so the applier knows what to tear down
};

pub const OpList = struct {
    ops: [2 * max_nodes]Op = undefined,
    len: usize = 0,
    /// True when membership or order of the id sequence changed — the signal
    /// to rebuild the retained children arrays (child order is what VoiceOver
    /// navigates in) and post a layout-changed notification.
    order_changed: bool = false,

    pub fn slice(self: *const OpList) []const Op {
        return self.ops[0..self.len];
    }

    fn push(self: *OpList, op: Op) void {
        std.debug.assert(self.len < self.ops.len);
        self.ops[self.len] = op;
        self.len += 1;
    }
};

/// The retained half of the diff: last frame's nodes, in registration order.
/// Registration order is draw order, which is the reading order VoiceOver
/// walks — preserving it is not cosmetic.
pub const Projection = struct {
    prev: [max_nodes]Node = undefined,
    prev_len: usize = 0,

    /// Diff this frame's registrations against the retained snapshot and
    /// retain the new one. O(n^2) by id over n <= 64 nodes — a hash map here
    /// would be ceremony (and this runs only on frames that actually render).
    pub fn diff(self: *Projection, cur: []const Node, out: *OpList) void {
        std.debug.assert(cur.len <= max_nodes);
        out.len = 0;
        out.order_changed = cur.len != self.prev_len;

        for (cur, 0..) |node, i| {
            std.debug.assert(node.id != 0);
            if (!out.order_changed and self.prev[i].id != node.id) out.order_changed = true;
            if (findById(self.prev[0..self.prev_len], node.id)) |old| {
                const changed: ChangeMask = .{
                    .label = !std.mem.eql(u8, old.label, node.label),
                    .value = old.value != node.value,
                    .rect = !rectEq(old.rect, node.rect),
                    .disabled = old.disabled != node.disabled,
                };
                if (changed.any()) out.push(.{ .update = .{ .node = node, .changed = changed } });
            } else {
                out.push(.{ .appear = node });
            }
        }
        for (self.prev[0..self.prev_len]) |old| {
            if (findById(cur, old.id) == null) out.push(.{ .disappear = old });
        }

        @memcpy(self.prev[0..cur.len], cur);
        self.prev_len = cur.len;
    }
};

fn findById(nodes: []const Node, id: u64) ?*const Node {
    for (nodes) |*node| {
        if (node.id == id) return node;
    }
    return null;
}

fn rectEq(a: draw.Rect, b: draw.Rect) bool {
    // Exact equality is right here: rects are deterministic layout output,
    // not accumulated floats — the same scene produces bit-identical rects.
    return a.x == b.x and a.y == b.y and a.w == b.w and a.h == b.h;
}

//------------------------------------------------------------------------------
//  Tests — the diff transitions, pinned deterministically. The objc applier is
//  deliberately not in the loop; what these prove is that the projection layer
//  hands it exactly one create per appearance, one update per real change, and
//  one removal per disappearance — never a spurious notification.
//------------------------------------------------------------------------------
const testing = std.testing;

fn n(id: u64, value: i32) Node {
    return .{ .id = id, .role = .checkbox, .label = "Check spelling", .value = value, .rect = .{ .x = 10, .y = 20, .w = 40, .h = 23 } };
}

test "ax diff: first frame is all appears, in order" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    try testing.expectEqual(@as(usize, 2), ops.len);
    try testing.expectEqual(@as(u64, 1), ops.ops[0].appear.id);
    try testing.expectEqual(@as(u64, 2), ops.ops[1].appear.id);
    try testing.expect(ops.order_changed); // 0 -> 2 nodes is a membership change
}

test "ax diff: an identical frame produces no ops and no order change" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    try testing.expectEqual(@as(usize, 0), ops.len);
    try testing.expect(!ops.order_changed);
}

test "ax diff: a value flip is one update with only the value bit set" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{n(1, 0)}, &ops);
    p.diff(&.{n(1, 1)}, &ops);
    try testing.expectEqual(@as(usize, 1), ops.len);
    const up = ops.ops[0].update;
    try testing.expect(up.changed.value);
    try testing.expect(!up.changed.rect and !up.changed.label and !up.changed.disabled);
    try testing.expectEqual(@as(i32, 1), up.node.value);
    try testing.expect(!ops.order_changed);
}

test "ax diff: a moved rect is one update with only the rect bit set" {
    var p: Projection = .{};
    var ops: OpList = .{};
    var a = n(1, 0);
    p.diff(&.{a}, &ops);
    a.rect.y += 5;
    p.diff(&.{a}, &ops);
    try testing.expectEqual(@as(usize, 1), ops.len);
    try testing.expect(ops.ops[0].update.changed.rect);
    try testing.expect(!ops.ops[0].update.changed.value);
}

test "ax diff: a vanished node is a disappear carrying the retained copy" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    p.diff(&.{n(1, 0)}, &ops);
    try testing.expectEqual(@as(usize, 1), ops.len);
    try testing.expectEqual(@as(u64, 2), ops.ops[0].disappear.id);
    try testing.expectEqual(@as(i32, 1), ops.ops[0].disappear.value);
    try testing.expect(ops.order_changed);
}

test "ax diff: reordering the same nodes emits no ops but flags order" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    p.diff(&.{ n(2, 1), n(1, 0) }, &ops);
    try testing.expectEqual(@as(usize, 0), ops.len);
    try testing.expect(ops.order_changed);
}

test "ax diff: scene switch — everything out, new things in" {
    var p: Projection = .{};
    var ops: OpList = .{};
    p.diff(&.{ n(1, 0), n(2, 1) }, &ops);
    p.diff(&.{n(7, no_value)}, &ops);
    try testing.expectEqual(@as(usize, 3), ops.len); // 1 appear + 2 disappears
    try testing.expectEqual(@as(u64, 7), ops.ops[0].appear.id);
    try testing.expect(ops.order_changed);
}
