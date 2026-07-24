//------------------------------------------------------------------------------
//  anim.zig — the per-ID animation store: the first persistent per-widget
//  state in the lab beyond hot/active/focus.
//
//  WHERE THIS LIVES, AND WHY. A Context owns one Store. The state is keyed
//  exactly like widget identity (a 64-bit ID plus a sub-index for widgets that
//  animate more than one thing), it has the same lifetime as hot/active/focus,
//  and every widget already holds the context — so threading a second store
//  through the Painter would have been ceremony for nothing. It gets its own
//  file rather than growing context.zig because it is a genuinely separate
//  concern: context.zig is identity + input, this is identity + time, and the
//  two have no shared invariants.
//
//  THE SHAPE, AND WHY IT IS NOT dvui's. dvui stores a tween — start_val,
//  end_val, start_time, end_time, an easing fn — and deletes it when the clock
//  runs out. That is right for a one-shot (a toast sliding in). It is wrong for
//  a control: retargeting a tween mid-flight either restarts it from the new
//  origin (a visible hitch) or needs the caller to rewrite start_val from the
//  current position by hand. A toggle flicked twice quickly does exactly that,
//  and it must continue from wherever the knob actually is. So an entry here is
//  a *retargetable* value — current, target, and time left — and interpolation
//  is exponential decay toward the target, which has no notion of an origin at
//  all. Flick it back mid-slide and the knob simply turns around.
//
//  THE TRAP THIS MODULE EXISTS TO NOT FALL INTO. The lab's standing
//  requirement is idle = 0 presents, and an animation is the obvious way to
//  break it: mark the frame dirty every frame and you have a permanent max-fps
//  loop (the exact shape of the Stage 2 HUD's once-a-second timer, which would
//  have pinned the app at 1 fps forever). So termination is by *clock*, not by
//  a distance epsilon: a retarget sets `remaining = settle_sec` and the entry
//  snaps to its target the moment that runs out. That guarantees the settle
//  time regardless of the value's units (0..1 for a knob, 0..n for a segment
//  index, pixels for a stretch), and it guarantees `animating()` goes false —
//  an epsilon test on a decay curve is asymptotic and, with unlucky units,
//  never quite finishes. After 150 ms at tau = 22 ms the residual is e^-6.8,
//  about 0.1% of the jump, so the snap is far below a device pixel.
//
//  Frame-rate independence matters here for a mundane reason: this window
//  fluctuates between 60 and 120 Hz depending on whether it is frontmost, so a
//  per-frame `cur += (target - cur) * 0.2` would visibly animate at two
//  different speeds. The exp() form takes dt and does not care.
//------------------------------------------------------------------------------
const std = @import("std");

/// Time constant of the decay. Skrive's own toggle transitions the knob over
/// --skrive-duration-slow (160ms) with --skrive-easing-out (a strong ease-out
/// with a long tail); exponential decay is that same family, and tau = 22ms
/// puts the visible motion in the same place.
pub const tau: f32 = 0.022;

/// Hard settle deadline, per the plan's "~150ms".
pub const settle_sec: f32 = 0.15;

const capacity = 64;

const Entry = struct {
    key: u64,
    cur: f32,
    target: f32,
    remaining: f32, // seconds left before the hard snap; 0 = settled
    touched: u32, // generation of the last value() call, for eviction
};

pub const Store = struct {
    entries: [capacity]Entry = undefined,
    len: usize = 0,
    gen: u32 = 0,

    /// Combine a widget ID with a sub-index so one widget can animate several
    /// things (a toggle animates its knob position and its press stretch).
    /// Golden-ratio mix so sub-keys of different widgets cannot line up.
    pub fn key(wid: u64, sub: u32) u64 {
        return wid ^ (@as(u64, sub) +% 1) *% 0x9E37_79B9_7F4A_7C15;
    }

    /// Read the animated value for `k`, retargeting if `target` changed. The
    /// first sight of a key starts *at* the target: a toggle that opens in the
    /// `on` state must not slide in on the first frame.
    pub fn value(self: *Store, k: u64, target: f32) f32 {
        const e = self.slot(k, target);
        e.touched = self.gen;
        if (e.target != target) {
            e.target = target;
            e.remaining = settle_sec;
        }
        return e.cur;
    }

    /// Step every in-flight entry. Called once at frame start, before widgets
    /// read their values, with the wall time since the last *rendered* frame —
    /// which under frame-on-demand may be a long time. That is fine and in
    /// fact correct: a stale in-flight entry should land, and an entry
    /// retargeted later in this same frame gets its full settle window after
    /// this call has already run.
    pub fn advance(self: *Store, dt: f32) void {
        if (dt <= 0) return;
        const step = 1 - @exp(-dt / tau);
        for (self.entries[0..self.len]) |*e| {
            if (e.remaining <= 0) continue;
            e.remaining -= dt;
            if (e.remaining <= 0) {
                e.remaining = 0;
                e.cur = e.target; // the hard snap that ends the dirty loop
            } else {
                e.cur += (e.target - e.cur) * step;
            }
        }
    }

    /// True while anything is still moving. main() ORs this into the frame's
    /// dirty flag *after* the scene is built, so a widget that retargets
    /// during the build schedules the next frame, and the frame that snaps
    /// schedules nothing.
    pub fn animating(self: *const Store) bool {
        for (self.entries[0..self.len]) |e| {
            if (e.remaining > 0) return true;
        }
        return false;
    }

    /// Bump the eviction generation. Called once per frame from Context.begin.
    pub fn tickGeneration(self: *Store) void {
        self.gen +%= 1;
    }

    pub fn inFlightCount(self: *const Store) usize {
        var n: usize = 0;
        for (self.entries[0..self.len]) |e| {
            if (e.remaining > 0) n += 1;
        }
        return n;
    }

    /// Find or create the entry for a key. Linear scan: at lab scale the table
    /// holds single digits of entries and a scan beats a hash map with no
    /// allocator. When full, the least recently touched entry is recycled —
    /// switching scenes must not be able to wedge the store.
    fn slot(self: *Store, k: u64, initial: f32) *Entry {
        for (self.entries[0..self.len]) |*e| {
            if (e.key == k) return e;
        }
        if (self.len < capacity) {
            self.entries[self.len] = .{ .key = k, .cur = initial, .target = initial, .remaining = 0, .touched = self.gen };
            self.len += 1;
            return &self.entries[self.len - 1];
        }
        var oldest = &self.entries[0];
        for (self.entries[0..self.len]) |*e| {
            if (self.gen -% e.touched > self.gen -% oldest.touched) oldest = e;
        }
        oldest.* = .{ .key = k, .cur = initial, .target = initial, .remaining = 0, .touched = self.gen };
        return oldest;
    }
};

//------------------------------------------------------------------------------
//  Tests. The settle behaviour is the exit criterion ("animates smoothly, then
//  idles at 0 presents"), and its second half — that the dirty-marking
//  actually *ceases* — is the half that is easy to get wrong and impossible to
//  eyeball. Pinned here.
//------------------------------------------------------------------------------
const testing = std.testing;

test "first sight of a key starts at its target, not at zero" {
    var s: Store = .{};
    try testing.expectEqual(@as(f32, 1), s.value(Store.key(7, 0), 1));
    try testing.expect(!s.animating());
}

test "retarget animates, then settles exactly and stops marking dirty" {
    var s: Store = .{};
    const k = Store.key(7, 0);
    _ = s.value(k, 0); // settled at 0
    _ = s.value(k, 1); // retarget
    try testing.expect(s.animating());

    // 120 Hz frames until the store reports settled.
    const dt: f32 = 1.0 / 120.0;
    var elapsed: f32 = 0;
    var last: f32 = 0;
    while (s.animating()) {
        s.advance(dt);
        const v = s.value(k, 1);
        try testing.expect(v >= last); // monotonic: an ease-out never overshoots
        try testing.expect(v <= 1.0001);
        last = v;
        elapsed += dt;
        try testing.expect(elapsed < 0.2); // must not run away
    }
    try testing.expectEqual(@as(f32, 1), last); // lands exactly on target
    try testing.expect(elapsed <= settle_sec + dt); // settles within ~150ms

    // And stays settled: further frames neither move it nor re-dirty.
    s.advance(dt);
    try testing.expect(!s.animating());
    try testing.expectEqual(@as(f32, 1), s.value(k, 1));
}

test "most of the motion happens early (ease-out, not linear)" {
    var s: Store = .{};
    const k = Store.key(7, 0);
    _ = s.value(k, 0);
    _ = s.value(k, 1);
    s.advance(settle_sec / 3); // one third of the way through the clock
    try testing.expect(s.value(k, 1) > 0.85);
}

test "retargeting mid-flight turns around from where it is" {
    var s: Store = .{};
    const k = Store.key(7, 0);
    _ = s.value(k, 0);
    _ = s.value(k, 1);
    s.advance(0.02);
    const mid = s.value(k, 1);
    try testing.expect(mid > 0.05 and mid < 0.95); // genuinely mid-flight

    _ = s.value(k, 0); // flicked back
    s.advance(1.0 / 120.0);
    const after = s.value(k, 0);
    try testing.expect(after < mid and after > 0); // continues from mid, no jump
}

test "sub-keys of one widget are independent, and of different widgets distinct" {
    var s: Store = .{};
    const a = Store.key(7, 0);
    const b = Store.key(7, 1);
    try testing.expect(a != b);
    try testing.expect(Store.key(8, 0) != a);
    _ = s.value(a, 0);
    _ = s.value(b, 0);
    _ = s.value(a, 1);
    s.advance(settle_sec);
    try testing.expectEqual(@as(f32, 1), s.value(a, 1));
    try testing.expectEqual(@as(f32, 0), s.value(b, 0));
}

test "a full store recycles the least recently touched entry" {
    var s: Store = .{};
    var i: u32 = 0;
    while (i < capacity) : (i += 1) {
        _ = s.value(Store.key(1, i), 0);
    }
    try testing.expectEqual(capacity, s.len);
    // Touch everything except key 0 on a newer generation.
    s.tickGeneration();
    i = 1;
    while (i < capacity) : (i += 1) {
        _ = s.value(Store.key(1, i), 0);
    }
    _ = s.value(Store.key(2, 0), 5); // evicts the stale one, does not grow
    try testing.expectEqual(capacity, s.len);
    try testing.expectEqual(@as(f32, 5), s.value(Store.key(2, 0), 5));
}
