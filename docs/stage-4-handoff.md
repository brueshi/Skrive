# Stage 4 handoff — Zig shell macOS feature parity

A self-contained starting prompt for a fresh session executing Stage 4 of the
Zig shell experiment. Stages 0-3 are complete and merged to `main`. Stage 4
makes the macOS Zig build feature-indistinguishable from the Electron build
(updater excepted — that is Stage 6).

## Read first (canonical, in order)

- `docs/Zig shell master plan.md` — the Stage 4 section (4.0-4.4) is the spec; it wins over inference.
- `docs/zig-shell-log.md` — tail it; the Stage 2/3 entries carry hard-won conventions and gotchas.
- `shell-zig/core/` — the existing Zig core (dispatch/fs/project/persistence/watcher/errors/skrive_core). Match its style, error-mapping, and arena/`Io` patterns.

## Sub-stages (each ends green, gets its own conventional commit)

**4.0 — Native app-shell parity. DO THIS FIRST — it gates real dogfooding.**
Electron supplies standard-app behavior for free that the bespoke Swift host
must implement; until it exists the Zig build is a spike, not livable. Dogfooding
runs *throughout* Stage 4, so this comes before diff/history. Work (all host-only
Swift in `shell-zig/macos/`, zero `app/`/core changes):
- Full standard macOS menu bar replicating Electron's *default* menu via standard
  AppKit first-responder selectors — Edit (`undo:`/`redo:`/`cut:`/`copy:`/`paste:`/`selectAll:`),
  View (reload, `toggleFullScreen:`, dev-gated DevTools), Window (`performMiniaturize:` Cmd-M,
  `performZoom:`, `performClose:` Cmd-W), Help. **Scope guard: DEFAULT menu only — no
  app-specific File items** (New/Open/Save live in the renderer's command palette, already work).
- External-link / window-open policy in `WKNavigationDelegate` (`decidePolicyFor` + `createWebViewWith`):
  route `target=_blank`/`window.open`/off-origin through the `links:openExternal` allowlist; block the
  main frame leaving `skrive-app://`. Parity with Electron's `setWindowOpenHandler`; also a security boundary.
- `WKWebView.isInspectable = true` (dev-gated) — the primary renderer-debugging tool.
- Pre-paint window background corrected to `#161719`/`#e7e8ea` (host currently paints stale `#1a1a1a`/`#fefcf7`).
- File associations + `skrive://` in `Info.plist` (`CFBundleDocumentTypes` `.md`/`.markdown`, `CFBundleURLTypes`)
  plus `application(_:open:)`/`openURLs:` handling: opening a `.md` opens its containing folder as the project
  and focuses the file. The one item that coordinates with the renderer (a deep-link/open verb) — keep it behind the contract.
- Done when: standard editing shortcuts work in editor + dialogs; Cmd-W/Cmd-M/zoom/fullscreen work;
  external links open in the browser without disturbing the app; Web Inspector opens; no stale launch flash;
  double-clicking a `.md` opens it in the Zig build.

**4.1 — Diff via Rust staticlib.** `native/diff` is currently `crate-type=["cdylib"]` (napi only).
ADD a `staticlib` C-ABI target (new `src/capi.rs`; KEEP the napi surface for Electron) — FFI shape
designed in `docs/Zig diff experiment.md` §FFI surface (compute -> opaque handle -> op iteration -> free).
`build.zig` builds/links it; `core/src/diff.zig` wraps it into `diff:computeDiff`/`computeLineDiff`.
Done when: `fixtures/diff.jsonl` (from `native/diff/__test__/fixtures.test.ts` cases) replays green; DiffView identical.

**4.2 — History: checkpoints.** Port `shell/src/lib/checkpoint.ts` to `core/src/checkpoint.zig` —
BYTE-COMPATIBLE storage layout (`docs/checkpoint-storage.md`), same auto-interval, content-hash dedup,
retention caps. Auto-checkpoint trigger moves with it (`fs:writeFile` on markup, as `shell/src/ipc/fs.ts`).
Done when: a checkpoint store written by Electron lists/reads in the Zig build (round-trip), fixtures green.

**4.3 — History: git.** `core/src/git_history.zig` spawns system `git` with the same argv/parsing/mode
detection as `shell/src/lib/git-history.ts`. Done when: history fixtures green vs a fixture repo.

**4.4 — Host completions (residual polish + closing sweep).** Dock-icon light/dark swap; verify
`persistence:revealUserData`. Done when: full side-by-side manual parity checklist green.

## Non-negotiable conventions (CLAUDE.md + the log)

- Branch `labs/zig-shell-stage-4-*` off main. One concern per commit. Conventional commits, sentence case,
  NO co-author trailer, no emojis. Per-sub-stage commits (matching Stages 2-3).
- The Electron build is the shipping product and must stay green: after any `app/`/`shared/` change run
  typecheck + the vitest suites. Stage 4 touches `app/`/`shared/` minimally.
- Parity is verified BOTH directions: `bun run parity:check` against the live Electron oracle AND
  `--exec ./shell-zig/core/zig-out/bin/fixture_main` against the core. `--exec` alone false-greens when a
  fixture drifts with the core. Regenerate with `bun run parity:gen` when adding commands.
- Byte-exact parity matters: SHA-256 hashes and checkpoint layout must be byte-identical to Electron's so a
  user can switch shells without losing history.
- [CONFIRM WITH JOE] before deleting/restructuring existing code or anything product-visible.

## Zig 0.16 + build gotchas (these cost real time in Stage 3 — internalize)

- Core pins Zig 0.16.x. IO model: fs ops take an `Io`; `std.Io.Mutex` (futex, real across threads),
  `std.Io.sleep(io, .fromMilliseconds(n), .awake)`, `std.c.getenv`, `std.mem.trimEnd`, `Dir.realPathFileAlloc`.
  `zig test` runs ALL transitively-reachable test blocks in parallel — use `std.testing.tmpDir` for unique dirs.
- TWO build-cache traps: (1) SwiftPM does NOT relink the host when only the Zig `.a` changes (untracked input,
  content-hashed sources); `touch` does NOT help. `build-macos.sh` now `rm`s the linked product to force a
  ~1s relink. (2) Zig's C cache may not invalidate an object when an included vendored header changes —
  `rm -rf core/.zig-cache` if a `vendor/` header edit doesn't take. LESSON: when a native change "has no
  effect," VERIFY the artifact contains it (bin-path binary mtime vs the `.a`, or a runtime/string marker)
  BEFORE re-debugging logic.
- For the Rust staticlib under an explicit `-Dtarget=...macos`, expect the same SDK/framework/sysroot plumbing
  the watcher needed (`build.zig` wires paths from `b.sysroot`; `build-macos.sh` passes `--sysroot "$(xcrun --show-sdk-path)"`).

## macOS build/run

- `shell-zig/build-macos.sh` assembles `shell-zig/macos/.build/Skrive.app`
  (renderer -> bridge -> zig lib -> swift host -> assemble). Launch via `open`; KILL stale instances first
  (`open` reuses a running instance, which masked stale builds in Stage 3). Shares the real app-data dir
  (`~/Library/Application Support/Skrive`) with Electron Skrive.
- A command becomes native by adding it to `NATIVE_COMMANDS` in `shell-zig/web/sample-data.ts`.
  diff/history are currently served from the mock there.

## Dogfooding lens — the dual editor surface on WebKit

Once 4.0 makes the app livable, use BOTH editor surfaces (CM6 Text / ProseMirror Rich) heavily on the Zig
build and log any WebKit-vs-Chromium divergence the identical editor code exposes: IME/composition/dead keys,
contenteditable selection/caret/undo, spellcheck/smart-quotes, font rendering on the Rich surface, large-doc
latency, split-pane sync. This is NOT a stage (the editor is pure shared `app/`); it is a dogfooding lens
whose home is the Stage 6.3 results memo and the Part VI graduation criterion "editor latency parity is
required." Each finding resolves either as a renderer fix (shipped to both shells) or, if WebKit genuinely
can't match Chromium, a logged substrate finding in the Gate 1.3 mold.

## Gates to close Stage 4

4.0 native-shell parity done (app livable); entire parity corpus green both directions; side-by-side manual
checklist green; dogfooding shows no architecture-class friction. Log a dated entry per session in
`docs/zig-shell-log.md`, and flag honest gaps (e.g. anything the request/response corpus can't cover) rather
than hiding them.

## Start

Read the three canonical docs, confirm `main` is current, then propose a Stage 4 plan (sub-stage order
starting with 4.0, what each touches, gates) and get sign-off before writing code.
