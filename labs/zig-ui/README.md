# zig-ui — hand-drawn interface research lab

This is an isolated research lab exploring what it takes to hand-draw a GPU
UI in Zig: sokol-zig as the platform layer (window, events, GPU surface),
everything above it — rect batching, SDF shape shading, glyph atlas text,
immediate-mode widgets — hand-rolled. The terminal question: climbing from a
blank window, how far up the ladder can occasional sessions get, and does a
hand-drawn recreation of Skrive's component kit feel like Skrive?

Where the ladder stands: the renderer (batcher, SDF shapes, glyph-atlas text)
is built, and an immediate-mode widget layer sits on top — `ui/context.zig`
(hot/active/focus identity, input, hit testing) and `ui/widgets.zig` (the
button, so far). One frame is still one draw call.

It exists because that question is worth answering empirically rather than by
intuition. It is not a port target, not a shell replacement, and not a
commitment: no Skrive feature will ever depend on this code, nothing outside
`labs/` references it, and `rm -rf labs/` breaks no Skrive build. The working
name `zig-ui` is deliberate; naming is tabled until the lab earns one.

The complete plan — decision record, stage ladder, exit criteria — lives in
`planning/zig-ui-lab.md` (disk-only, not committed). The running session log
is `docs/zig-ui-lab-log.md`. Build and run with `zig build run` from this
directory (Zig 0.16.0, matching `shell-zig/core`'s pin). `--continuous`
starts in continuous-render mode; space toggles it at runtime. Scene keys:
`1` demo, `2` toast taste test, `3`/`4` stress large/small, `5` settings,
`6` text wall, `7` buttons (live, interactive — Tab/Space/Enter and the
mouse), `8` button-state showcase. `zig build run -- --bench` runs the fixed
measurement schedule (keyboard ignored) and quits; `zig build test` runs the
widget state-machine unit tests headless. Shaders are authored in
`src/gfx/*.glsl` and compiled with `zig build shaders`; the generated
`.glsl.zig` artifacts are checked in, so ordinary builds never need
sokol-shdc.
