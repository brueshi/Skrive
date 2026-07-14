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
**Commit:** `d3a83692ef065f22d1f60a3bc4fec923f687a0a6` (originally `01f8bfd`; rebased onto main at Stage 2 merge)

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

---

## 2026-07-13 — Stage 2: text — stb_truetype, the glyph atlas, and draw.text

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
**Commit:** `2a672c4482085bbb47e8511e0d51602f4c4f15b8` (originally `d09b5a7`; rebased onto main at merge)

**Toolchain.**
- Zig 0.16.0, sokol-zig `54776d6`, sokol-shdc `87a6914` — all pins unchanged.
- New vendored code: `stb_truetype.h` v1.26 (public domain, single header,
  fetched at nothings/stb `6e9f34d`) in `vendor/stb/`, with one marked local
  patch (see kerning, below). Implementation compiled as its own C TU
  (`stb_truetype.c`) so the Zig side only @cImports declarations.
- Fonts: Inter Regular + Medium 4.1 static TTFs in `assets/`, vendored under
  the SIL OFL 1.1 (license file alongside; OFL permits redistribution, so the
  FSL source-zip question is a non-issue). The optional serif was skipped —
  Fraunces ships variable-only TTFs in easy reach, stb does not do variations,
  and no Stage 2 composition needed it.
- `@cImport` under Zig 0.16: works unchanged (needs `link_libc = true` and an
  include path on the module). `stbtt_fontinfo` comes through as a real
  160-byte struct. No translate-c fight; the incantation is three lines in
  `build.zig`. Fonts embed via `addAnonymousImport` + `@embedFile`.

**What was built.**
- `gfx/text.zig` — the stb wrapper: load, scaled line metrics, glyph index,
  advance, kern, rasterize-to-tight-bitmap. One deliberate scale decision:
  sizes map through `stbtt_ScaleForMappingEmToPixels`, not
  `ScaleForPixelHeight` — em mapping is what CSS font-size means, and for
  Inter (hhea ascent−descent ≈ 1.21 em) the pixel-height scale would render
  ~17% smaller than the same nominal size in a browser, poisoning every
  side-by-side.
- `gfx/atlas.zig` — single-channel R8, shelf packing with 1px padding, cache
  keyed (font id, glyph, device px). 1024² to start, doubles by reallocation
  (CPU pixels are the source of truth; packed coordinates survive growth; the
  GPU image + view are recreated). sokol has no partial image updates and
  allows one updateImage per image per frame, so a dirty flag re-uploads the
  whole atlas once per frame at most — 1 MB when it happens, and it happens
  only on frames that rasterized a new glyph. Nearest sampling: glyph quads
  are texel-aligned by construction, so there is nothing to interpolate.
- Batcher: glyph mode (2) in the existing mode flag; the uv attribute carried
  since Stage 1 finally does its job. The atlas binds unconditionally — with
  exactly one texture there is never a mid-frame texture change, so the
  flush() seam stays in reserve and **shapes + glyphs are one draw call, not
  the budgeted two**. (This shdc pin generates view-based bindings —
  `VIEW_atlas_tex` — so the atlas exposes an `sg.View`.)
- `ui/draw.zig` — `text(pos, str, style)` (UTF-8 decode via std.unicode,
  kerning, float pen advance, per-glyph origin snap to integer device
  pixels), `measureText` (same pen math, no atlas), `textWrapped` (greedy
  break at spaces, `\n` forced). Positions are line-box top-left, CSS mental
  model. Letter-spacing supported (the shipped toast title is -0.01em).
- Scenes: settings page (key 5: 20px heading, card, 12px section label, two
  14px/21 paragraphs, hairline, three label rows), text wall (key 6, 2,338
  glyph quads), toast with real text per the shipped CSS. HUD is now
  on-screen text (bottom-left, 11px, once-per-second refresh; deliberately
  does not mark the frame dirty — that would repaint 1/s forever and break
  frame-on-demand). `--bench` keeps terminal prints and gains settings,
  text-wall, and idle-settings phases, plus an atlas census on clean exit.

**The kerning fight (the session's one real excavation).** stb's
`GetGlyphKernAdvance` returned 0 for every classic pair (AV, To, LT) in
Inter. Diagnosis by walking Inter's GPOS by hand: the `kern` feature routes
its class-based pair kerning through a **lookup type 9 (Extension
Positioning) wrapping the type 2 pair subtable**, and stb's "basic GPOS
kerning" iterates only direct type-2 lookups — extension-wrapped kerning is
silently invisible. Large fonts wrap their GPOS in extensions as a matter of
course, so this likely bites most modern fonts, not just Inter. Fixed with a
~15-line marked patch in the vendored header ([zig-ui lab patch] comments):
unwrap ExtensionPosFormat1, then process the wrapped subtable as before.
After the patch: AV −140 units (−1.91 px at 14px/2x), To −160, LT −197.
Worth knowing forever: stb + a modern font can *look* fine while kerning is
entirely dead — measure a pair before trusting it.

**One shader regression, caught and reversed.** First cut sampled the atlas
unconditionally at the top of main() (to keep control flow uniform for the
implicit-derivative rule). That texture fetch per fragment cost the
100x-overdraw stress scene ~28%: 14.3 → 19.9 ms. Moved into the mode branch:
back to 14.49 ms. Safe because mode is constant per quad, so flow is uniform
per primitive. UI-plausible scenes never noticed either way (8.35 ms both
ways) — fill-rate-bound regimes punish per-fragment costs that real UI
frames absorb.

**Measurements (macOS daily driver, ReleaseFast, 1200x800 @ 2x, window
frontmost, via --bench).**
- toast: 74 quads, **1 draw call**, build 57 us, 8.36 ms avg (119.6 fps).
- settings: 394 quads, **1 draw call**, build 293 us, 8.39 ms (119.2 fps).
  GPU cross-check via `ioreg` during the phase: ~21% (machine in use;
  ambient was ~4% in Stage 1 — the scene costs a few ms of GPU, not more).
- text-wall: 2,338 quads, **1 draw call**, build 1.38 ms, 8.44 ms (118.4
  fps). The build cost is the immediate-mode text tax: every frame re-walks
  UTF-8, kerning (a full GPOS walk per pair in stb — no cache yet), atlas
  hash lookups, and quad pushes for ~2.3k glyphs. Still holds 120 Hz with
  the frame budget at 8.33 ms, but this line item is the one to watch when
  Stage 3+ adds real compositions; a kern-pair cache is the obvious first
  lever if it ever matters.
- Stage 1 baselines re-run, unchanged: stress-large 14.48 ms (was 14.3),
  shadows 23.34 (was 23.3), stress-small 8.35 (was 8.36).
- Idle with text on screen: **0 presents over 15 s** in both idle phases,
  CPU 1.2% (`ps` during the phase) — the Stage 0/1 baseline holds.
- Atlas census after all phases: **1024x1024, 89 glyphs cached, 3.6%
  occupied, 0 growth events.** The growth path exists but nothing at lab
  scale exercises it; one font family x four UI sizes barely dents 1024².
- Cold-start cost: first settings frame rasterizes its ~80 glyphs; visible
  as the phase's worst-frame outlier only. Steady state never rasterizes.

**The text-quality verdict (the stage's whole point).** Screenshots in
`docs/zig-ui-lab/`: lab settings at 2x and 1x, lab toast, and Chromium
references at dpr 2 in two flavors — the shipped system stack
(product-honest) and the *same Inter TTFs* via @font-face with
font-synthesis off (isolates rasterizer from typeface).
- **Against Chromium rendering the same Inter files: near-parity at 2x.** In
  3x-magnified crops of the 15px toast title and the 14px paragraphs, stems,
  spacing, and kerning are pixel-comparable; Chromium renders a touch
  heavier (gamma-aware blending), the lab a hair lighter and slightly
  crisper. At reading distance they are hard to tell apart. The 14px
  paragraphs produced **identical line breaks** to Chromium at the same
  width — the measure math agrees with a real engine to sub-pixel totals.
- **Against the shipped app (system stack): the visible delta is the
  typeface, not the rasterizer.** SF Pro at weight 600 vs our Inter Medium
  500 reads as a different, slightly heavier voice. The lab also lacks
  weight 450/600 (only Regular/Medium vendored), so the toast eyebrow/title
  sit one notch light of spec. Fixable by vendoring more weights; not a
  rendering problem.
- **1x is where lab-tier text pays its tax**: readable but visibly rougher —
  unhinted stems wobble between 1 and 2 pixels. Expected (plan 4.3 defers
  hinting); the daily driver is 2x everywhere, so the wall the lab feared
  did not materialize where it matters.
- **Shimmer: verified zero, empirically.** Captured the window at two
  positions and pixel-diffed the content: 0 of 3.55M pixels differ beyond
  capture noise (max delta 6/255). Glyph origins are snapped to device
  pixels and window-relative, so there is no mechanism for drag shimmer —
  and now that is measured, not argued.
- Honest bottom line: **text did not kill the lab.** stb grayscale AA at
  retina 2x is within squinting distance of Chromium on identical font
  files; the true gaps are typeface/weight inventory and 1x hinting, both
  understood and both out of lab scope by design.

**What fought back (beyond kerning).**
- The GPOS extension-lookup gap (above) — half the session's debugging.
- zsh does not word-split unquoted parameters: a screenshot helper passed
  `"--settings --dpi1"` as one argument, which the app ignored, and the "1x
  settings" screenshot silently captured the default demo scene at 2x.
  Caught on inspection; re-shot. Lab args now always passed explicitly.
- The on-screen HUD wanted to mark the frame dirty on its once-per-second
  refresh; that would have made idle render at 1 fps forever. The HUD line
  now rides the next natural repaint instead (numbers freeze when idle,
  which is honest).
- Nothing else in Zig 0.16 bit: `std.mem.trimRight` is now `trimEnd`, and
  this sokol pin wants `ImageData.mip_levels` + view-based texture bindings
  (`sg.makeView`) rather than the older subimage/images API.

**Exit criteria.** 14px paragraph comfortably readable at 2x: pass. Glyphs
on pixel boundaries, no shimmer on window move: pass (pixel-diff zero).
Atlas + text ≤ 1 extra draw call: pass, with margin — the whole frame is
still **1 draw call** (unconditional atlas bind; flush() seam still unused).
Frame-on-demand with text resident: pass (0 presents / 15 s, ~1.2% CPU).
Screenshots + verdict in docs/zig-ui-lab/: pass. Isolation: pass (repo grep
clean outside labs/, `bun run typecheck` untouched).

**Deviations from the plan.** None of record: the vendored-header patch is a
bug fix within decision 4.3's "stb_truetype first" (kerned text is an
explicit Stage 2 deliverable), not a text-engine change. The serif font was
optional and skipped. Draw calls landed under budget, not over.

**Next session (Stage 3, input + identity + the first button).**
`ui/context.zig` (input snapshot, hot/active/focus IDs), hit testing,
`widgets.button` with the canonical press/cancel state machine, keyboard
focus + Space/Enter activation, pointer cursor, and a demo row of buttons
with visible effects. The renderer is ready for it: measureText exists for
sizing, and text-in-a-button costs nothing the bench hasn't already priced.
