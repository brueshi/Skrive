# Zig UI Lab Log

Session log for the hand-drawn-GPU-UI research lab in `labs/zig-ui/` — one
dated entry per session: what was attempted, what worked, what fought back,
exact commit. The full plan (decision record, stage ladder, exit criteria)
lives in `planning/zig-ui-lab.md` (disk-only). Umbrella issue: SKR-233.

---

## 2026-07-07 — Session zero + Stage 0: scaffold, window, render loop, instrumentation

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research` (off `main`).
**Commit:** `fdaccefccaf5774b02890a49af2c1ba0e927026c`

**Toolchain.**
- Zig 0.16.0 (Homebrew `0.16.0_1`), matching `shell-zig/core`'s pin.
- sokol-zig `54776d69dac1650221a84191a07269fc4e1e82cd` — head of the
  `zig-0.16.0` branch. Pin rationale: sokol-zig keeps per-release branches
  (`zig-0.13.0`, `zig-0.14.1`, `zig-0.16.0`, ...) while `master` tracks the
  latest Zig, so the branch named for our exact compiler pin is the
  documented-compatible choice and the place 0.16 fixes would land. Pinned by
  commit hash in `build.zig.zon`, so it cannot move under us either way.
- sokol-shdc: not used (a clear pass needs no custom shader). Noted for
  Stage 1: it arrives automatically as a lazy transitive dependency of
  sokol-zig, so the tool is already fetched under `zig-pkg/`.

**What was built.** `labs/zig-ui/` scaffold (build.zig, build.zig.zon with
`.minimum_zig_version = "0.16.0"`, README, `src/main.zig`); sokol's
clear-color sample compiled and ran first (Metal backend confirmed), then was
replaced by the Stage 0 app: 1200x800 logical high-DPI window titled
"Skrive Zig UI Lab", damage-driven rendering (any event marks the frame
dirty; clean frames skip all GPU work), space toggles continuous mode
(`--continuous` starts in it, so benchmark runs need no keypress), terminal
HUD printing render CPU time and present count at most once per second. No
drawing abstractions, per the stage's non-goals. The plan's `gfx/ ui/ bench/`
subdirectories were not created yet — git does not track empty directories;
they materialize when their first file lands.

**Measurements (macOS daily driver, ReleaseFast unless noted).**
- Device pixel ratio: 2 (2400x1600 framebuffer for the 1200x800 window).
- Idle, on-demand mode, window untouched: **1.1–1.3% CPU** (Debug:
  1.2–1.5%), sampled via `top` over ~16s. GPU is idle by construction — no
  command buffer is encoded and no drawable acquired when clean — and the
  idle run's log shows zero presents while untouched.
- Continuous mode: **114–120 fps (avg ~117) against the 120Hz ProMotion
  display**, frame avg 8.3–9.0ms — holds refresh; the wobble is ProMotion's
  adaptive cadence, not dropped frames. Pass encode + commit costs
  ~130–165us CPU per frame.

**Plan discrepancy, flagged for Joe (plan 4.2 / Stage 0 exit criterion).**
The plan asserts "sokol_app can run frame-on-demand." At this pin it cannot:
there is no public frame-on-demand API — the display-link pause machinery in
`sokol_app.h` is internal and used only for window occlusion, so the frame
callback ticks at display refresh whenever the window is visible. The
faithful implementation inside sokol's public API is what shipped: skip all
GPU work unless dirty. That makes idle GPU genuinely 0%, but idle CPU sits at
~1.1–1.3% (the display link firing into an early-out 120 times a second), not
the ~0% the exit criterion asks for. ReleaseFast vs Debug barely moves it, so
the cost is sokol's per-tick plumbing, not lab code. Options if this matters:
accept it at lab scale (it is a constant, not a scaling cost), carry a small
sokol patch exposing the existing pause internals, or fold it into the
known-possible bespoke Metal platform layer (plan 4.1's graduation path).
Proceeding does not depend on the choice; Stages 1+ are unaffected.

**What fought back.**
- Zig 0.16's Io rework: `std.time.Timer` is gone (clocks now hang off an
  `std.Io` instance). Threading an `Io` through sokol callbacks is
  disproportionate for a HUD, so timing uses `sokol.time` — which is the
  paved sokol path anyway.
- `std.os.argv` is gone too. 0.16's new convention is
  `pub fn main(process: std.process.Init.Minimal)`, which provides an
  allocation-free args iterator on posix. Used that.
- First timing numbers read 1.4–8.7**ms** per "render" — the timed span
  included `sglue.swapchain()`, which blocks in Metal's `nextDrawable` under
  vsync backpressure. Moving acquisition outside the span dropped encode +
  commit to the honest ~150us. Instrumentation lesson worth keeping: never
  time across a swapchain acquire.
- Zig 0.16 extracts package-manager deps into a project-local `zig-pkg/`
  directory (not only the global cache); gitignored alongside `.zig-cache/`
  and `zig-out/`.

**Isolation verified.** Nothing outside `labs/` references the directory
(repo-wide grep; the `labs-*` hits are the old zig-shell release-tag naming),
and `bun run typecheck` passes untouched. `rm -rf labs/` would break nothing.

**Stage 0 exit criteria.** `zig build run` opens the window with the clear
color: pass. Continuous mode holds display refresh: pass. Idle ~0%: pass on
GPU, **near-miss on CPU** (~1.1–1.3%, see discrepancy above). Isolation:
pass.

**Next session (Stage 1).** The rect batcher and the SDF shape shader:
`gfx/batch.zig`, the `sdf_shapes` shader via sokol-shdc (already fetched),
`ui/draw.zig`'s first `rect()`, the 10k-rect stress scene, and the toast
taste test against the shipped reference.
