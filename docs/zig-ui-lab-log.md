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

---

## 2026-07-09 — Stage 1: rect batcher, SDF shape shader, draw API

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
(recreated off `main` — the Stage 0 branch had been merged and deleted).
**Commit:** `01f8bfdd0b0242cf65860679771c1e9ed689c0cf`

**Toolchain.**
- Zig 0.16.0, sokol-zig `54776d6` — both pins unchanged from Stage 0.
- sokol-shdc: prebuilt binary from `floooh/sokol-tools-bin` at
  `87a6914bb5eab83f13b12db6dfd4c1333494d076` (the commit sokol-zig's own
  `build.zig.zon` pins as its `shdc` dependency; the tool has no version
  flag, so that hash is its identity). Wiring is the paved sokol-zig path:
  `build.zig` calls `sokol.shdc.createSourceFile()` with
  `dep_sokol.builder.dependency("shdc")` under an explicit
  `zig build shaders` step, targets `metal_macos` + `hlsl5` (Windows
  smoke test is plan 4.4), and the generated `src/gfx/sdf_shapes.glsl.zig`
  is checked in — ordinary builds never touch the tool.

**What was built.**
- `gfx/batch.zig` — the narrow waist. 52-byte vertex (pos, target rect as
  center+half-size, uv, radius, border-width/sigma, mode flag, two UBYTE4N
  colors), non-indexed 6 verts per quad, one alpha-blended pipeline. Quads
  accumulate in a growable CPU array; one `updateBuffer` per frame (sokol
  allows exactly one per buffer per frame, so capacity is handled by
  growing the GPU buffer at upload time, not by mid-frame flushes —
  `flush()` exists and is the seam where Stage 2's texture-change splits
  land). Upload sits outside the render pass, draw-range replay inside.
- `gfx/sdf_shapes.glsl` — one shader, mode branch per quad. Mode 0:
  rounded-rect SDF, `fwidth`-based smoothstep AA half a device pixel wide,
  border as an inside-the-edge mix toward the border color (CSS mental
  model). Mode 1: Evan Wallace's closed-form Gaussian shadow verbatim —
  polynomial erf along x, four Gaussian samples along y, quad expanded by
  3 sigma. `erf` renamed `erf_approx` (MSL has a builtin `erf`) and the
  article's `step` variable renamed (GLSL builtin) — both defensive.
- `ui/draw.zig` — `rect(r, style)`, style = fill, radius, optional border,
  a *list* of shadows (Skrive's `--skrive-shadow-sheet` is two layers;
  CSS blur-radius = 2 sigma). Shadows push first, painter's order.
- Scenes in `main.zig`: `1` demo (radius/border/shadow/blend ladders),
  `2` toast taste test, `3`/`4` stress large/small, `S` shadows-on-10%.
  HUD grew quad count, draw calls, and split build/upload/encode timings.
- `--bench`: a self-driving schedule (large / large+shadows / small /
  toast / 15s idle) that ignores the keyboard, discards a warmup per
  phase, prints one summary line each, and quits. Exists because stray
  keystrokes contaminated two of the first three runs (see below).

**Measurements (macOS daily driver, ReleaseFast, 1200x800 logical @ 2x).**
- Stress, plan-literal config (10,000 rounded rects sized 16-180 px =
  **99.8x window overdraw**): **1 draw call, frame avg 14.3 ms (~70 fps),
  GPU pinned 100%**. CPU is nowhere in it: build 341 us + upload 80 us +
  encode 47 us. With shadows on 10% of rects (11,033 quads): 23.3 ms.
- Stress, UI-plausible config (same 10,000 quads at 4-48 px = **7.0x
  overdraw**, glyph/chip scale): **1 draw call, 8.36 ms avg — holds the
  120 Hz ProMotion refresh** with GPU at ~60% (~5 ms/frame), total CPU
  ~1 ms. Vertex traffic at 10k quads is ~3.1 MB/frame (52 B x 6 x 10k),
  upload 80-180 us — bandwidth is a non-issue at this scale.
- Toast scene (12 quads): 8.38 ms at 119.3 fps, encode 162 us — the same
  cost as Stage 0's empty pass; the composition is free.
- Idle, on-demand, stress scene on screen: **0 presents in 15 s**, CPU
  0.2-1.0% (`top`), GPU at ambient (~4%, machine in active use). The
  Stage 0 baseline holds with a full scene resident.
- Reading: draw-call count and CPU cost are solved by the batcher;
  **the physical wall is GPU fill rate under alpha blending** (~27 Gpx/s
  of shaded coverage sustained at 100x overdraw). This is exactly why
  GPU UIs manage overdraw (opaque passes, layer culling); a real UI frame
  is single-digit-x, where there is roughly 2x headroom against the 120 Hz
  budget at 10k quads. The exit criterion reads "well under frame budget":
  honest verdict is **pass at UI-plausible overdraw, fail in the
  fill-rate torture config** — recorded as the finding it is rather than
  tuned away.

**Taste test.** `docs/zig-ui-lab/stage1-toast-lab.png` (lab window: left =
shipped `.toast-card` spec — white, radius 16, the two-layer sheet shadow,
no border; right = the plan's variant — warm `#fbf9f4`, 1px `--skrive-rule`
hairline; text greeked as rounded bars, real text is Stage 2) next to
`stage1-toast-web-reference.png` (the shipped CSS rendered verbatim in
Chromium at dpr 2 via the repo's Playwright — chosen over driving the live
app, which would have popped toasts into an active work session; disclosed
here since WebKit-vs-Chromium shadow rendering differs marginally).
`stage1-demo-scene.png` is the AA ladder. Verdict: the surface family
holds up — radius language identical, the sheet shadow convincingly soft
and low with the same density directly under the card, the hairline crisp
at 1 px, no AA artifacts on pills or translucent overlaps. It does not
embarrass itself; the giveaway is greeked text, which is Stage 2's job.

**What fought back.**
- Benchmarking on a daily driver someone is actively using: the window
  steals focus on launch, and twice a stray keystroke landed in it
  mid-run (an `S` toggling shadows into the "10k rects" headline, a space
  kicking a run out of continuous mode). Hence `--bench` ignoring the
  keyboard entirely. Related: with the window not frontmost, the display
  link cadences at 60 Hz, so `sapp.frameDuration()` alone cannot separate
  GPU cost from vsync — GPU utilization via
  `ioreg -c IOAccelerator` ("Device Utilization %", unprivileged) is the
  cross-check that made the numbers legible.
- sokol's one-update-per-buffer-per-frame rule shaped the batcher design
  (grow-at-upload instead of the plan's flush-on-capacity; API unchanged).
- Zig 0.16 `std.ArrayList` is the unmanaged flavor (allocator per call) —
  matches what Stage 0 saw elsewhere; otherwise nothing in 0.16 bit.

**Exit criteria.** Stress scene in <=1 draw call: pass (1, every scene).
Well under frame budget: pass at UI-plausible overdraw, with the fill-rate
finding above. Toast next to the real one without embarrassment: pass.
Frame-on-demand with a scene resident: pass (0 presents, ~1% CPU idle).
Isolation: pass (repo-wide grep clean, `bun run typecheck` untouched).

**Next session (Stage 2, text).** stb_truetype wrapper (`gfx/text.zig`),
R8 shelf-packed glyph atlas (`gfx/atlas.zig`), textured-quad mode in the
batcher (the `flush()` seam is ready), `draw.text` + `measureText`, the
settings-page demo composition, and real text in the toast taste test.
