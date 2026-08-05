//------------------------------------------------------------------------------
//  ax_bridge.zig — the macOS accessibility bridge, objc half (Stage 6).
//
//  The thin applier for ax.zig's diff: it owns a retained map of
//  NSAccessibilityElement objects keyed by widget ID, creates one on appear,
//  mutates it on update, tears it down on disappear, and posts notifications
//  only when the diff says something really changed. All policy (what exists,
//  what changed) lives in the pure-Zig projection; this file is deliberately
//  nothing but Objective-C plumbing.
//
//  This is the one place the lab opens the objc-interop box that decision 4.1
//  bought it out of, and the scope is exactly Part II 11.1's: runtime calls
//  serve accessibility only — the window, events, and GPU stay sokol's. The
//  msgSend bindings are hand-rolled after reading mitchellh/zig-objc for the
//  calling conventions (read, not imported; the one-dependency posture
//  holds). arm64-only by construction: on arm64 objc_msgSend is the single
//  entry point for every return type (no _stret/_fpret variants exist), so
//  casting it to the exact target signature is the whole convention. The
//  file is compiled only on macOS (see main.zig's comptime gate); an x86_64
//  mac would need the variant dance zig-objc implements — noted, not built.
//
//  Memory discipline: nothing here relies on an autorelease pool being in
//  place (sokol's frame callback makes no promise of one). Every objc object
//  this file creates is alloc/init'd (+1), handed to a retaining setter, and
//  released immediately or held in the element map until disappear. The
//  handful of constant NSStrings (roles, notification names) are created
//  once and retained for the process lifetime.
//
//  Reads never touch the render path: VoiceOver queries answer from the
//  retained elements' stored properties on the main run loop, no frame is
//  marked dirty, and an idle window with the VO cursor parked on it still
//  presents 0. The only path back into the UI is an explicit user *action*
//  (accessibilityPerformPress/Pick), which is forwarded as synthetic input
//  and dirties a frame exactly the way a mouse click does.
//------------------------------------------------------------------------------
const std = @import("std");
const ax = @import("ax.zig");
const draw = @import("draw.zig");

// -- objc runtime bindings ----------------------------------------------------

const Id = ?*anyopaque;
const Sel = ?*anyopaque;
const Class = ?*anyopaque;
const Imp = *const anyopaque;
const Ivar = ?*anyopaque;

extern fn objc_getClass(name: [*:0]const u8) Class;
extern fn sel_registerName(name: [*:0]const u8) Sel;
extern fn objc_msgSend() void;
extern fn objc_allocateClassPair(superclass: Class, name: [*:0]const u8, extra_bytes: usize) Class;
extern fn objc_registerClassPair(cls: Class) void;
extern fn class_addMethod(cls: Class, sel: Sel, imp: Imp, types: [*:0]const u8) bool;
extern fn class_addIvar(cls: Class, name: [*:0]const u8, size: usize, alignment: u8, types: [*:0]const u8) bool;
extern fn class_getInstanceVariable(cls: Class, name: [*:0]const u8) Ivar;
extern fn ivar_getOffset(ivar: Ivar) isize;

/// AppKit's C entry point for AX notifications (linked via sokol's Cocoa
/// dependency). Takes the element and a notification-name NSString.
extern fn NSAccessibilityPostNotification(element: Id, notification: Id) void;

const NSRect = extern struct { x: f64, y: f64, w: f64, h: f64 };

/// Cast objc_msgSend to the target signature and call it — the entire arm64
/// calling convention. `Fn` must spell out the exact C signature including
/// the receiver and selector slots.
inline fn send(comptime Fn: type, receiver: Id, sel: Sel, args: anytype) @typeInfo(Fn).@"fn".return_type.? {
    const f: *const Fn = @ptrCast(&objc_msgSend);
    return @call(.auto, f, .{ receiver, sel } ++ args);
}

const FnId = fn (Id, Sel) callconv(.c) Id;
const FnVoid = fn (Id, Sel) callconv(.c) void;
const FnVoidId = fn (Id, Sel, Id) callconv(.c) void;
const FnVoidBool = fn (Id, Sel, bool) callconv(.c) void;
const FnVoidRect = fn (Id, Sel, NSRect) callconv(.c) void;
const FnIdCStr = fn (Id, Sel, [*:0]const u8) callconv(.c) Id;
const FnIdInt = fn (Id, Sel, c_int) callconv(.c) Id;
const FnIdArray = fn (Id, Sel, [*]const Id, c_ulong) callconv(.c) Id;

// Selectors, registered once at attach.
const sels = struct {
    var alloc: Sel = null;
    var init: Sel = null;
    var release: Sel = null;
    var get_content_view: Sel = null;
    var init_utf8: Sel = null;
    var init_int: Sel = null;
    var init_array: Sel = null;
    var set_role: Sel = null;
    var set_label: Sel = null;
    var set_value: Sel = null;
    var set_enabled: Sel = null;
    var set_parent: Sel = null;
    var set_frame_in_parent: Sel = null;
    var set_children: Sel = null;

    fn register() void {
        alloc = sel_registerName("alloc");
        init = sel_registerName("init");
        release = sel_registerName("release");
        get_content_view = sel_registerName("contentView");
        init_utf8 = sel_registerName("initWithUTF8String:");
        init_int = sel_registerName("initWithInt:");
        init_array = sel_registerName("initWithObjects:count:");
        set_role = sel_registerName("setAccessibilityRole:");
        set_label = sel_registerName("setAccessibilityLabel:");
        set_value = sel_registerName("setAccessibilityValue:");
        set_enabled = sel_registerName("setAccessibilityEnabled:");
        set_parent = sel_registerName("setAccessibilityParent:");
        set_frame_in_parent = sel_registerName("setAccessibilityFrameInParentSpace:");
        set_children = sel_registerName("setAccessibilityChildren:");
    }
};

// Constant NSStrings — the AX wire strings the roles and notifications map
// to. Created once, retained forever (alloc/init is +1 and nothing releases
// them, which for process-lifetime constants is the correct leak).
const strings = struct {
    var ns_string_class: Class = null;
    var ns_number_class: Class = null;
    var ns_array_class: Class = null;
    var role_button: Id = null;
    var role_checkbox: Id = null;
    var role_radio_group: Id = null;
    var role_radio_button: Id = null;
    var role_static_text: Id = null;
    var notif_value_changed: Id = null;
    var notif_layout_changed: Id = null;
    var notif_destroyed: Id = null;

    fn make(text: [*:0]const u8) Id {
        const obj = send(FnId, @constCast(ns_string_class), sels.alloc, .{});
        return send(FnIdCStr, obj, sels.init_utf8, .{text});
    }

    fn register() void {
        ns_string_class = objc_getClass("NSString");
        ns_number_class = objc_getClass("NSNumber");
        ns_array_class = objc_getClass("NSArray");
        role_button = make("AXButton");
        role_checkbox = make("AXCheckBox");
        role_radio_group = make("AXRadioGroup");
        role_radio_button = make("AXRadioButton");
        role_static_text = make("AXStaticText");
        notif_value_changed = make("AXValueChanged");
        notif_layout_changed = make("AXLayoutChanged");
        notif_destroyed = make("AXUIElementDestroyed");
    }

    fn forRole(role: ax.Role) Id {
        return switch (role) {
            .button => role_button,
            .checkbox => role_checkbox,
            .radio_group => role_radio_group,
            .radio_button => role_radio_button,
            .static_text => role_static_text,
        };
    }
};

// -- the runtime subclass -----------------------------------------------------
//
//  One class, created at attach: an NSAccessibilityElement subclass carrying
//  the widget ID in an ivar, overriding the press/pick actions to forward
//  that ID as synthetic input. The ivar is read through its registered
//  offset — the supported way to reach a runtime-added ivar without
//  object_getInstanceVariable's type restrictions.

var element_class: Class = null;
var widget_id_offset: usize = 0;

/// Set by main before attach: where a VoiceOver activation lands. The
/// callback marks the frame dirty and stores the ID for the next Input
/// snapshot — the bridge itself never touches UI state.
pub var on_activate: ?*const fn (widget_id: u64) void = null;

fn widgetIdOf(obj: Id) u64 {
    const base: usize = @intFromPtr(obj.?);
    const ptr: *const u64 = @ptrFromInt(base + widget_id_offset);
    return ptr.*;
}

fn setWidgetId(obj: Id, wid: u64) void {
    const base: usize = @intFromPtr(obj.?);
    const ptr: *u64 = @ptrFromInt(base + widget_id_offset);
    ptr.* = wid;
}

fn performPressImp(self_: Id, _: Sel) callconv(.c) bool {
    if (on_activate) |cb| cb(widgetIdOf(self_));
    return true;
}

// VoiceOver sends Press to buttons and checkboxes and Pick to menu-ish
// items; some radio-button paths use Pick. Both mean "the user activated
// this", and both take the identical route a Space press takes.
fn performPickImp(self_: Id, _: Sel) callconv(.c) bool {
    if (on_activate) |cb| cb(widgetIdOf(self_));
    return true;
}

fn registerElementClass() void {
    const superclass = objc_getClass("NSAccessibilityElement");
    const cls = objc_allocateClassPair(superclass, "ZigUIAXElement", 0);
    std.debug.assert(cls != null);
    // u64 ivar for the widget identity; "Q" is the objc type encoding for
    // unsigned long long, alignment 2^3.
    _ = class_addIvar(cls, "zigWidgetId", @sizeOf(u64), 3, "Q");
    // "B@:" — BOOL return (C bool on arm64), receiver, selector.
    _ = class_addMethod(cls, sel_registerName("accessibilityPerformPress"), @ptrCast(&performPressImp), "B@:");
    _ = class_addMethod(cls, sel_registerName("accessibilityPerformPick"), @ptrCast(&performPickImp), "B@:");
    objc_registerClassPair(cls);
    element_class = cls;
    widget_id_offset = @intCast(ivar_getOffset(class_getInstanceVariable(cls, "zigWidgetId")));
}

// -- the retained element map -------------------------------------------------

const Entry = struct {
    id: u64,
    parent: u64,
    element: Id,
    rect: draw.Rect, // logical px, top-left — kept for child-frame math
};

var entries: [ax.max_nodes]Entry = undefined;
var entries_len: usize = 0;
var content_view: Id = null;
var attached = false;

fn findEntry(id: u64) ?*Entry {
    for (entries[0..entries_len]) |*e| {
        if (e.id == id) return e;
    }
    return null;
}

// -- attach + apply -----------------------------------------------------------

/// One-time setup: resolve selectors, intern the constant strings, register
/// the subclass, and take the content view from sokol's window. Called once
/// from init on macOS; harmless no-op if the window is somehow absent.
pub fn attach(ns_window: ?*const anyopaque) void {
    if (attached or ns_window == null) return;
    sels.register();
    strings.register();
    registerElementClass();
    content_view = send(FnId, @constCast(ns_window), sels.get_content_view, .{});
    attached = content_view != null;
}

/// Apply one frame's diff to the retained tree. `view_h` is the content
/// view's logical-px height for the y-flip (AppKit view space is y-up;
/// widget rects are y-down). Called only on frames that actually rendered —
/// an idle window never gets here, which is half of the "AX never dirties a
/// frame" guarantee (the other half being that nothing in this file writes
/// any UI state).
pub fn apply(ops: *const ax.OpList, view_h: f32) void {
    if (!attached) return;
    if (ops.len == 0 and !ops.order_changed) return;
    current_view_h = view_h;

    var any_rect_changed = false;

    for (ops.slice()) |op| switch (op) {
        .appear => |node| {
            const obj = send(FnId, send(FnId, @constCast(element_class), sels.alloc, .{}), sels.init, .{});
            setWidgetId(obj, node.id);
            send(FnVoidId, obj, sels.set_role, .{strings.forRole(node.role)});
            setLabel(obj, node.label);
            if (node.value != ax.no_value) setValue(obj, node.value);
            send(FnVoidBool, obj, sels.set_enabled, .{!node.disabled});
            setParentAndFrame(obj, node);
            std.debug.assert(entries_len < entries.len);
            entries[entries_len] = .{ .id = node.id, .parent = node.parent, .element = obj, .rect = node.rect };
            entries_len += 1;
        },
        .update => |up| {
            const e = findEntry(up.node.id) orelse continue;
            if (up.changed.label) setLabel(e.element, up.node.label);
            if (up.changed.value) {
                setValue(e.element, up.node.value);
                NSAccessibilityPostNotification(e.element, strings.notif_value_changed);
            }
            if (up.changed.disabled) send(FnVoidBool, e.element, sels.set_enabled, .{!up.node.disabled});
            if (up.changed.rect) {
                e.rect = up.node.rect;
                setParentAndFrame(e.element, up.node);
                any_rect_changed = true;
            }
        },
        .disappear => |node| {
            const e = findEntry(node.id) orelse continue;
            NSAccessibilityPostNotification(e.element, strings.notif_destroyed);
            // Unhook before releasing our +1. The old children NSArrays still
            // retain the element until rebuildChildren swaps them below, so
            // nothing dangles mid-apply; clearing the parent breaks any
            // group <-> child retain cycle at teardown.
            send(FnVoidId, e.element, sels.set_parent, .{null});
            send(FnVoid, e.element, sels.release, .{});
            const idx = (@intFromPtr(e) - @intFromPtr(&entries)) / @sizeOf(Entry);
            std.mem.copyForwards(Entry, entries[idx .. entries_len - 1], entries[idx + 1 .. entries_len]);
            entries_len -= 1;
        },
    };

    // Membership or order changed: rebuild the children arrays (their order
    // is VoiceOver's reading order) — the view's from the top-level entries,
    // each group's from its children — and say the layout changed, once.
    // A pure rect change (a window resize reflowing the scene) is also a
    // layout change, posted once per apply, not per element.
    if (ops.order_changed) rebuildChildren();
    if (ops.order_changed or any_rect_changed) {
        NSAccessibilityPostNotification(content_view, strings.notif_layout_changed);
    }
}

/// How many elements the bridge currently retains — for the HUD/log only.
pub fn elementCount() usize {
    return entries_len;
}

// -- property plumbing --------------------------------------------------------

fn setLabel(obj: Id, label: []const u8) void {
    var buf: [256]u8 = undefined;
    const z = std.fmt.bufPrintZ(&buf, "{s}", .{label}) catch return;
    const s = send(FnIdCStr, send(FnId, @constCast(strings.ns_string_class), sels.alloc, .{}), sels.init_utf8, .{z.ptr});
    send(FnVoidId, obj, sels.set_label, .{s}); // the label property copies
    send(FnVoid, s, sels.release, .{});
}

fn setValue(obj: Id, value: i32) void {
    const num = send(FnIdInt, send(FnId, @constCast(strings.ns_number_class), sels.alloc, .{}), sels.init_int, .{@as(c_int, value)});
    send(FnVoidId, obj, sels.set_value, .{num});
    send(FnVoid, num, sels.release, .{});
}

/// Parent linkage + the frame in the parent's coordinate space. Top-level
/// elements parent to the content view (frame in view space, y flipped);
/// radio buttons parent to their group element (frame relative to the
/// group's rect, y flipped within it). Because frames are parent-relative,
/// a window move costs nothing — AppKit re-derives screen coordinates on
/// demand from the parent chain.
fn setParentAndFrame(obj: Id, node: ax.Node) void {
    if (node.parent == 0) {
        send(FnVoidId, obj, sels.set_parent, .{content_view});
        const frame: NSRect = .{
            .x = node.rect.x,
            .y = current_view_h - (node.rect.y + node.rect.h),
            .w = node.rect.w,
            .h = node.rect.h,
        };
        send(FnVoidRect, obj, sels.set_frame_in_parent, .{frame});
    } else if (findEntry(node.parent)) |parent_entry| {
        send(FnVoidId, obj, sels.set_parent, .{parent_entry.element});
        const pr = parent_entry.rect;
        const frame: NSRect = .{
            .x = node.rect.x - pr.x,
            .y = (pr.y + pr.h) - (node.rect.y + node.rect.h),
            .w = node.rect.w,
            .h = node.rect.h,
        };
        send(FnVoidRect, obj, sels.set_frame_in_parent, .{frame});
    }
}

// The view height for the y-flip, stashed at the top of apply() rather than
// threaded through every setter signature.
var current_view_h: f32 = 0;

fn rebuildChildren() void {
    var top: [ax.max_nodes]Id = undefined;
    var top_len: usize = 0;
    for (entries[0..entries_len]) |e| {
        if (e.parent == 0) {
            top[top_len] = e.element;
            top_len += 1;
        }
    }
    setChildren(content_view, top[0..top_len]);

    // Each group's children, in registration order.
    for (entries[0..entries_len]) |group| {
        if (group.parent != 0) continue;
        var kids: [ax.max_nodes]Id = undefined;
        var kids_len: usize = 0;
        for (entries[0..entries_len]) |e| {
            if (e.parent == group.id) {
                kids[kids_len] = e.element;
                kids_len += 1;
            }
        }
        if (kids_len > 0) setChildren(group.element, kids[0..kids_len]);
    }
}

fn setChildren(parent: Id, kids: []const Id) void {
    const arr = send(
        FnIdArray,
        send(FnId, @constCast(strings.ns_array_class), sels.alloc, .{}),
        sels.init_array,
        .{ kids.ptr, @as(c_ulong, kids.len) },
    );
    send(FnVoidId, parent, sels.set_children, .{arr}); // the property copies
    send(FnVoid, arr, sels.release, .{});
}
