# Vendored: e-dant/watcher

A trimmed, in-repo copy of [e-dant/watcher](https://github.com/e-dant/watcher) —
the filesystem watcher chosen in `docs/Zig shell ecosystem survey.md` for its
pure-C ABI, FSEvents/ReadDirectoryChangesW backends, and first-class rename
pairing (`associated_path_name`).

## Provenance

- Upstream: https://github.com/e-dant/watcher
- Commit: `06f84a1314be18f5e697ebbf28c0fab2d17c9c39`
- License: MIT (see `LICENSE`)

## What is included, and why only this

The whole C++ watcher core is a single header-only file, so the vendored
surface is three files plus the license:

| File | Upstream path | Role |
|---|---|---|
| `include/wtr/watcher.hpp` | `include/wtr/watcher.hpp` | Header-only C++ core (FSEvents on macOS) |
| `include/wtr/watcher-c.h` | `watcher-c/include/wtr/watcher-c.h` | The pure-C ABI the Zig core links against |
| `src/watcher-c.cpp` | `watcher-c/src/watcher-c.cpp` | C-ABI shim over the C++ core (the one TU we compile) |

The two headers are flattened into one `include/wtr/` directory so the single
include path `vendor/watcher/include` resolves both of `watcher-c.cpp`'s
`#include "wtr/..."` lines. Nothing else from the upstream repo (build files,
the Go/Rust/Node/Python bindings, tooling) is needed or copied.

## Why vendored in-repo rather than fetched

Per the Stage 3 decision: an in-repo copy is offline, reproducible, explicit
about exactly what we compile, and keeps the experiment "one `git rm -r` from a
clean kill" — no build-time network fetch, no `build.zig.zon` dependency graph
for a three-file C library.

## Build integration

`build.zig` compiles `src/watcher-c.cpp` as C++17 into `libskrive_core`,
links libc++, and (on macOS) links the `CoreFoundation` and `CoreServices`
frameworks that FSEvents requires. The C ABI is wrapped in
`src/watcher.zig`.

## Updating

Re-copy the three files from a newer upstream commit, update the commit hash
above, and re-run the core tests. The C ABI (`wtr_watcher_open` /
`wtr_watcher_close` / `wtr_watcher_event`) is stable; a struct or signature
change there is the only thing that would touch `src/watcher.zig`.

## Local modifications

None. The files are byte-for-byte upstream. Keep it that way — if a fix is
needed, prefer upstreaming it and re-vendoring over patching here.
