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

---

## 2026-07-16 — Stage 3: input, identity, and the first button

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
(recreated off `main` — the Stage 2 branch had been merged and deleted).
**Commit:** `05d2a4a03a648520d9da7eb4eb6e332a503a627e`

**Toolchain.** All pins unchanged: Zig 0.16.0, sokol-zig `54776d6`,
sokol-shdc `87a6914`. No new dependency, no re-vendor (the stb kerning patch
is untouched). The renderer became a toolkit without adding anything below it.

**What was built.**
- `ui/context.zig` — the immediate-mode identity + input core. A per-frame
  `Input` snapshot (pointer in logical px, `mouse_down` level, and
  pressed/released/tab/activate edges) plus persistent `hot`/`active`/`focus`
  IDs, where an ID is a 64-bit Wyhash of label + optional discriminator (0
  reserved for "none"). `interact(id, rect, disabled)` is the one primitive
  every widget routes through: it registers the widget for Tab order,
  hit-tests, runs the state machine, and returns the visual + fired result.
- `ui/widgets.zig` — `button(ctx, painter, x, y, label, opts)`. Sizes itself
  around its label via `measureText`, resolves the five states honestly
  (default / hover / pressed / focused / disabled), draws through the Stage 1
  `rect` + Stage 2 `text`. By-eye styling from the shipped kit
  (`app/src/components/ui`): 13px label, 9px radius, ~34px tall, a 2px
  slate-indigo focus ring offset outside the button. `buttonShowcase()`
  renders forced states for the screenshot, through the same `resolve`+draw
  path the live widget uses.
- `main.zig` — mouse/keyboard event plumbing into the context, pointer cursor
  over interactive widgets (`sapp.setMouseCursor`), a live buttons scene
  (key `7`, `--buttons`) wired to visible effects (toggle a toast, cycle the
  clear color, toggle continuous mode, reset, plus a disabled button), and a
  deterministic state showcase (key `8`, `--showcase`) for screenshots.
- Tests — `zig build test` runs 9 headless unit tests over the state machine:
  hover, fire-on-release-inside, cancel-on-release-outside,
  drag-off-then-back-on, press+release-in-one-frame, disabled-inert, Tab
  order + both-way wrap, and mouse-focus-shows-no-ring + Space-activates.
  All 9 pass. A test aggregator (`src/tests.zig`) roots the test module at
  `src/` so the `ui/ -> ../gfx/` imports resolve; `end()` was refactored to
  *return* the cursor rather than call sokol, which is what makes the whole
  file runnable without a GPU (and is cleaner — the platform side effect now
  lives in `main`, at the edge).

**The design call worth recording (hover vs frame-on-demand).** Immediate
mode usually derives "hot" from the *previous* frame's hit test (Dear ImGui
does; it runs continuously, so the one-frame lag never shows). Under
frame-on-demand that lag is a bug: a mouse-move produces exactly one repaint,
so a hover computed for "next frame" would never paint until the pointer
moved again — hover would look stuck. So hover and the press/release machine
read *this* frame's hit test: the move event marks the frame dirty, the frame
re-runs, and the widget under the new pointer paints hovered in that same
frame. Nothing is scheduled on a timer, so a still pointer paints nothing.
The one thing this single pass gives up is arbitrating two *overlapping*
interactive widgets in one frame (both read hit=true); the lab has no such
overlap, and `hot_id` is still accumulated last-drawn-wins for the cursor and
as the seam where real overlap arbitration (popovers/menus, explicit Stage 3
non-goals) would plug in. Tab is the mirror image: resolved at `begin()`
against the previous frame's focusable list, which — because the scene is
stable frame to frame — equals this frame's, so the ring lands on the new
widget the same frame as the keypress, no lag and no nudge repaint.

**The cancel path.** Press over a button arms it (`active_id = id`); a release
fires only if the pointer is still inside (`hit`), and a release *always*
clears active. Press-drag-out-release cancels; press-drag-out-drag-back-in-
release fires (active persists across frames until release). Press and release
are checked without an `else` between them, so a press and release landing in
the same frame — a very fast click, or two events arriving before one repaint
— still fires. All four paths are pinned by unit tests.

**One bug caught in the writing.** The "Continuous: on/off" demo button has a
label that changes every frame. Hashing the display label for identity would
flip the button's ID on every toggle and silently drop its hot/active/focus
state. Fixed with an `id_label` opt: dynamic-label widgets key identity off a
stable string. Worth remembering for any future toggle/stateful-label widget.

**Measurements (macOS daily driver, ReleaseFast, 1200x800 @ 2x, via
`--bench`).** Draw calls and the idle result are the load-independent
invariants and are clean; the frame/CPU numbers carry two environmental
caveats stated below.
- Every scene, including the new ones: **1 draw call.** The buttons scene is
  114 quads; the showcase 251. Shapes + glyphs still share the single batch
  (the atlas binds unconditionally; the `flush()` seam stays unused).
- `settings`: 394 quads, **8.33 ms (120.0 fps)** — matches Stage 2's 8.39 ms.
  `toast`: 74 quads, **8.34 ms (119.9 fps)** — matches Stage 2's 8.36 ms. The
  renderer is unchanged; the widget layer adds nothing to a frame.
- `buttons`: 114 quads, 1 draw call. Its phase happened to be vsync-capped at
  60 Hz (16.66 ms) — see the frontmost caveat — so that frame-avg is a vsync
  artifact, not a widget cost: 114 quads is a lighter scene than `toast`,
  which held 120 Hz. On-demand build cost for the scene, measured off the HUD
  on a quiet frame, was ~150 us.
- **Frame-on-demand holds with buttons resident: 0 presents over 15 s idle**,
  in all three idle phases (stress, settings, buttons). The Stage 2 HUD trap
  (marking the frame dirty on a timer → a permanent 1 fps loop) is avoided —
  nothing dirties the frame except real input, and hover renders only while
  the pointer actually moves. This was the criterion I was most watchful of.
- Atlas census after all phases: **1024², 131 glyphs cached, 5.3% occupied,
  0 growth events** (up from Stage 2's 89 glyphs — the button/showcase labels
  and the "Continuous"/"Cycle background" strings added ~40 glyphs). Still no
  growth; one font family at UI sizes barely dents 1024².

**Two measurement caveats (both environmental, both honest).**
1. *The window ran shell-launched, not a bundled app.* Launched from the
   agent's shell, the sokol window opens off the active Space and only reaches
   120 Hz when it is genuinely frontmost; otherwise the display link cadences
   at 60 Hz (the Stage 0/1 note about frontmost). Across the run some phases
   hit 120 Hz (`toast`, `settings`) and some were pinned at 60 (`buttons`,
   `stress-large`). Where a light scene reads exactly 16.67 ms it is
   vsync-locked at 60, not GPU-bound. GPU cost was cross-checked with
   `ioreg` Device Utilization (100% only in the `stress-large` fill-rate
   torture phase, as in Stage 1).
2. *Background CPU load inflated the CPU-side build numbers.* A first bench
   run was contaminated by a `logioptionsplus_agent` (Logitech) spike at ~28%
   CPU plus Spotlight (`mds`) indexing — build times ran 10–33x Stage 2's
   (text-wall build 45 ms vs 1.38 ms). A second run after the spike cleared
   is the one reported here; its build times are still ~3–10x Stage 2's from
   ambient load (toast build 956 us vs 57 us), but the frames that reached
   120 Hz did so cleanly, which is the signal that the renderer itself is
   unaffected. The lesson from Stages 1–2 stands and gained a corollary:
   measure on a quiet, frontmost window, and treat CPU-build averages from a
   shared daily driver as upper bounds.

**How the button actually feels — and the honest limit of this session's
verification.** I could not hand-drive it: the shell-launched window sits off
the active Space, and warping the physical cursor / injecting keystrokes on
a machine in active use is exactly the contamination Stages 1–2 warned
against. So the feel claims here rest on three legs, and I am calling the gap
plainly. (1) The state machine — the part that makes a button feel like a
button rather than a demo (no missed clicks, correct release-outside cancel,
armed-across-frames drag-back, one-frame fast click) — is verified
deterministically by the 9 unit tests. (2) The visuals of all five states are
verified by the showcase screenshot, rendered through the identical
`resolve`+draw path the live widget uses. (3) Zero *added* input latency is a
property of the design, not a measurement: hover/press/release read this
frame's hit test and every input event marks the frame dirty, so a click
registers on the frame its event arrives and hover paints on the frame the
pointer moves — there is no buffer, no debounce, no next-frame deferral
anywhere in the path. What remains genuinely unverified by me is the tactile
end-to-end latency through WKWeb/Metal/display — i.e. whether it *subjectively*
matches a native button under a fingertip. That is the one thing a person has
to feel, and it is Joe's to confirm at the keyboard (key `7`). My honest
expectation, from the design: it should feel at least as immediate as the web
button, because there is no framework event queue between the OS event and the
pixel — but I have not felt it, and I am not going to claim I have.

**Screenshots** in `docs/zig-ui-lab/`:
- `stage3-buttons-showcase-lab.png` — the deliverable: 3 variants
  (primary / default / secondary) x 5 states, hover and focus visible, from
  the real render path. HUD confirms 1 draw call.
- `stage3-buttons-web-reference.png` — the shipped kit transcribed from
  `app/src/components/ui` and rendered in Chromium over the same Inter TTFs
  (Playwright, dpr 2), the same method as Stages 1–2.
- `stage3-buttons-live-lab.png` — the live demo row (key `7`) at rest.

Eyeballed against the reference: the radius, proportions, label weight, and
the slate focus ring line up; the lab's hairline and fills read as the same
surface family Stage 1 established. Two honest divergences, both arguably in
the lab's favour and both noted on the reference sheet: the shipped Button has
**no `:active` rule**, so a shipped press only shows the hover look — the lab
gives a distinct pressed state (a deeper wash / a darker primary), which is
more tactile; and the lab's bare "default" variant carries a subtle hover wash
the shipped bare `.button` lacks (the shipped default *is* Secondary — the
bare base is rarely used alone).

**What fought back.**
- *Driving a GUI from the agent shell.* The window opens off the active Space
  and does not appear in `CGWindowListCopyWindowInfo(.optionOnScreenOnly)`;
  it is present under `.optionAll` (owner `zig-ui`, layer 0) and captures fine
  by window id with `screencapture -l<id> -o -x` even while off-screen, which
  is how the screenshots were shot. But an off-screen window gets no sustained
  frame callbacks, so `--bench` (which advances on the frame tick) stalls
  indefinitely until the window is brought frontmost — a first background run
  ran for many minutes producing nothing. Fix: `osascript` System-Events
  "set frontmost" after launch starts the display link; then leave it
  untouched (headless shell polls don't steal GUI focus).
- *stderr buffering.* Redirected to a file, `std.debug.print` is
  block-buffered, so a stalled/killed run shows an empty log (this is why the
  first stuck run looked silent). A clean run that reaches `requestQuit`
  flushes through `cleanup`. Running under a pty via `script` to force
  line-buffering did not work here — the child exited immediately under
  `script &` — so the approach was: let the bench self-quit and read the file
  after, cross-checking liveness with `pgrep` + `ioreg` GPU utilisation.
- *The dynamic-label identity bug* (above) — caught while wiring the demo, not
  by a test; a good argument that stateful-label widgets deserve a test of
  their own when Stage 4 adds the toggle.
- Nothing in Zig 0.16 bit this session beyond what Stages 0–2 already logged;
  `sapp.MouseCursor`, `sapp.modifier_shift`, and the event union were all
  where expected.

**Exit criteria.**
- Interaction feels indistinguishable from a native/web button: **verified for
  the mechanics** (9/9 state-machine tests: no missed clicks, correct
  release-outside cancel, focus ring moves in draw order), **design-argued for
  latency** (no added buffering in the input path), **unverified for
  subjective tactile feel** (could not hand-drive; Joe's pass owed). Called
  honestly rather than claimed.
- Frame-on-demand holds with buttons on screen: **pass** (0 presents / 15 s,
  all three idle phases). No timer dirties the frame.
- Focus ring visible + moving correctly through draw order: **pass** (unit
  test + showcase screenshot).
- Button-row screenshot with hover + focus next to a shipped reference:
  **pass** (`stage3-buttons-showcase-lab.png` + `-web-reference.png`).
- `--bench` runs clean end to end with fresh numbers for an interaction-heavy
  scene alongside the carried baselines: **pass** (buttons phase +
  idle-buttons; carried toast/settings re-confirmed at 120 Hz).
- Isolation: **pass** — repo-wide grep finds `zig-ui` only in
  `docs/zig-ui-lab-log.md` and `docs/lab-graduation-checklist.md` (no build or
  code coupling outside `labs/`); `bun run typecheck` untouched.

**Deviations from the plan.** None requiring sign-off. Two additive choices,
both logged rather than silent: the `--showcase` scene and `buttonShowcase()`
exist only to make the screenshot deterministic without warping the cursor —
they go through the real render path and add no widget behaviour; and `end()`
returns the cursor for `main` to apply instead of calling sokol itself, a
testability refactor that also keeps the platform side effect at the edge.
Neither touches a decision in plan section 4.

**Next session (Stage 4, layout and the small kit).** `ui/layout.zig`
(immediate-mode row/column with padding, gap, fixed/fit/grow sizing —
transcribe the ~20% of flexbox `app/src/components/ui/*.module.css` actually
uses), then `toggle` and `segmented` built strictly on this stage's
hot/active machinery (if they need new primitives, that is a design smell to
log), the first per-ID animation store (toggle knob / segmented thumb easing,
frame-on-demand-safe and settling in ~150 ms), a Windows smoke build for
curiosity, and a settings-card composition authored with zero absolute
coordinates. The button is hand-placed today precisely because one button can
be; a kit cannot, which is what Stage 4 is for.

## 2026-07-24 — Stage 4: layout and the small kit

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
(recreated off `main` — the Stage 3 branch had been merged and deleted).
**Commit:** `9a7a554`

**Toolchain.** All pins unchanged: Zig 0.16.0, sokol-zig `54776d6`, sokol-shdc
`87a6914`. No new dependency, no re-vendor, no shader change — Stage 4 adds
2,997 lines of `ui/` on top of a renderer it never touched.

**What was built.**
- `ui/layout.zig` — flexbox-lite. Row/column `Box`es with per-side padding, a
  gap, per-child main-axis sizing (`fixed` / `content` / `grow`) and cross-axis
  alignment (start / center / end / stretch), plus `Fit.content` containers that
  shrink to their children. The vocabulary was chosen by reading
  `app/src/components/ui/*.module.css` and the `.settings-row` rules in
  `app/src/index.css` and transcribing what is actually there: two directions,
  one gap, per-side padding, three sizing modes, four alignments. Nothing else
  appears in the shipped kit — no wrapping, no percentages, no `order`, no
  auto-margins. `justify-content: space-between` is not a feature here because
  it is not one there either: the real row achieves it with `flex: 1` on the
  text block, which is a grow child.
- `ui/anim.zig` — the per-ID animation store, ~90 lines of substance. An entry
  is `{key, current, target, remaining}`; `value(key, target)` retargets and
  reads, `advance(dt)` steps every in-flight entry by exponential decay
  (tau = 22ms), `animating()` reports whether anything is still moving.
- `ui/widgets.zig` — `toggle()` and `segmented()`, both on Stage 3's
  hot/active/focus machinery, plus `buttonWidth`/`segmentedWidth` (a layout box
  needs a child's natural size before the child draws) and forced-state
  showcase renderers. Each widget is split into a `*Interact` half that is pure
  over the context and a drawing half that calls it — the same instinct as
  Stage 3's `end()` returning the cursor, and the thing that makes the
  mechanics testable without a GPU.
- `main.zig` — a `card` scene (key `9`, `--card`), Left/Right plumbed into the
  input snapshot, a dt clock measured from the last *rendered* frame, the
  after-build animation dirty check, a `card` bench phase and an
  `idle-card-after-toggle` phase that flips the toggle on entry so the bench can
  measure an animation it is not allowed to type at.
- Tests — `zig build test` now runs **33** (was 9): 10 for layout arithmetic, 6
  for the animation store, 8 for the new widgets, and Stage 3's 9 carried
  forward through the two signature changes.

**The layout design call, and why it is not dvui's.** dvui's `BoxWidget` keeps
`packed_children / total_weight / min_space_taken` from the previous frame and
distributes grow space against those, calling `refresh()` when this frame
diverges; the long Dear ImGui layout thread lands in the same place, and its
contributors describe the one-frame lag as the accepted price of letting
children be emitted before the container knows its own content. That price is
much higher here. Both of those libraries render continuously, so a frame of
lag is invisible — this lab renders on demand, where a layout that is wrong on
the frame an event arrives needs a *second* repaint that nothing would
schedule. It is the same trap Stage 3 avoided by hit-testing this frame instead
of last frame, and the second time the frame-on-demand requirement has forced a
different architecture than the reference implementations use.

So a `Box` takes its children as declarations up front (the third option in
that ImGui thread), resolves them in one measure+arrange pass, and hands back
rects the caller draws into: widgets are emitted *after* the arithmetic instead
of during it. No layout state survives the call. **The cost is real and it is
the honest weakness of the idiom:** a child's natural size is the caller's to
supply, so this cannot infer a nested subtree's intrinsic size the way a
retained tree can. At kit scale that is a `measureText` call — `buttonWidth()`
and `segmentedWidth()` exist precisely to pay it — but a deep tree of unknown
content would want either dvui's lag or a real two-pass tree.

**The animation store, and where it lives.** In `Context`, as a field, in its
own file. Keyed by widget identity, same lifetime as hot/active/focus, and
every widget already holds the context — a second store threaded through the
Painter would have been ceremony. Its own file because `context.zig` is
identity + input and this is identity + time, with no shared invariants.

Its shape is deliberately not dvui's either. dvui stores a tween (start_val,
end_val, start_time, end_time, easing fn) and deletes it when the clock runs
out, which is right for a one-shot. It is wrong for a control: retargeting a
tween mid-flight either restarts it from a new origin or makes the caller
rewrite `start_val` by hand. A toggle flicked twice quickly does exactly that.
So an entry here is a *retargetable* value and the interpolation is exponential
decay, which has no notion of an origin at all — flick it back mid-slide and
the knob turns around from wherever it is. There is a unit test for that.

**The trap, and how termination actually works.** An animation is the obvious
way to break `idle = 0 presents`: mark the frame dirty every frame and you have
a permanent max-fps loop, the same shape as the Stage 2 HUD's once-a-second
timer. Two decisions handle it. (1) Termination is by **clock, not by an
epsilon**: a retarget sets `remaining = 150ms` and the entry snaps to its
target when that runs out. An epsilon test on a decay curve is asymptotic, and
with unlucky units (the knob's press-stretch is in pixels, the segmented
thumb's position is in option-indices) it can take arbitrarily long to
converge — a clock guarantees the settle time regardless of scale. After 150ms
at tau = 22ms the residual is e^-6.8, ~0.1% of the jump, far under a device
pixel. (2) The dirty flag is set **after the scene is built**, not during
`begin()`, because a widget retargets while drawing: an in-flight value asks
for the next frame, and the frame that lands on the target asks for nothing.
Exponential decay also happens to be frame-rate independent, which matters
concretely here — this window fluctuates between 60 and 120Hz depending on
whether it is frontmost, and a per-frame `cur += delta * 0.2` would visibly
animate at two speeds.

**The design smell the plan asked me to watch for — and it showed up exactly
where the plan predicted.** The segmented control is a radiogroup: *one* Tab
stop whose options are chosen with arrow keys, but every option still needs its
own hit test, hover, and press. Stage 3's `interact()` fused "is a keyboard
target" with "is interactive," which cannot express that. Two additions, both
routed through `context.zig` rather than bolted onto the widget:

1. `interact(id, rect, opts)` gained `opts.focusable` (and `disabled` moved
   into the same struct). A non-focusable part registers no Tab stop *and does
   not steal focus on press* — that second half is what keeps a click on an
   option leaving focus on the group, without which arrows would stop working
   after any mouse selection. Pinned by a test.
2. `Input` gained `nav_prev` / `nav_next`, and `Interaction` gained `has_focus`
   (the keyboard-target fact, as distinct from `focused`, which stays
   :focus-visible and only true when focus arrived by keyboard).

Honest read: this is a small, well-motivated widening rather than a wart — one
option struct and two edges — but it is the first time a widget needed the
primitive changed, and the *shape* of the need (composite widgets are one focus
target made of many hit targets) is the shape that recurs for menus, tab bars,
lists, and toolbars. A retained tree gets this for free from parent/child
containment. If this lab ever grew, that is where the pressure would come from,
not from drawing.

**Measurements (macOS daily driver, ReleaseFast, 1200x800 @ 2x, via `--bench`).**
Draw-call and present counts are the load-independent invariants and are clean;
the frame averages carry the standing environmental caveats (below).
- Every scene, including both new ones: **1 draw call.** The `card` scene is
  311 quads. Shapes, glyphs, toggle knobs, and
  segmented thumbs all still share the single batch — the `flush()` seam
  remains unused since Stage 1.
- `card`: 311 quads, **1 draw call**, build 542us. The layout arithmetic is
  invisible in the numbers: the whole scene resolves 5 nested boxes (page,
  card, three rows, three text columns, one segmented strip) per frame and the
  build cost sits between `settings` (394 quads, 660us) and `buttons` (114
  quads, 231us) — i.e. it tracks quad count, not box count. Immediate-mode
  layout at kit scale is free.
- **The animation criterion, both halves, measured.** The
  `idle-card-after-toggle` phase flips the toggle on entry and then sits still:
  **10 presents during the 1s settle window** (the transition repainting itself
  — 150ms at this run's 60Hz cadence is 9 frames plus the frame the flip
  dirtied), then **0 presents over the following 15s**. The animation runs and
  then genuinely stops asking for frames. This was the number I was most
  watchful of, and it is the one that would have silently become a permanent
  max-fps loop if the dirty flag had been set anywhere but after the build.
- Frame-on-demand also re-confirmed unchanged on the carried scenes: **0
  presents over 15s** in all three of the stress, settings, and buttons idle
  phases.
- Carried baselines re-confirmed: stress-large 14.32ms (Stage 1: 14.3, Stage 2:
  14.48), stress-large-shadows 24.59 (23.3 / 23.34), stress-small 16.37,
  toast 16.90, settings 16.88, text-wall 17.89, buttons 16.84 — all 1 draw
  call, all quad counts identical to Stage 3 (74 / 394 / 2,338 / 114).
- Atlas census after all phases: **1024², 225 glyphs cached, 9.2% occupied,
  0 growth events** (Stage 3: 131 glyphs, 5.3%). The +94 glyphs are the card's
  prose and the showcase's new labels; still no growth, still one texture, so
  still one draw call.

**Two measurement caveats, unchanged from Stage 3 and both environmental.**
Every light scene in this run reads 16.7-16.9ms — that is the display link
cadencing at 60Hz, not a cost: `toast` at 74 quads and `text-wall` at 2,338
quads report the same frame average, which is only possible if both are
vsync-bound. Stage 3 saw the same thing on some phases and 120Hz on others,
depending on whether the shell-launched window was genuinely frontmost. And the
CPU build averages run 2-4x Stage 2's on ambient daily-driver load (settings
build 660us here vs 345us in this session's own baseline run of the *identical*
Stage 3 binary, taken 40 minutes earlier) — which is why that baseline run
exists at all: it prices the machine, not the code. Both runs are in the
session record; the delta between them is load, not Stage 4.

**How it feels — and the honest limit of my verification, again.** Same as
Stage 3: I cannot hand-drive the window from the agent shell, so the claims
rest on three legs and I am naming the gap rather than papering it.
1. *Mechanics* — verified deterministically by 33 headless tests: the toggle
   flips on release-inside and cancels on release-outside, Space flips the
   focused one, a disabled one is inert, identity survives the bound value
   changing mid-gesture (the Stage 3 dynamic-label lesson, tested this time
   rather than discovered); the segmented control is one Tab stop, a click on
   an option leaves focus on the group, arrows wrap in both directions and do
   nothing when unfocused.
2. *Visuals* — `stage4-widgets-showcase-lab.png` next to
   `stage4-widgets-web-reference.png` (the shipped Toggle/Segmented CSS in
   Chromium over the same Inter files, dpr 2, states written out explicitly
   since a static capture cannot trigger `:hover`/`:active`). Eyeballed: track
   colours, knob geometry, press-stretch, radii, thumb shadow, and the focus
   ring all line up. **One real divergence, and it is the same one Stage 2
   found:** the shipped active segment steps to weight 600 and reads
   distinctly bolder; the lab carries Regular and Medium only, so the active
   option reads through colour alone and the strip is visibly flatter. That is
   a font-inventory gap, not a rendering one — vendoring Inter SemiBold fixes
   it, and Stage 5 should, since the benchmark is a weight-for-weight
   comparison.
3. *Animation* — the transition is 150ms, which a shell-driven `screencapture`
   cannot reliably land inside, so the in-between states are shown as a
   deterministic ladder (0, ¼, ½, ¾, 1) rendered through the identical paint
   path the animation drives, and *that* it runs is measured by the bench's
   settle-window present count rather than photographed. Both halves are
   evidence; neither is a caught frame, and I am not going to describe it as
   one.

What remained unverified by me was whether the toggle *feels* right under a
fingertip — whether tau = 22ms with a hard 150ms stop reads as crisp or as
slightly rubbery next to the shipped `cubic-bezier(0.16, 1, 0.3, 1)` over 160ms.
Those are the same family and close in duration, so my expectation was "very
near," but it is the judgement that has to be made by eye.

**Joe ran it on the daily driver at the end of the session and the verdict was
that it runs well** — no change asked for to the timing, the press-stretch, or
the segmented keyboard. So the tactile leg is closed by the person who can
close it, and the animation constants stand as shipped: tau = 22ms, 150ms hard
settle. (If a later stage wants it snappier, `anim.tau` is one number.)

**Two deliberate scope calls, both visible in the screenshots.**
- *Hover does not animate.* The shipped CSS transitions the track colour over
  110ms on hover; the lab steps it. The plan named "the toggle knob and the
  segmented thumb" as the first animation and I kept to exactly that. The store
  would handle it in two lines per widget — it is a scope call, not a
  limitation.
- *Inset shadows are approximated.* The toggle's sunken-track rim
  (`inset 0 0 0 1px`) becomes a 1px border and the knob's 0-blur 0.5px shadow
  ring becomes a 0.5px border — the same pixels by another route. The second
  rim layer (`inset 0 1px 1.5px`, a blurred inner top shadow) has no equivalent
  in a shader that draws no inset blur, so it is dropped rather than faked. At
  23px tall the difference is not visible in the side-by-side, but it is a real
  gap in the shape shader and Stage 5's token pass will meet it again.

**Windows smoke test (curiosity, not a gate).** `zig build
-Dtarget=x86_64-windows -Doptimize=ReleaseFast` now produces a 1.8MB
`zig-ui.exe` (+ pdb), linking `d3d11`/`dxgi` through sokol as decision 4.4
predicted. It did not build first try, and the single thing in the way is worth
recording: **not one line of the renderer, the widget layer, or the layout
code — only argument parsing.** Zig 0.16's `std.process.Args.Iterator.init` is
`@compileError` on Windows (the command line arrives as one WTF-16 string that
must be split and re-encoded); `initAllocator` is the cross-platform form and a
no-op wrapper on posix. One line, and the D3D11 build fell out. Everything
above the platform layer is genuinely portable, which is the answer decision
4.4 was fishing for. **Not run on the Windows box** — I cannot execute a
Windows binary from this session, so there is no screenshot; the executable and
the finding are what this stage produced, and running it is Joe's if he is
curious.

**What fought back.**
- *Nothing in the layout maths, because the tests caught it.* Two of my own
  arithmetic slips (a divider's gap counted once in a comment and twice in the
  expectation; a segmented track width off by 2px) were caught by the unit
  tests within a minute of writing them. Worth noting because layout is exactly
  the domain that looks right on screen while being subtly wrong, and where a
  screenshot is not a test.
- *`screencapture` refuses the window right after an AppleScript resize.* The
  window-id capture trick from Stage 3 works reliably on a settled window and
  returns "could not create image from window" for several seconds after a
  programmatic resize (surface reallocation, presumably). Bringing the window
  frontmost first and waiting ~3s fixed it. That is how the narrow-window
  screenshot got taken, and the resize itself is a real exercise of the layout
  code, not a mock.
- *The Zig 0.16 Windows arg iterator* (above) — 20 minutes of the session, and
  the only cross-platform friction in ~3,000 lines.
- Nothing else in Zig 0.16 bit. `std.debug.assert`, tagged unions in a const
  array, and returning an anonymous struct from a function all behaved.

**Screenshots** in `docs/zig-ui-lab/`:
- `stage4-card-lab.png` — the deliverable: the settings card at 1200x800, laid
  out with zero absolute coordinates.
- `stage4-card-narrow-lab.png` — the same scene with the window resized to
  720x600 (via System Events, so it goes through the real resize path). The
  content column narrows, the text blocks shrink, the controls keep their size
  — `flex: 1` and `flex-shrink: 0` doing their jobs.
- `stage4-widgets-showcase-lab.png` — every state of button / toggle /
  segmented, plus the mid-transition ladder.
- `stage4-widgets-web-reference.png` — the shipped Toggle + Segmented CSS in
  Chromium over the same Inter files.

**Exit criteria.**
- *The settings card is authored with zero absolute coordinates; adding a
  fourth row is a ~three-line change:* **pass, and better than asked.** There is
  no literal coordinate in `buildCardScene` — the page column centres itself in
  the live window size, the card takes the space under the heading and then
  shrinks to its rows, and every row and text block comes out of a Box. Rows
  are a data array with a tagged-union control, so a fourth row is **one line**.
- *Toggling animates smoothly, then idles at 0 presents:* **pass**, both halves
  measured — see the settle-window numbers above.
- *Toggle and segmented feel right:* **pass, all three legs.** Mechanics
  verified (33/33 tests), visuals verified against a Chromium reference with
  one honest divergence (font weight inventory), and the tactile pass done by
  Joe at the keyboard in-session — it runs well, nothing changed. This is the
  first stage where the feel criterion is fully closed rather than
  design-argued; Stage 3's is still owed.
- *`--bench` runs clean end to end with fresh numbers alongside the carried
  baselines:* **pass**, and the log records both this run and a same-session
  baseline run of the unmodified Stage 3 binary so the load is legible.
- *Isolation:* **pass** — repo-wide grep finds `zig-ui` only under `labs/` plus
  the two lab docs; `bun run typecheck` untouched; `rm -rf labs/` still breaks
  nothing.
- *One draw call:* **pass**, every scene.

**Deviations from the plan.** None requiring sign-off; nothing in section 4 was
touched. Three additive choices, logged rather than silent: the `focusable`
option and the two nav edges (the plan explicitly sanctioned this and asked for
it to be flagged — done, above); the `*Interact` / draw split in the widgets,
which exists to make the mechanics testable headless; and the `initAllocator`
change, which is a portability bug fix the Windows smoke test surfaced.

**Next session (Stage 5, the honest benchmark).** `ui/tokens.zig` transcribed
from `app/src/components/ui/tokens.css` + `app/src/index.css`, the Stage 3/4
widgets restyled off it, IconButton, and the side-by-side against the shipped
kit at identical logical size. Stage 4 leaves it two concrete gifts and one
concrete debt: the layout module means the benchmark scene can be a real
settings section rather than hand-placed rects; `segmentedWidth`/`buttonWidth`
mean sizing is already token-drivable. The debt is the font weights — the
comparison is weight-for-weight, and the lab currently carries two of the four
the kit uses (400/500 against 450/500/600). Vendor Inter SemiBold and Light
before shooting anything for the verdict.

---

## 2026-07-31 — Stage 5: the honest benchmark — tokens, the kit at spec, and the side-by-side

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
(recreated off `main` — the Stage 4 branch had been merged and deleted).
**Commit:** `a808a84` (code); log + screenshots follow in the next commit.

**Toolchain.** All pins unchanged: Zig 0.16.0, sokol-zig `54776d6`, sokol-shdc
`87a6914`. No new dependency and no shader change. New assets: Inter SemiBold
and Inter Light static TTFs vendored from the same Inter 4.1 release as the
existing Regular/Medium (byte-identical hashes for the carried pair confirmed
the provenance; SIL OFL, existing license file covers the family). One system
font is now loaded at *runtime* — see the serif note below — which plan 4.3
explicitly sanctions as the alternative to vendoring.

**Session-start regression.** Before touching anything: `zig build` clean,
33/33 tests, and a full `--bench` run — every scene 1 draw call, 0 presents in
all four idle phases, settle window 10 presents then silence, atlas census
identical to Stage 4 (225 glyphs, 9.2%, 0 growth). The carried numbers matched
Stage 4's run at the same 60Hz cadence, so the branch cut was clean.

**What was built.**
- `ui/tokens.zig` (207 lines) — the mechanical transcription: semantic palette,
  shell/card values, the radius scale, all four elevation shadows, the focus
  outline, motion durations/easings, and the component tier (button, input,
  segmented, toggle, icon button), plus the `.settings-*` class specs the
  benchmark scene consumes. Every `color-mix()` was computed by hand and then
  cross-checked against Chromium's computed styles with the real CSS loaded —
  all matched (`--toggle-track-off` = #bdbec2, `--segmented-track` = #c9cace,
  `--settings-cap` = #9d9da2, `--settings-hair` = #eaeaec).
- Widgets restyled off tokens; hover now *animates* (the Stage 4 debt): each
  widget runs a `hover_t` through the same per-ID store as its state
  transitions, so the shipped 110ms colour transition reads as a fade rather
  than a step. Button, toggle, segmented, and the new icon button all carry it.
- `ui/icons.zig` + IconButton — three shipped icons hand-transcribed to SDF
  primitives, plus the 26px transparent glyph square with the 7% hover wash and
  0.4 disabled opacity per the module CSS.
- The benchmark scene (key `9`) — no longer an invented card: it is the shipped
  **Editor pane's "Writing" section row for row** (Line measure segmented with
  all five options; Measure rule / Smart typography / Check spelling toggles;
  the real label and description copy from SettingsView.tsx), under the real
  pane head, on the real `.settings-col` geometry, with a labelled CONTROLS
  strip below it so Button and IconButton appear in the comparison (the strip
  is kit coverage, not a shipped section — the screenshots say so).
- `gfx/text.zig` gained TTC support: `faceCount`, `initFace(id, data, index)`,
  and `subfamily()` (Mac name record first, Microsoft UTF-16BE fallback) so a
  face can be picked out of a TrueType collection by name at runtime.

**The transcription findings — measuring the kit beat eyeballing it, twice.**
- **The rem trap.** `index.css` sets `:root { font-size: 14px }`, so 1rem is
  14px in the shipped app — not the browser-default 16. `--button-font-size:
  0.8125rem` therefore computes to **11.375px**, not the 13px the value was
  presumably chosen to be, and the shipped button genuinely renders an 11.4px
  label (verified via getComputedStyle: font-size 11.375px, padding 7px/15.4px,
  height 33.06px). The lab's Stage 3 by-eye numbers (13px label, 9px radius,
  34px tall, 16px pads) were all wrong against the real kit; the token pass
  moved every one (radius 9 → 8, label 13 → 11.375, pads 16 → 15.4, height
  34 → 33.06).
- **The primary button is weight 400.** `.button` says `font: inherit` and no
  rule anywhere in the kit adds a font-weight — primary included. The lab had
  been drawing primary labels in Medium since Stage 3. Now Regular everywhere,
  per the measurement, not the guess.
- Focus ring corrected to the shipped `:focus-visible` spec: 2px at 50% alpha,
  **2px** offset (the lab carried 3px by eye).
- The card shadow is the token's quiet `0 1px 2px 5%` (sigma 1), not the
  by-eye `0 2px / sigma 4` the Stage 4 card wore; the row hairline is
  `--settings-hair` (#eaeaec), not rule-at-60%.
- The segmented active option steps to **SemiBold 600** — the weight the lab
  finally carries. Options are measured at the weight they currently render,
  so the strip resizes by a fraction of a pixel on selection exactly as the
  shipped control does (no reserved bold width there either; the thumb rides
  framer-motion's layout animation over it).

**The serif title.** The pane title renders in `--skrive-editor-font` — Iowan
Old Style at font-weight 600, which CSS font matching resolves to the
collection's **Bold** face. The lab cannot vendor an Apple system font, so it
reads `/System/Library/Fonts/Supplemental/Iowan Old Style.ttc` at runtime and
picks the Bold face by name (face 1 of 7), falling back to Inter SemiBold with
a log line if the file is missing. That makes the most prominent line of the
benchmark a typeface-for-typeface comparison in *both* flavours. Zig 0.16
fought back here: `std.fs.openFileAbsolute` is gone (fs reads now route
through the new `std.Io` interface, and threading an Io through sokol
callbacks is the same disproportion Stage 0 hit with timers), and
`std.posix` has lost `fstat` and even `close` — the loader ended up on
`posix.openat` + `posix.read` to EOF under a 16MB cap with a libc `close`.
Three API archaeology rounds for one file read; recorded so the next session
doesn't rediscover it.

**The icons, and where the primitive vocabulary ends.** Three icons, three
verdicts on expressibility:
- **Plus is exact**: a round-capped stroke *is* a pill-radius rect.
- **Search is exact except its handle**: the lens ring is a border-mode rect
  at half-size radius (the SDF degenerates to a circle), but the 45° handle
  has **no primitive** — the vertex format carries no rotation, so it is
  stamped as 13 overlapping filled circles along the segment. Reads cleanly
  at 2x; overlapping AA fringes would show at 1x. A real renderer grows a
  rotated-quad transform here (GPUI and Dear ImGui both have one).
- **The pin names the edge**: its head is an ellipse and its base plate is a
  cubic bezier — neither expressible. The head became a stadium of the same
  bounds (sub-pixel bulge difference at 16px), the plate a stroked rounded
  rect, the near-vertical flanks vertical strokes. It *reads* as the pin in
  the side-by-side, but it is an approximation and the least faithful of the
  three. Finding, not a reason to build a path rasterizer — exactly as the
  plan predicted.

**The line-box lesson — the miss that taught the most.** The first side-by-side
had the lab's whole card sitting **11px higher** than the reference. Cause:
the lab was using natural font line heights for the title/sub/cap while CSS
applies the root `line-height: 1.5` to all three (none declares its own) and
centres each font box in its line box via half-leading. Modelled that (37.5 /
20.25 / 16.5px boxes, text centred), and the card's top border then landed
within **0.5px** of the reference (measured programmatically off both images:
lab 161.5px from content top, Chromium 162). The general shape of this
finding: WebKit's text stack is not just a rasterizer, it is a *layout
semantics* engine — rem resolution, line boxes, half-leading, font matching —
and every one of those semantics had to be reimplemented by hand to make the
pixels line up. The rasterizer was never the hard part of text; the rules
around it are.

**Screenshots** in `docs/zig-ui-lab/` (the typeface-trap discipline, stated on
every image):
- `stage5-benchmark-lab.png` — the lab scene (Inter vendored + system Iowan).
- `stage5-benchmark-web-product.png` — Chromium, the app's real CSS + markup,
  system font stack: the **product-honest** flavour (typefaces differ by
  design: SF Pro vs Inter; Iowan title on both).
- `stage5-benchmark-web-inter.png` — same page over the **same Inter TTFs**
  via @font-face with synthesis off: the **rasterizer-isolating** flavour.
- `stage5-side-by-side-product.png`, `stage5-side-by-side-inter.png` —
  labelled A/B panels at identical logical size, 2x.
- `stage5-text-crops.png` — 3x magnified crops (title / Medium label /
  Regular desc / SemiBold active segment), lab vs Chromium-on-identical-files,
  regions anchored per-image to the detected card edge.
- `stage5-showcase-lab.png` — every widget in every state, incl. IconButton
  and the icon set, through the real paint paths (556 quads, 1 draw call).
- The reference is a Chromium transcription, not the live app: driving the
  live Skrive is Joe's to launch, not the session's to intrude on (the Stage 1
  call, restated), and the transcription uses the shipped CSS verbatim so the
  spec side is exact. WebKit-vs-Chromium rendering differs marginally;
  disclosed as always.

**The text delta, quantified** (mean ink over matching regions, lab vs
Chromium on identical font files, anchored to the card edge):
- Inter Medium 13.5px row label: **−0.5%** ink; Regular 12.5px desc:
  **−0.1%** — statistically nothing. The dark-pixel fraction runs slightly
  *higher* on the lab side at equal ink (0.030 vs 0.026): same total
  coverage, more of it at full contrast — the "hair lighter and slightly
  crisper" Stage 2 saw, now as a number.
- Iowan Old Style Bold 25px title: **−6.2%** ink — the lab renders the serif
  visibly lighter in a direct A/B (Chromium's gamma-aware blending thickens
  dark-on-light text, and it shows most at display sizes). Not noticeable in
  isolation; findable in the magnified crop.
- The segment-strip region read −11.8%, but that number mixes control-fill
  geometry (track/thumb pixels) with text and is not a text metric; the
  label-only crops above are the honest ones.

**Measurements (macOS daily driver, ReleaseFast, 1200x800 @ 2x, via
`--bench`).** Load-independent invariants first, as always:
- **Every scene: 1 draw call**, including the new benchmark scene (350 quads
  — five-option segmented, three toggles, four buttons, three icon buttons,
  serif title) and the expanded showcase (556 quads). The `flush()` seam is
  *still* unused: shapes, glyphs from five faces, and icon geometry all share
  the single batch.
- **Frame-on-demand holds everywhere**: 0 presents over 15s in all four idle
  phases; the kick-animation phase repaints 10 frames during the settle
  window and then 0 for 15s. The hover animation obeys the same discipline
  (it retargets during the build, so the dirty flag decision stays after the
  build — nothing new to trap).
- benchmark scene build 380us avg (between `settings` 585us/394 quads and
  `buttons` 163us/114 quads — still tracking quad count, not layout depth,
  with ~8 boxes resolved per frame plus a TTC face in play).
- Carried baselines re-confirmed at the 60Hz cadence this run held: stress
  16.61ms / shadows 23.35 / small 16.66 / toast 16.67 / settings 16.34 /
  text-wall 17.19 / buttons 16.82 — quad counts identical to Stage 4. One
  artifact: the shadows phase logged a 12ms encode *average* (its frame times
  are normal and match Stages 1–4); ambient-load contamination of the CPU
  span, of the family Stage 3 documented. Environmental caveats otherwise
  unchanged.
- Atlas after everything: **1024², 236 glyphs, 9.6%, 0 growth** — two new
  Inter weights plus a serif Bold cost 11 glyphs, because only the strings
  actually drawn rasterize. The icons cost zero (pure geometry).
- Idle CPU unchanged (~1.2%, the Stage 0 display-link constant).

**How it feels — the three legs, and what remains Joe's.**
1. *Mechanics*: 33/33 headless tests still pass untouched — the restyle moved
   no behaviour. IconButton rides the same `interact()` machinery the tests
   pin.
2. *Visuals*: the showcase + benchmark screenshots above, through the real
   paint paths; hover states now photographed at their settled `hover_t = 1`.
3. *Tactile*: unverifiable from the agent shell, as every stage has said
   plainly. **Owed to Joe at the keyboard, and this stage is the natural
   collection point**: the Stage 3 button tactile pass was never done (Stage
   4's toggle/segmented pass was), and the new hover fades, the 11.4px button
   labels, and the five-option segmented all deserve a hand on them. Keys `7`
   (buttons) and `9` (the benchmark section, live controls throughout,
   `Check for updates…` and the pin pop the toast). One known motion-quality
   divergence to feel for: the shipped segmented thumb is an *underdamped
   spring* (stiffness 520, damping 38 — it overshoots by design); the lab's
   exponential decay cannot overshoot. Same duration family, different
   character at the end of travel.

**Deliberate divergences kept (logged, not silent).**
- The lab keeps its distinct pressed states (shipped Button has no `:active`
  rule) and the bare default's hover wash — the Stage 3 calls, both arguably
  in the lab's favour, both visible in the showcase.
- The toggle's second inset rim layer (1.5px blurred top shadow, white top
  highlight when on) stays dropped: **the SDF shader still draws no inset
  blur.** The carried Stage 4 debt is hereby recorded as a renderer gap
  rather than implemented — at 23px it is invisible in the side-by-side, and
  Stage 5's budget went to fidelity that shows. The on/off rim *colours* now
  interpolate per the CSS, which the old single-colour border didn't.
- Inter Light was vendored per the stage brief but is unused: the kit's
  fourth weight is 450 (the toast eyebrow), which has no static file, and
  Regular remains the closest honest stand-in. Four faces ship in assets/;
  three draw.

**What fought back.**
- Zig 0.16's Io migration reaching the filesystem (above) — the only real
  code fight of the session.
- `screencapture` returned a **222x154 window-proxy thumbnail** instead of
  the window once, silently — a new failure mode for the capture bag: the
  window was mid-settle after a relaunch. The fix was the existing lesson
  (frontmost + wait longer), plus a new rule: *check the capture's pixel
  dimensions before using it*.
- Playwright composites screenshotted before multi-megabyte data-URI images
  finished decoding, producing a soft lab panel; `img.decode()` await fixed
  it. Same genus as the thumbnail: verify the artifact, not the exit code.
- The 11px line-box miss (above) — caught by measuring both images rather
  than trusting the eyeball, which is the whole method of this stage.

**Exit criteria.**
- *Side-by-side exists, labelled, both typeface flavours distinguished:*
  **pass** — product-honest and rasterizer-isolating sheets, flavour stated
  on every panel.
- *A stranger sorting the two would hesitate on everything except text
  rendering quality:* **pass, and stronger than the criterion asked** — at
  kit scale the text needs the 3x crops to sort (the serif's −6.2% ink is
  the tell; the UI sizes are −0.5% and below), and the geometry lands within
  a pixel once line boxes were modelled. The honest tells that remain:
  overall type colour a hair lighter, the segmented thumb's missing
  overshoot in motion, and the pin icon under magnification.
- *Verdict entry written, all five §8 questions answered, accessibility
  named plainly:* **pass** — below.
- *Cost accounting with real numbers:* **pass** — below.
- *`--bench` clean end to end; frame-on-demand holds (0 idle presents
  including post-settle); 1 draw call:* **pass**, all measured this session.
- *Isolation:* **pass** — repo-wide grep finds `zig-ui` only under `labs/`
  plus this log and the graduation checklist; `bun run typecheck` untouched;
  `rm -rf labs/` still breaks nothing.

**Cost accounting (the answer to "what would it actually take").**
- **Sessions:** 6, one per stage: 2026-07-07, 07-09, 07-13, 07-16, 07-24,
  07-31. The log records dates, not durations; against the plan's 2–4 hour
  session envelope that is **12–24 wall-clock hours, best estimate ~18**,
  spread over 24 days of off-occasions.
- **Code:** 4,328 lines of hand-written Zig in `src/` (excluding the
  1,218-line generated shader artifact), + 147 lines of GLSL shader source,
  + 99 lines of build script ≈ **4,574 authored lines**. Of that, roughly a
  third is `main.zig` (scenes, bench harness, plumbing) — the reusable
  substrate + kit is ~3,000 lines. 33 headless tests.
- **Dependencies: one.** sokol-zig (pinned by hash), with sokol-shdc as a
  build-time tool behind an explicit step, stb_truetype as a vendored
  single header carrying one 15-line local patch, and four OFL font files.
  Nothing else.
- **What that bought:** window → single-draw-call SDF renderer → atlas text
  with five faces → immediate-mode identity/input → flexbox-lite layout →
  animation store → four widgets + icons at shipped-spec fidelity, measured
  rather than asserted.
- **The scaling honesty:** a component kit is the *demo-able* 10%. The
  number above prices the substrate and the kit; it does not price text
  editing, scrolling, IME, accessibility, or the long tail below.

---

## Stage 5 verdict

The plan's §8 questions, answered in order, then the outcome.

**1. Feel ceiling — can hand-drawn widgets match the shipped kit's feel?**
At kit scale, **yes, and in places it exceeds it.** Input latency is
structurally minimal: hover, press, and release read the same frame's hit
test, every event repaints that frame, and there is no framework queue
between the OS event and the pixel — a property the web stack cannot have by
construction. The lab has real pressed states where the shipped CSS has
none. Hover now fades on the shipped 110ms curve; focus rings are
spec-exact; the toggle's press-stretch and retargetable mid-flight reversals
are there. Two honest gaps: the segmented thumb's spring overshoot (the
store is exponential decay; a spring integrator is a bounded addition nobody
needed until now), and the tactile leg of this stage — the button pass Stage
3 owed — still needs Joe's hand at the keyboard, because that is the one
thing this harness cannot feel. Stage 4's toggle pass ("runs well, nothing
changed") is the precedent that the design's latency claims survive contact.

**2. The text tax — how far below WebKit is lab-tier text?** Far smaller
than feared at 2x, and mostly *not where expected*. On identical font files
the UI sizes measure within half a percent of Chromium's ink; the serif
display size runs 6% light; 1x remains visibly rough (unhinted stems — the
known, accepted lab-tier boundary). The genuinely expensive discovery is
that the tax is **semantics, not rasterization**: rem resolution, CSS line
boxes, half-leading, font matching against a system collection — each had to
be reimplemented by hand to get within a pixel of the reference, and each is
a place a hand-drawn app can silently diverge from every design spec written
in CSS terms. stb draws the glyphs fine; *being a browser about text* is the
part that costs. Product-tier (CoreText + shaping) remains unpriced by this
lab and would be its own multi-stage arc, exactly as plan 4.3 said.

**3. Velocity — hours per widget once the substrate existed?** High and
still improving. Stage 5 alone, one session: the full token transcription,
a four-widget restyle, IconButton plus three icons (~200 lines total), a
runtime TTC loader, and a spec-exact benchmark scene. IconButton cost
perhaps an hour end to end. The substrate (Stages 0–2, ~10 hours) is paid
once; widgets are now cheap; *fidelity* is the recurring cost — every
component wants its measured spec, its states showcased, and its mechanics
pinned headless, because there is no inspector and no browser to catch
drift. Call it: substrate ~10h, then roughly a widget per hour at
shipped-spec quality.

**4. Joy.** From inside the sessions: the substrate stages (the SDF shader,
the kerning excavation, the layout idiom fight) were discovery; Stage 5 was
transcription with three genuinely delightful finds in it (the rem trap, the
weight-400 primary button, the line-box lesson — all things now known about
the *product*, not just the lab). The energy curve suggests the lab's joy
lives below the widget layer, in the renderer and text strata — worth
knowing if a continuation is ever weighed. But this question belongs to the
owner: five of six sessions were model-run with Joe closing the tactile
loops, and his read of whether this was fun is the one that counts. Flagged,
not answered.

**5. The missing 90%.** What a real Skrive frontend would still need, and
the kit does not touch: **text editing** — the entire block surface: caret,
selection, IME composition, undo, the things the bespoke editor spent
months on *inside* an engine that already did text; **scrolling and
clipping** — never built; the batcher's flush()/scissor seam has never once
been exercised; **popovers and overlay arbitration** — the Stage 3 hot-ID
seam, still theoretical; **dark theme**; **Windows beyond a cross-compile
that has never been run**; rotated geometry, inset blur, gamma-aware
blending, springs — each small, each real, each currently absent. And above
all of it: **accessibility. A hand-drawn UI starts at zero — no VoiceOver,
no accessibility tree, no system text scaling, no reduced-motion
inheritance (the shipped kit honours `prefers-reduced-motion`; the lab does
not even have the setting). WebKit gives Skrive all of this nearly free.
For a shipped writing app this is close to disqualifying on its own, and no
amount of rendering fidelity earned above changes that.** The five §8
words stand as written.

**Outcome: park it.** The terminal question — how far up the ladder can
occasional sessions climb, and does the top feel like Skrive — is answered:
six sessions, ~4,600 lines, one dependency, and the hand-drawn kit sits
next to the shipped one closely enough that the differences need
magnification or motion to name. That is the education banked, and it is
real: the SDF vocabulary, the immediate-mode identity scheme, the
frame-on-demand discipline, the true shape of the text problem, and a
sharpened respect for what the web stack does silently. The same accounting
says the remaining 90% is not six more sessions, it is a different project
— and the accessibility line item disqualifies the destination, not just
the schedule. The hard no on replacing Skrive's frontend stands, unmoved by
how good the screenshots look; nothing here argues for reopening it through
the plan's separate-conversation gate. If the lab ever gets a casual
seventh session, the two threads with standalone pull are the CoreText arc
(pricing product-tier text for its own sake) and running the Windows .exe
out of curiosity — neither is scheduled, neither is owed. The log closes
green: every scene one draw call, idle at zero presents, and a component
kit that would make a stranger hesitate. Question asked, question answered.

---

## 2026-08-05 — Stage 6: the accessibility spike — a diffed projection makes the window visible to VoiceOver

**Branch:** `joe/skr-233-zig-ui-lab-hand-drawn-interface-research`
(recreated off `main` at `a5f1704` — the Stage 5 branch had been merged and
deleted). **Commit:** `ede1dcd` (code); log + artifacts follow in the next
commit.

**The frame.** Stage 5 closed with "park it," and its sharpest line item was
accessibility: a hand-drawn UI starts at zero, and for a shipped writing app
that is close to disqualifying on its own. Joe chose the plan's other
sanctioned outcome — continue, aimed at the standalone public-library slot in
the labs OSS plan, not the app — and Part II of the planning doc opens with
the two framings that bound every stage of it: the hard no on replacing
Skrive's frontend remains in force, and nothing here argues otherwise. Stage
6 exists to convert the disqualifying unknown into a priced known: what does
it actually take to make an immediate-mode, hand-drawn Zig UI visible to
VoiceOver? Priced, partial, or impossible were all acceptable answers. **The
answer is: priced, and the price is 647 lines.**

**Toolchain.** All pins unchanged: Zig 0.16.0, sokol-zig `54776d6`, sokol-shdc
`87a6914`. **No new dependency** — the bridge links the system objc runtime
(`-lobjc`; AppKit was already there through sokol's Cocoa link) and hand-rolls
its msgSend bindings after reading mitchellh/zig-objc for the calling
conventions, per the plan's read-don't-import instruction. On arm64 the whole
convention is one sentence: `objc_msgSend` is the single entry point for every
return type, and you cast it to the exact C signature of the call you are
making. (x86_64 would need the _stret/_fpret variant dance; noted, not built —
the lab's daily driver and the eventual library's floor are both arm64.)

**Session-start regression.** Branch cut clean: 33/33 tests, and a full
`--bench` with every scene at 1 draw call, 0 presents in all four idle phases,
atlas census identical to Stage 5 (1024², 236 glyphs, 9.6%, 0 growth). This
run held 120Hz on the light scenes; the settle window's 19 presents is Stage
4's same 150ms transition sampled at 120Hz instead of 60.

**What was built — the architecture is Part II 11.1's, verbatim.**
- `ui/ax.zig` (239 lines, pure Zig, zero objc) — the projection's data model
  and diff. Widgets already registered with the Context every frame (the
  focusables list, since Stage 3); Stage 6 widens that registration to carry
  role / label / value / rect / disabled. A `Projection` retains last frame's
  nodes and emits appear / update / disappear ops with per-field change
  masks, plus an order-changed flag when membership or sequence moves
  (registration order is draw order is VoiceOver's reading order). Runs only
  on frames that rendered anyway; an idle window produces no registrations,
  no diff, and no work — the retained tree simply persists for VoiceOver to
  read.
- `ui/ax_bridge.zig` (408 lines, the objc box, opened and scoped) — a thin
  applier for the diff: a retained map of elements keyed by widget ID,
  created on appear, mutated on change, torn down on disappear. One runtime
  subclass (`ZigUIAXElement` : NSAccessibilityElement) carries the widget ID
  in an ivar read via `ivar_getOffset`, and overrides
  `accessibilityPerformPress`/`Pick` to forward that ID as synthetic input.
  Elements hang off sokol's content view (`sapp.macosGetWindow()` →
  `contentView`); frames go through `setAccessibilityFrameInParentSpace:`
  with the y-flip (AppKit view space is y-up), which makes window *moves*
  free — AppKit re-derives screen coordinates from the parent chain on
  demand. Notifications only on real diffs: AXValueChanged per changed
  element, AXLayoutChanged once per apply when order or rects moved,
  AXUIElementDestroyed before teardown. No autorelease pool is assumed
  anywhere: everything is alloc/init +1 and explicitly released after the
  retaining setter takes it.
- Roles per the spec: Button and IconButton project as AXButton, the toggle
  as AXCheckBox with a 0/1 value, the segmented control as AXRadioGroup with
  one AXRadioButton child per option (children parented to the group element,
  frames relative to its rect). The toggle/segmented take the settings-row
  label as their AX label — the shipped aria-label pattern, transcribed. The
  stretch goal landed too: pane title, sub, section caps, and row
  labels/descs register as AXStaticText, so the VO walk reads the pane like
  the shipped settings page rather than bare controls in silence.
- Backflow: `ax_activate_id` in the Input snapshot. A VO press lands in the
  bridge's callback (main run loop, between frames), marks the frame dirty
  exactly as a mouse event does, and next frame `interact()` fires on ID
  match — inside the `!disabled` guard, no focus required (the AX cursor is
  its own point of regard; stealing keyboard focus would fight the user).
  Segmented options fire by their existing per-option interact IDs, so an AX
  pick runs the identical selection path a click does.
- Widget signatures: `ButtonOpts`/`ToggleOpts`/`SegmentedOpts`/
  `IconButtonOpts` gained `ax_label`; `segmentedInteract` gained the option
  labels (its registration needs them) — the session's one signature change,
  carried through the four existing tests, same as Stage 4's precedent.

**Tests: 49/49** (33 carried + 16 new). The new ones pin: the diff
transitions (first-frame appears, no-op identical frames, value flip = one
update with only the value bit, rect move, disappear carrying the retained
copy, reorder flagging order-changed without ops, scene switch), the
registrations (checkbox value follows the flip and is declared post-flip;
radio group + children with the selected option at 1; draw order in, same
order out, cleared per frame), and the equivalence contract: **an AX
activation is indistinguishable from Space on the focused widget** (same
fired, no armed state left behind), needs no focus and moves none, reaches
non-focusable segmented options, and is inert on a disabled widget.

**Verification — the three legs of Part II 11.2, and where each landed.**
1. *Headless:* the 49 tests above; the diff and backflow never touch objc.
2. *The dump — closed, and further than the spec asked.* The agent shell
   turned out to hold Accessibility trust (`AXIsProcessTrusted` → true), so
   the dump was run in-session rather than owed: `stage6-ax-dump.swift`
   (committed next to its output so later stages can re-run it) walks the
   lab's tree via `AXUIElementCreateApplication(pid)`. The output
   (`stage6-ax-dump.txt`) shows every control in the benchmark scene with
   correct role, label, value, and enabled state, and **pixel-exact screen
   frames** — the title's AX frame lands at window y 44 + titlebar 32 +
   `.settings-col` padding 44 = 120.0, to the pixel; the y-flip math survived
   contact on the first dump. Beyond enumeration, the *backflow* was driven
   end to end from outside the process, the same route VoiceOver takes:
   `AXUIElementPerformAction(AXPress)` on the "Check spelling" AXCheckBox
   flipped the real toggle (value 0 → 1 in the re-dump — through performPress
   → synthetic input → interact() → render → re-registration → diff →
   setValue); a press on the "Wide" AXRadioButton moved the selection
   (Normal 1 → 0, Wide 0 → 1, and the option frames shifted the fraction of
   a pixel the SemiBold active-weight resize causes — the Stage 5 finding,
   now visible from outside the process through rect-update ops); and an
   `AXObserver` subscribed to the checkbox received a live **AXValueChanged**
   during a press, so the notifications demonstrably post, not just appear in
   source.
3. *The VoiceOver walk — owed to Joe, and the stage does not close without
   it,* same as every tactile pass. VoiceOver cannot be driven from the agent
   shell and I did not try. The walk: `./zig-out/bin/zig-ui --card`, ⌘F5,
   VO-arrows through the pane (title, prose, rows, controls, in reading
   order), VO-Space a toggle and watch it flip on screen, arrow through the
   Line measure radio group, and — the one case the harness could not
   arrange — park the VO cursor on a control, sit still, and confirm the
   window stays quiet. The tree, actions, and notifications VoiceOver
   consumes are all externally verified above; what remains is how the walk
   *sounds*.

**Frame-on-demand: holds, now measured under adversarial load.** The exit
criterion asked for 0 idle presents with the bridge attached; the run did
more: a loop hammered the process with **25 full AX-tree walks during the
bench** — every attribute of every element, repeatedly, including through the
idle phases — and all four idle phases still reported **0 presents in 15s**.
"AX reads never dirty a frame" is a measured number now, not a design
argument. (Reads answer from the retained elements' stored properties on the
run loop; the render path is not involved, by construction — but construction
claims are what Stage 2's HUD trap taught this lab to distrust, hence the
hammer.) The kick-animation phase still settles (17 presents at 120Hz, then
0), with its toggle flip flowing through a value diff and an AXValueChanged
post mid-phase, observers or none. Every scene: **1 draw call** — AX adds
zero draw cost by construction (it draws nothing), and zero atlas cost (236
glyphs, 9.6%, 0 growth — census identical to Stage 5). Carried baselines
re-confirmed at 120Hz within noise of the session-start run.

**What fought back — honestly, almost nothing, and that is the finding.**
- The objc interop cost **two compile errors total**: a name collision
  (`sels.content_view` vs the file-scope `content_view`, Zig's ambiguous-
  reference rule) and an anonymous-struct literal refusing to coerce to
  `NSRect` through an `anytype` tuple (fixed by typing the local). The
  msgSend cast-to-exact-signature pattern worked on the first build. The
  runtime subclass, the ivar offset, the parent-space frames, the
  notifications: all worked on the first dump. Reading zig-objc first (as
  the plan ordered) is why — the conventions were understood before any
  binding was written.
- The Windows cross-compile was found **already broken — by Stage 5**, not
  by this stage: `loadSystemSerif`'s `posix.openat(AT.FDCWD, ...)` does not
  exist on the Windows std surface, and Stage 5 never re-ran the smoke build
  after adding it. One comptime gate fixes it (the serif is a macOS system
  file; other targets take the Inter SemiBold fallback path that already
  existed), and the .exe builds again — which also proved the AX bridge's
  own comptime gate keeps the objc file entirely out of non-macOS analysis.
  Lesson, recorded: the cross-compile is a one-command gate and should be
  run in any stage that touches platform-adjacent std surface.
- TCC did not fight at all: the agent shell already held Accessibility
  trust, so the dump leg that Part II 11.2 flagged as possibly Joe's turned
  out runnable in-session. (The helpers still print NOT-TRUSTED and exit 2
  if a future shell lacks it, with the one-command run handed over.)

**Would the projection scale past a kit? The honest paragraph.** The
architecture's cost structure is what makes it credible: the diff is O(n)
compares per rendered frame over nodes the widgets were already registering
for focus order, the bridge's per-op work is a handful of property sets, and
idle costs nothing at all — none of that changes shape at a hundred nodes or
a thousand. What does change shape past a kit: (1) *labels* — the lab's are
all static literals, so the retained snapshot can hold slices; dynamic AX
labels (a document title, a row count) need copying into owned storage, a
real but bounded change to `ax.Node`. (2) *Hierarchy* — one level (group →
option) is hand-rolled here with a parent field; a scrollable list or a tree
view wants real containment, which is the same composite-widget pressure
Stage 4's focusable finding named — the recurring shape is "one focus
target, many hit targets, now many AX children," and a retained tree gets
it free where this design pays per level. (3) *Text editing* — AXTextArea
with selection ranges, line ranges, and marked text is a different animal
from value-carrying controls, and nothing here prices it; it is the same
"the rules around text, not the rasterizer" wall Stage 5 named, wearing an
AX badge. (4) Windows would start from zero: UIA is a different protocol
with a different projection, and none of the objc plumbing transfers —
finding-level note, as the plan scoped. For the *library* slot this
continuation aims at — a widget kit with focus, actions, values, and static
text — the projection is not a partial story; it is the whole story, and it
took one session.

**Artifacts** in `docs/zig-ui-lab/`: `stage6-ax-dump.txt` (the tree, default
state — every control with roles/labels/values/frames) and
`stage6-ax-dump.swift` (the walker, committed beside its output so Stages
7-9 can re-verify with one command; the press/observe helpers used for the
backflow and notification proofs remain scratchpad-tier).

**Exit criteria.**
- *Dump shows correct roles/labels/values/frames for every benchmark-scene
  control:* **pass** — and enabled state, and pixel-exact frames, and
  externally driven activation on top.
- *Headless tests cover registration, diff transitions, and AX-activation
  equivalence; full suite passes:* **pass** — 49/49 (33 carried + 16 new).
- *VoiceOver walk:* **owed to Joe** — recorded here as the stage's open leg;
  the stage does not close without it (Stage 4's precedent). Everything the
  walk consumes is verified from outside; the walk itself is a human's.
- *Frame-on-demand with the bridge attached; 1 draw call:* **pass, measured
  under a 25-dump read hammer** — 0 presents in every idle phase, every
  scene 1 draw call, atlas untouched.
- *Isolation:* **pass** — repo-wide grep finds `zig-ui` only under `labs/`
  plus the two lab docs; `bun run typecheck` untouched; `rm -rf labs/`
  still breaks nothing.
- *The log prices the answer:* **pass** — this entry.

**The priced answer.** Accessibility for an immediate-mode, hand-drawn Zig
UI is a **bounded engineering cost, not a wall**: 239 lines of pure-Zig
projection + 408 lines of objc bridge + ~90 lines of registration and glue
across context/widgets/main — one session, no new dependency, no
architectural strain (the projection is the focusables list grown up), and
the standing invariants (1 draw call, 0 idle presents) did not move. The
Stage 5 verdict's "close to disqualifying" line item, for the library's
scope, is now a line item with a number on it. What that does to the
sequence: Stages 7-9 proceed as planned — nothing in this result argues for
resequencing, and two of its findings feed directly forward (Stage 7's
reduced-motion obligation now has an AX story to be consistent with; Stage
8's scroll containers will meet finding (2), hierarchy, head on — the first
real test of whether the flat-with-parent-field projection needs to become
a tree). The VoiceOver walk is Joe's, and the stage stays open until his
hands say what the tree already shows.
