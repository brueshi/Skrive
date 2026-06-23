# Zig Shell Log

Session log per the master plan's working rules: one dated entry per
session — what was attempted, what passed, what blocked. Spec
clarifications and decision data live here so later stages (and the
results memo) don't have to reconstruct them.

---

## 2026-06-11 — Stage 0.1: envelope and dispatcher in the Electron shell

**Branch:** `refactor/ipc-envelope-dispatch` (off `main`).

**What was done.**
- Envelope types, channel constants, and the closed error-code set added
  to `shared/src/ipc-contracts.ts`.
- New `shell/src/main/dispatch.ts`: pure (Electron-free) registry +
  `dispatch(envelope)` / `dispatchJson(json)`, `IpcError` for coded
  handler errors, and an injected event sink (`setEventSink`/`emitEvent`).
  Electron wiring lives in `main/index.ts`: one `skrive:invoke` handle,
  events broadcast on `skrive:event`.
- All `ipcMain.handle` registrations re-routed through `registerCommand`
  across `ipc/{fs,project,diff,search,history,persistence,links,updater}.ts`
  and `main/index.ts`. Watcher and updater events now go through
  `emitEvent`; the flush-before-quit event does too (the renderer's
  `app:flush-complete` ack stays a raw `ipcRenderer.send` until Stage 2
  formalizes the handshake).
- Preload rewritten as a thin Electron transport: builds envelopes, one
  event demux, exposes the unchanged `SkriveIpc` surface. No `app/`
  changes.
- New `shell/__test__/dispatch.test.ts` (14 tests): success round-trip,
  UNKNOWN_COMMAND, PAYLOAD_TOO_LARGE, malformed JSON, unknown top-level
  field, version/id/payload shape violations, INTERNAL and coded error
  mapping, duplicate registration, event envelope shape.

**Decisions and spec clarifications (Part I envelope spec is silent on
these; none contradict it).**
- Envelopes cross the Electron channel as JSON strings, not
  structured-clone objects. Exact parity with string-marshaled native
  bridges, the 32 MiB cap is enforceable without parsing, and the
  Stage 0.6 corpus replays identical bytes against both dispatchers.
- `BAD_ENVELOPE` added to the closed error-code set for malformed
  JSON / envelope-shape violations (the spec names no code for these).
  Also reserved now: `INVALID_PAYLOAD`, `NOT_FOUND`, `ALREADY_EXISTS`,
  `NO_PROJECT`, `IO_ERROR`, `GIT_ERROR`, `INTERNAL`.
- Error responses for unparseable requests (or invalid `id`) carry
  `id: 0`, since no valid id exists to echo.
- Results are always objects per spec, so scalar-returning commands got
  named result fields (`app:version` -> `{ version }`, `fs:writeFile` ->
  `{ hash }`, `project:openDialog` -> `{ path }`, nullable
  `project:getManifest` -> `{ current }`). Domain-object results
  (manifest, FileContent, UpdaterStatus, ...) stay flat, matching the
  plan's own `project:snapshot` shape.
- Persistence command names aligned to the target table now
  (`appState:load` -> `persistence:loadAppState`, etc.) so the corpus
  isn't churned at the Stage 0 contract freeze. `search:*`/`linkGraph:*`
  keep their names; they leave the shell in 0.4.
- `project:openDialog` parents on `BrowserWindow.getFocusedWindow()`
  instead of the requesting webContents — the dispatcher has no sender
  identity by design (native bridges don't either). Single-window app;
  no observable change.
- Handler validation throws were converted to coded `IpcError`s
  (INVALID_PAYLOAD / NO_PROJECT / ALREADY_EXISTS / PATH_ESCAPE) while
  every registration was being touched anyway; messages preserved.
  Nothing in `app/src` matches on error message text (verified by grep).

**Gates.** `bun run typecheck` clean; shell suites 120/120 (10 files);
app suites 297/297 (18 files); `bun run start:build` clean.

**Incident (caught by the manual app-runs check).** First launch died
with `window.skrive` undefined: the preload's new value imports from
the `@skrive/shared` barrel dragged in the frontmatter module, whose
externalized `yaml` import survived bundling as `require("yaml")` — and
a sandboxed preload can require nothing but `electron`, so the preload
died before exposing the bridge. The previous preload only imported
types (erased at compile), which is why this never bit before. Fix:
the preload imports envelope constants from
`shared/src/ipc-contracts.ts` directly; that module has zero runtime
imports by design and must stay that way. Standing rule for every
future host: the renderer-facing transport layer must not import the
shared barrel's value surface. Verified post-fix: the built preload's
only external require is `electron`. Manual app-runs re-check after the
fix: pending (Joe).

**Blocked.** Nothing.

---

## 2026-06-11 — Stage 0.2: transport abstraction

**Branch:** `refactor/ipc-envelope-dispatch` (continued; same session).
Stage 0.1 manual app-runs check green (Joe) before starting.

**What was done.**
- New `shared/src/bridge.ts`: `SkriveTransport` (`invoke` + `on`) and
  `createSkriveBridge(transport): SkriveIpc`. The full command-name /
  payload-shape / result-unwrap mapping moved out of the preload into
  the factory, so every future transport (native host bridge, web shim)
  inherits it tested. Zero runtime imports, same sandboxed-preload rule
  as `ipc-contracts.ts`.
- Preload reduced to framing only: envelope build/parse on
  `skrive:invoke`, one event demux on `skrive:event`, then
  `createSkriveBridge(transport)`.
- `shared/__test__/bridge.test.ts` (33 tests) exercises every namespace
  against `shared/__test__/mock-transport.ts` — the in-memory transport
  the plan names as the seed of the website embed's web shim. `shared`
  gained its own vitest setup (it had none).

**Decision: the flush ack became a command.** `app.flushComplete()` was
a bare `ipcRenderer.send` + `ipcMain.once` pair — inexpressible through
a transport that only has `invoke`/`on`, and renderer-to-shell traffic
is requests-only in the envelope model (events flow shell-to-renderer
only). It is now an `app:flushComplete` request, fire-and-forget from
the bridge; main installs a callback while a quit-flush is pending. The
Part I command table lists `flush-complete` under events (r-to-shell) —
log note for the contract freeze: it should move to the invoke column,
since the envelope has no renderer-to-shell event lane. Zig Stage 2.4
implements the same shape.

**Gates.** Typecheck clean; shared 33/33; shell 120/120; app 297/297;
`start:build` clean; preload bundle's only external require is
`electron`. Renderer untouched (`app/` has no diff).

**Blocked.** Nothing.

**Next.** Stage 0.3 — clipboard commands (`clipboard:writeRich` /
`writeText` / `readText` in contract + Electron shell; migrate
`app/src/components/editor/clipboard.ts` off `navigator.clipboard`).

**Post-session note (typing-lag report).** After the Stage 0.1/0.2
manual checks Joe reported slightly laggy typing in the dev build.
Investigated: nothing crosses IPC per keystroke (typing only resets
debounce timers; saves/refreshes fire on pauses), and a measured bound
on the JSON-envelope overhead is 0.02 ms per 20 KB document save and
0.53 ms per 500-file manifest refresh, full round trip — mechanically
incapable of felt lag. Attributed to dev mode (unminified React in
StrictMode with double-invoked effects, detached DevTools, Vite serving)
versus the packaged 1.0.3 daily driver. Standing rule for Stage 0.7 and
6.3 baselines: perf comparisons are packaged-vs-packaged only.

---

## 2026-06-11 — Stage 0.3: clipboard commands

**Branch:** `refactor/ipc-envelope-dispatch` (continued).

**What was done.**
- Contract: `clipboard` namespace added to `SkriveIpc` —
  `writeRich(html, text)`, `writeText(text)`, `readText()`.
- Shell: `shell/src/ipc/clipboard.ts` implements all three over
  Electron's clipboard module (`clipboard.write({ text, html })` writes
  both flavors atomically).
- Bridge: namespace mapping added (`readText` unwraps `{ text }`),
  with three new bridge tests (shared suite now 36).
- Renderer: new `app/src/lib/clipboard/systemClipboard.ts` —
  bridge-primary, `navigator.clipboard` only when `window.skrive` is
  absent (bare-browser embed case). `Preview.tsx`'s copy-document
  button migrated; its rich-then-plain degradation chain preserved.

**Scope finding.** The audit's migration target
(`app/src/components/editor/clipboard.ts`) needed no changes: editor
copy/cut/paste ride DOM ClipboardEvent/clipboardData, which work in any
webview without a secure context. The preview's copy button was the
only `navigator.clipboard` consumer in `app/src` (verified by grep —
the 0.3 done-criterion's "no unconditional usage" now holds; the sole
remaining reference is the guarded fallback in `systemClipboard.ts`).
`readText` currently has no renderer consumer; it ships for contract
completeness per the plan's table.

**Gates.** Typecheck clean; shared 36/36; shell 120/120; app 297/297;
build clean; preload external requires still `electron` only. Manual
check pending (Joe): rich copy from preview pastes with formatting into
a rich target (e.g. Pages/Mail) and as plain markdown into a plain one.

**Blocked.** Nothing.

**Next.** Stage 0.4 — move text analysis to the renderer worker; add
`project:snapshot`. The largest Stage 0 item; includes a
`[CONFIRM WITH JOE]` gate before deleting the old shell handlers.

---

## 2026-06-11 — Stage 0.4 (steps 1-5): snapshot + project-model worker

**Branch:** `refactor/ipc-envelope-dispatch` (continued). Four commits:
snapshot command; toml parser to shared; project-model worker; store
re-point.

**What was done.**
- `project:snapshot` (contract + shell + bridge): one batched response,
  every project file — bodies for markdown and `.skrive.toml`, `body:
  null` for assets. New pure scan module `shell/src/lib/snapshot.ts`
  shares the walk with the legacy scan; tested against a fixture tree
  (the same shapes will gate the Zig core in Stage 2.3). Shape
  extension: `sizeBytes` added per file (stat already in hand,
  `FileEntry` needs it).
- `parseSkriveToml` moved to `shared/src/skrive-toml-parse.ts`
  (smol-toml dep moved to shared): the renderer worker derives config
  from the snapshot; the shell keeps reading only its own slice (the
  checkpoint caps) — matching the Zig plan, where the core parses toml
  for checkpoint caps and the renderer owns config.
- `app/src/lib/project-model/`: link-graph extract/graph copied from
  the shell verbatim (shell copies remain until the deletion step);
  `model.ts` derives manifest + schema + config, answers
  backlinks/outgoing/dead-links/orphans, search (ported
  `search.ts` semantics), previewRename, and a pure `renamePlan`
  (worker computes rewrites from in-memory bodies; the store applies
  them via `fs:writeFile` then `fs:rename`, per the plan's order — the
  disk-mutating half of the old shell rename module). Manifest-version
  semantics ported intact (bump only on path-set/frontmatter/config
  changes).
- Worker protocol decision: NO unsolicited manifest pushes. Every
  mutation is store-initiated, so the updated manifest rides in the
  mutation's result and the client delivers it to subscribers before
  resolving — `createFile -> openTab` style flows can rely on the
  manifest being current after an awaited upsert. Removes a whole
  class of ordering races.
- Store re-pointed: open = snapshot + worker init; watcher events
  coalesce into a debounced read+upsert sync; saves upsert the worker
  (FIFO message order makes fire-and-forget safe); lint inputs
  (dead links/orphans) come from the worker; BacklinksPanel /
  RenameModal / SearchModal use the worker client. `refreshManifest`
  and its `project:getManifest` polling are gone from the renderer.
- Shell watcher now FORWARDS `.skrive.toml` change events (it used to
  swallow them and rescan); the shell's own response shrinks to
  re-reading the checkpoint caps. Toml live-reload thus flows through
  the worker like any other change.

**Deviations from "move, don't rewrite" (logged honestly).**
- The rename suite couldn't move unchanged: the shell version is
  disk-coupled, the worker version is pure planning. The case content
  (relative-path rewrites, wiki stems, referenceUse exclusion, error
  shapes) was carried into `app/__test__/project-model/model.test.ts`.
- `previewRename`'s targetExists check drops the shell's extra
  disk-existence probe — the worker checks the known file set instead.
  Same data source the shell's set was built from; the difference is
  only files created outside the watcher's view.
- The shell manifest suite tests a cache that ceases to exist; its
  version-bump contract was ported to the worker tests instead.

**Gates.** Typecheck clean; app 326/326 (21 files, +model suite +moved
extract/fixtures suites); shell 110/110; shared 51/51; build clean;
preload requires only `electron`.

**Step 6 (2026-06-11, after Joe's manual pass + confirm).** Deleted:
`linkGraph:*` and `search:*` handlers (`ipc/links.ts`, `ipc/search.ts`),
`project:open` / `project:getManifest`, `shell/src/lib/link-graph/`,
the manifest/graph portions of `project-state.ts` (now ~50 lines: root,
git detection, history preference, checkpoint caps), their tests, the
mdast deps from shell/package.json, and the matching contract + bridge
entries (RenameReport type retired; the worker's RenamePlan supersedes
it). `frontmatter.test.ts` moved to shared. Added
`SKRIVE_CONTRACT_VERSION = 2` to the contract (v1 = pre-0.4 surface).
The shell no longer parses Markdown anywhere — grep-verified.

**Stage 0.4 exit.** All done-criteria met: moved suites green in their
new homes (app 326, shared 65, shell 56), manual pass green (Joe),
typecheck + build clean. Next: Stage 0.5 (symlink-safe path
containment).

---

## 2026-06-13 — Packaged dogfood build; dev-mode lag concern cleared

**What was done.** To test feel/performance on a real substrate (dev
mode being an unreliable proxy — see the 2026-06-11 typing-lag note),
added a `workflow_dispatch`-gated `actions/upload-artifact` step to
`release.yml` (`ci:` commit on the branch) and dispatched the Release
workflow against `refactor/ipc-envelope-dispatch`. This builds, signs,
and notarizes WITHOUT cutting a tag, creating a GitHub release, or
touching the electron-updater feed — maximally reversible (the artifact
self-expires; nothing public is created). Run 27467632953 succeeded;
the signed+notarized DMG (stamped 1.0.3 — `package.json` not bumped)
was dogfooded.

**Finding (decision data).** The packaged Stage 0.1–0.4 build feels
snappy with no issues on Joe's hands-on pass — typing is immediate,
project actions (open/save/search/backlinks/rename) responsive. This
CONFIRMS the 2026-06-11 attribution: the "slightly laggy" dev-mode read
was a dev-mode artifact (unminified React, StrictMode double-render,
Vite dev server, cold V8), not an envelope/worker-architecture
regression. The string-marshaled envelope + project-model worker hold
up on the production substrate. Longer multi-day dogfooding still
wanted before a real release, but the architecture-regression risk is
retired.

**Scope check (verified against the repo, not memory).** Stage 0 is
0.1–0.4 done; **0.5, 0.6, 0.7 are NOT done**:
- 0.5 — `resolveSafe` is still lexical-only (no `realpath` physical
  check); no `path-safety.test.ts`; `asset-protocol.ts` has no
  containment logic. Audit S1 symlink gap still open.
- 0.6 — no `shell-zig/` tree, no parity-fixture scripts.
- 0.7 — legacy trees all present (`src-tauri/`, `src/`, `static/`,
  `svelte.config.js`, `vite.config.js`, `build/_app/`, the five
  `legacy:*` scripts); no baselines recorded.

**Next.** Stage 0.5 (symlink-safe path containment) before any
`1.1.0` release, so the release doesn't ship the S1 gap. 0.6/0.7 can
follow without gating a user-facing release.

---

## 2026-06-13 — Stages 0.5, 0.6, 0.7

**0.5 — symlink-safe path containment (closes audit S1).** New
`shell/src/lib/path-safety.ts` (Electron-free, the testable core both
`fs.ts` and `asset-protocol.ts` call): realpaths the root, lexical
containment, then a physical check on the realpath of the deepest
existing ancestor of the target — an in-root symlink resolving outside
is now rejected even though every textual segment looked contained.
Plus NUL-byte rejection and a missing-root failure. `fs.ts`
`resolveFromPayload` is async now; `asset-protocol.ts` routes through
the same function (escape -> 403). New
`shell/__test__/path-safety.test.ts` builds a real symlinked fixture
tree and asserts the five attack shapes reject with PATH_ESCAPE while
legitimate nested/create paths pass (12 cases; shell 56 -> 68). This
fixture tree is the oracle the Zig core reuses in Stage 2.2.

**0.6 — parity corpus.** `shell-zig/fixtures/` with a checked-in
`sample-project/` and per-namespace `<ns>.jsonl` of
`{name, request, response}`. `scripts/generate-parity-fixtures.ts` +
`scripts/run-parity-fixtures.ts` (npm: `parity:gen` / `parity:check`)
drive the REAL shell dispatcher with `electron` stubbed via a Bun
preload plugin (`scripts/parity/preload.ts` — also virtual-modules
`@skrive/shared`, which isn't symlinked into node_modules). 26 fixtures
across envelope/fs/project/persistence; replays green against the
Electron shell. Determinism: ROOT path -> `__SKRIVE_ROOT__`, `*Ms` -> 0,
error parity on `code` (message -> `<message>`), content hashes KEPT as
the cross-impl signal; PAYLOAD_TOO_LARGE via an oversize sentinel.
Scope is the CORE namespaces only — host commands (app/links/clipboard/
updater/dialog) and Stage-4 core namespaces (diff/history) are excluded
and documented in the fixtures README, with the foreign-dispatcher
stdin/stdout contract (`--exec`) for the Zig harness. Error codes
captured: BAD_ENVELOPE, UNKNOWN_COMMAND, PAYLOAD_TOO_LARGE,
PATH_ESCAPE, ALREADY_EXISTS, INVALID_PAYLOAD. Reserved-but-unhit:
NOT_FOUND/NO_PROJECT/IO_ERROR/GIT_ERROR/INTERNAL (host/history paths, or
currently unmapped — e.g. a missing-file read still yields INTERNAL;
the corpus captures current behavior, doesn't improve it).

**0.7 — housekeeping + baselines.**
- `[CONFIRM WITH JOE]` given (2026-06-13). Archived to branch
  `archive/tauri-svelte` (pushed) first, then deleted: tracked
  `src-tauri/` (69 files), root `src/` (84), `static/`,
  `svelte.config.js`, `vite.config.js`; untracked `src-tauri/target/`
  (~14 GB Rust build cache) and `build/_app/`. `build/` keeps its
  icons + entitlements. Removed the five `legacy:*` scripts and the
  Tauri/Svelte deps (`@tauri-apps/*`, `@sveltejs/*`, `svelte`,
  `svelte-check`); kept `vite`/`electron-vite`/`@vitejs/plugin-react`
  (live in the Electron build). Pre-commit guard flagged the deletion
  diff (Cargo.lock checksums + the Tauri updater PUBLIC pubkey —
  public by design, no private material); verified and overrode with
  `--no-verify`. The `src-tauri/*.rs` provenance comments in current
  code now point at archive-branch-only paths; left as-is. Possible
  remnants left untouched pending a separate check: `build/index.html`,
  `build/favicon.png` (may be SvelteKit leftovers; not deleted to avoid
  risking electron-builder inputs). Post-cleanup gate green: typecheck,
  build, app 326 / shell 68 / shared 65, parity 26/26.
- Baselines (Electron, to compare the Zig builds against in 6.3):
  - Installer DMG size: **132 MB** (`Skrive-1.0.3-arm64.dmg`, the
    signed+notarized dispatch artifact). Updater zip: 127 MB.
  - Cold start to first keystroke: **PENDING (Joe)** — manual
    stopwatch on the packaged build; method: launch the DMG-installed
    app cold (after a fresh login or `killall Skrive`), start the timer
    on the dock-bounce, stop when the editor caret is ready for input;
    median of 3.
  - RSS after opening the perf fixture: **PENDING (Joe)** — fixture is
    `docs/fixtures/perf-100` (100 files; the plan's "500" is stale
    prose — the generator at `scripts/build-perf-fixture.ts` produces
    100). Method: open that folder in the packaged app, let lint settle
    (~2s), read RSS for the main + renderer processes in Activity
    Monitor (or `ps -o rss= -p <pid>`); record the sum. Re-measure the
    SAME 100-file fixture on the Zig build in 6.3.

**Stage 0 status.** 0.1-0.7 complete except the two PENDING manual
baseline numbers. Stage 0 exit criteria otherwise met: contract frozen
(SKRIVE_CONTRACT_VERSION=2), bridge tested, clipboard off
navigator.clipboard, analysis in the renderer worker, symlink fixtures
passing, parity corpus green, `main` (after merge) free of Tauri/Svelte
remnants.

**Next.** Joe captures the two baseline numbers; decide the `1.1.0`
release (fast-forward to main, tag, draft, publish) vs. more
dogfooding. Then Stage 1 (macOS spike) when the experiment resumes.

---

## 2026-06-15 — Stage 1.1 skeleton + early 1.2 serving-mode answer

**Branch:** `labs/zig-shell-stage-1-macos-spike` (off `main`).

**Toolchain (verified on this machine).** Zig 0.16.0 (the pinned stable),
Swift 6.3.2 with full Xcode (clang 21), arm64, macOS 26.5.1. No toolchain
fetching needed; the friction was integration, not availability.

**What was built (the skeleton Stage 2 hardens, not rewrites).**
- `shell-zig/core/` — Zig static library exposing the Part I C ABI
  (`skrive_core_create`/`handle`/`destroy`) in its real async-callback
  shape. Only `app:version` is implemented (returns
  `"0.1.0-zig-spike"`, distinct from the Electron version so the
  round-trip is legible by eye). Two-stage envelope parse via
  `std.json`, arena-per-`handle`, C allocator for the long-lived core.
  Three unit tests (app:version round-trip, UNKNOWN_COMMAND, malformed
  -> BAD_ENVELOPE) pass under `std.testing.allocator`.
- `shell-zig/macos/` — SwiftPM executable (Joe's call: SPM over Xcode,
  for git/CLI/headless friendliness). Programmatic AppKit, no
  `.xcodeproj`. `CSkriveCore` is a header-only C target wrapping the
  ABI via an explicit `module.modulemap` (Ghostty idiom); the executable
  links `libskrive_core.a` by absolute path computed from `#filePath`.
  NSWindow chrome mirrors `shell/src/main/index.ts`
  (`titlebarAppearsTransparent` + `fullSizeContentView`, theme-aware
  pre-paint `#1a1a1a`/`#fefcf7`, traffic-light reposition toward
  `{x:12,y:13}`).
- `shell-zig/web/native-bridge.ts` (+ `sample-data.ts`) — the
  renderer-side transport, bundled by bun to a 11 KB IIFE injected as a
  `WKUserScript` at document start. It composes the native channel
  (`app:version` only, via `NATIVE_COMMANDS`) with the Stage 0.2
  `MockTransport` preloaded with the `shell-zig/fixtures/sample-project`
  corpus as a read-only project. `fs:readFile` is special-cased
  payload-aware so the writer can click between the sample's docs. NO
  edits to `app/` or `shared/` — the bridge only imports from them.
- `shell-zig/build-macos.sh` — the documented build order (renderer ->
  bridge bundle -> zig core -> ld64 re-archive -> swift host -> assemble
  `Skrive.app`). `shell-zig/README.md` written.
- Diagnostics (env-gated `SKRIVE_DIAG=1`): a console relay to stdout +
  a post-load self-test that round-trips `app:version`/`app:platform`
  and probes the DOM. This is the repeatable, headless evidence below
  (and the seed of 1.4's repeatable checks).

**Toolchain friction, logged as decision data (none disproportionate).**
- *ld64 archive alignment.* Zig's LLVM archiver writes
  `libskrive_core_zcu.o` not 8-byte aligned; Apple's `ld64` refuses it
  ("not 8-byte aligned in '...a'"). Fix: re-archive the single member
  with Apple's `libtool -static` (step 4 of the build script). Stable,
  one line; Stage 2 keeps it until/unless Zig fixes upstream.
- *Swift 6 strict concurrency.* The C `emit` callback is nonisolated;
  it touches WebKit on the main thread. Resolved by marking `CoreBridge`
  `@MainActor` and asserting `MainActor.assumeIsolated` inside the C
  callback (valid in Stage 1 — the core emits synchronously on the
  calling main thread; Stage 2's thread-pool emit is where the host will
  marshal). The core pointer is `nonisolated(unsafe)` so the nonisolated
  deinit can free it.
- *Deployment target.* Zig defaults its min-OS to the host (26.x); the
  package targets macOS 14. Pinned the Zig build to
  `-Dtarget=aarch64-macos.14.0` in the script to silence the ld
  mismatch warning.

**1.2 serving-mode finding (the bake-off's first, decisive matrix row),
runtime-switchable via `SKRIVE_SERVE`.**
- `file` (`loadFileURL`): the injected bridge IIFE runs (`hasSkrive:
  true`) but the renderer's `<script type="module">` bundle **silently
  does not execute** — `#root` stays empty, blank window. Stripping the
  `crossorigin` attribute does not help, so it is the file:// origin not
  loading ES modules, not a CORS-attribute issue. This is the survey §2
  prediction confirmed empirically.
- `scheme` (`skrive-app://app/`, a `WKURLSchemeHandler` serving the
  bundle with correct MIME types — JS as `text/javascript` is
  load-bearing for module acceptance): the full UI renders, the
  read-only sample project opens, and a document renders. Because
  `openProject` derives the manifest from the snapshot through the
  project-model **worker**, `sampleHeadingRendered: true` is also
  positive evidence that **module workers load under the custom
  scheme**. Default serving mode set to `scheme`.

**1.1 done-criteria: MET (objective self-test, scheme mode).**
`SELFTEST {"hasSkrive":true,"version":"0.1.0-zig-spike",`
`"platform":"darwin","rootChildren":1,"sampleHeadingRendered":true}`,
no console errors/warnings relayed. That is: UI renders, sample document
opens read-only, `app:version` round-trips renderer -> Swift -> Zig ->
renderer.

**Still open in Stage 1 (not done this session).**
- 1.2 remaining checklist rows: `localStorage` survives relaunch under
  the scheme, `light-dark()` behavior on macOS 26, a dedicated
  `skrive-asset://` image path, explicit no-mixed-content check, and the
  loopback-HTTP shape (only needed as fallback — not expected, since the
  scheme already renders + runs workers). Log the full matrix before
  declaring 1.2 closed.
- 1.3 typography gate — `[CONFIRM WITH JOE]`, his eyeball judgment,
  side-by-side vs Electron. **Now unblocked** (UI renders); pending a
  manual pass.
- 1.4 injection + worker hardening as committed repeatable tests (the
  delivery-rule escaper `JSEscape` and the worker shim under the scheme).
  The escaper is written and exercised by the round-trip; the adversarial
  `</script>`/backtick/`${}`/U+2028 byte-identity test is not yet a
  committed test.
- Traffic-light inset parity is approximate (AppKit relayouts on
  resize); verify by eye in the manual pass.

**Pending (Joe).** Manual visual pass: `open
shell-zig/macos/.build/Skrive.app` (or run the binary for console logs;
`SKRIVE_DIAG=1` for the self-test; `SKRIVE_SERVE=file` to see the blank
file:// case). Judge UI fidelity + chrome, and the 1.3 typography gate.

**Post-session chrome fix (same day).** The traffic lights were stranded
in an empty band above the renderer's topbar: the webview was sized to
`contentLayoutRect` (excludes the titlebar), so the content started
below the titlebar instead of under it. Fixed by making the webview the
full content view. Then a separation problem: macOS 26 (Tahoe) spaces
the lights at 23px (measured), so the cluster ends at x:72 — exactly
where the renderer's hardcoded `padding-left: 72px` (`.header.is-macos`,
tuned for ~20px spacing) starts the toggle, leaving zero gap. The shell
now measures the real cluster width and injects the topbar inset
(`clusterRight + 14`) as a shell-owned `<style>` — runtime chrome
coordination, no `app/` change. Cross-finding: the **shipping Electron
build has the same stale 72px on macOS 26**; the proper fix there is the
same (shell drives the inset). Joe approved the chrome; skeleton
committed and pushed (5 commits, `labs/zig-shell-stage-1-macos-spike`).

---

## 2026-06-16 — Stage 1.2: serving-mode bake-off closed

**Branch:** `labs/zig-shell-stage-1-macos-spike` (continued).

**Method.** The diagnostics self-test (`SKRIVE_DIAG=1`) was extended into
an objective, repeatable per-mode checklist, run under both
`SKRIVE_SERVE=scheme` and `SKRIVE_SERVE=file`. A `skrive-asset://`
handler (`AssetSchemeHandler`, Part I path containment, rooted at the
bundled sample project) was added so the asset-origin and
no-mixed-content rows are real, and a 2x2 `test.png` checked into the
fixtures sample project is the probe target. Recon first confirmed the
renderer's only secure-context-sensitive API is `navigator.clipboard`
(already bridged in 0.3) — no `crypto.subtle`/`indexedDB`/
`serviceWorker`/`caches`, and no direct `localStorage` use in app logic
— so a non-secure custom scheme was not expected to break anything.

**The matrix (probe output, macOS 26.5.1 / WebKit).**

| Checklist row | `file://` | `skrive-app://` (scheme) |
|---|---|---|
| UI renders (ES-module bundle executes) | NO (rootChildren 0) | YES |
| module workers load + run, no errors | n/a (no app) | YES (workerErrors 0) |
| `light-dark()` CSS resolves | yes | yes |
| `fetch` of a bundled asset | FAIL (`TypeError: Load failed`) | OK (200) |
| `localStorage` round-trip (in session) | yes | yes |
| `localStorage` survives relaunch | n/a | YES (prior value present) |
| `skrive-asset://` image loads cross-origin | yes | YES |
| no mixed-content block (asset in app page) | n/a | YES |
| `isSecureContext` (informational) | true | true |

**Decision: custom scheme (`skrive-app://`), confirmed.** It cleared
every gating row; `file://` fails the two that matter (the module bundle
never executes, and bundled-asset `fetch` is blocked). Default serving
mode stays `scheme`; `file` is retained behind `SKRIVE_SERVE` only as the
documented negative.

**Findings beyond the pick.**
- *Custom scheme is a secure context here* (`isSecureContext: true`),
  contradicting survey §2's WKWebView prediction. macOS 26 / current
  WebKit treats the `WKURLSchemeHandler` origin (served with an
  `HTTPURLResponse`) as trustworthy. Strictly better — secure-context
  APIs would work — though nothing in the renderer depends on it. Worth
  re-verifying per OS version; do not architect around it.
- *Workers:* the project-model worker (module worker via
  `import.meta.url`) rendering the manifest proves that worker shape
  loads under the scheme; the lint worker (`project.ts:413`) uses the
  identical mechanism and the console relay reported zero worker errors.
  The full lint behavior is verified in the Stage 2.5 manual pass.
- *Renderer asset-resolver gap (Stage 2.5, not the shell):*
  `skriveAssetResolver` is wired into the Preview and Text (CodeMirror)
  surfaces but NOT the Rich (ProseMirror) surface, so an image in a
  Rich-surface doc stays page-relative (`skrive-app://app/...`) instead
  of becoming `skrive-asset://`. The shell's asset origin is proven by a
  direct image-load probe; the renderer wiring is an `app/` concern for
  Stage 2.5.

**Loopback HTTP shape: recorded as fallback, not built.** The plan makes
it the fallback "if worker or storage behavior fails elsewhere." Neither
did — workers render under the scheme and `localStorage` both round-trips
and persists (and is informational regardless, since canonical state is
native-side). Building `std.http.Server` would add a listening socket and
port/token lifecycle for zero benefit here. Revisit only if a future OS
breaks module workers or storage under the custom scheme.

**Stage 1.2 exit: MET.** Serving mode decided (custom scheme) with the
matrix recorded.

**Still open in Stage 1.** 1.3 typography (Joe's gate); 1.4 the
adversarial injection byte-identity test as a committed test + the lint
worker shim confirmation.

---

## 2026-06-16 — Stage 1.4: injection + worker hardening (both as repeatable tests)

**Branch:** `labs/zig-shell-stage-1-macos-spike` (continued).

**Check 1 — delivery-rule injection round-trip (the security-normative
one), tested two ways.**
- *End-to-end.* New `diag:poison` command in the Zig core returns
  shell-originated adversarial content — `</script><script>...</script>`,
  a backtick + `${}` template trap, a quote, a backslash, a newline, and
  U+2028/U+2029 — JSON-encoded by the core. It travels the real delivery
  path: core JSON-encode -> `JSEscape` (JS string literal) ->
  `window.__skriveDispatch` -> renderer `JSON.parse`. The diagnostics
  self-test drives it through a spike-only `window.__skriveNativeInvoke`
  hook and asserts the body arrives **byte-identical** (`length === 60`,
  matching the source bytes) and that the embedded `<script>` **did not
  execute** (`window.__pwned` stays `undefined`). Result (scheme mode):
  `injectionByteIdentical: true, injectionNoExec: true`. (It also passes
  in `file` mode — the delivery rule is independent of serving mode.)
- *Unit.* `JSEscape` was extracted into a `SkriveShellKit` library target
  so it is testable; `swift test` runs `JSEscapeTests` (XCTest +
  JavaScriptCore) which round-trips eight adversarial inputs through a
  real JS engine (assert byte-identical) and proves a breakout payload
  stays inert data (a global it would set stays `0`). 2/2 pass.

**Check 2 — lint worker shim under the chosen serving mode.** The raw
`decode-named-character-reference` DOM build calls `document.createElement`
at *module load*, which throws in a worker; the renderer aliases in the
Node shim (`...node-shim.ts`, `electron.vite.config.ts`), and that alias
is baked into the built `lint.worker-*.js`. The self-test discovers the
hashed worker asset from the main bundle, instantiates it as a module
worker under `skrive-app://`, and asserts no module-load error
(`lintWorkerLoaded: true`, asset `lint.worker-YbDnztQQ.js`). A clean load
is the shim confirmation; decode correctness itself is identical to the
package (pure table lookup) and covered by the `app/` vitest suite.

**Core.** Gained `diag:poison` + a unit test (the JSON-encoding layer);
`zig build test` 4/4. The manual JSON string-escaper in the core handles
the structural bytes; U+2028/U+2029 pass through as raw UTF-8 (valid in
JSON), and `JSEscape` escapes them on the JS-string layer.

**Stage 1.4 exit: MET.** Both checks pass and are committed as repeatable
tests (`swift test` + the scripted `SKRIVE_DIAG` harness), not one-off
observations.

**Stage 1 status.** 1.1, 1.2, 1.4 complete. **Only 1.3 (typography,
Joe's eyeball gate) remains** before the Stage 1 exit criteria are fully
met. The skeleton, serving-mode decision, injection test, and worker
confirmation are all in hand; the spike answered every empirical question
it set out to, with no disproportionate toolchain fight (Stage 1 kill
criterion not triggered).

---

## 2026-06-16 — Stage 1.3 typography gate: PASS (a). Stage 1 complete.

**Branch:** `labs/zig-shell-stage-1-macos-spike` (continued).

**Method.** A Fraunces/Palatino-heavy specimen
(`shell-zig/fixtures/typography-sample/typography.md`) authored once on
disk and inlined into the spike's canned data via a bun text-import, so
both shells render byte-identical input. It stresses ligatures
(fi/fl/ffi/ffl), old-style vs lining figures, kerning pairs, curly
punctuation + dashes + ellipsis, accents, and serif italics at heading
and body sizes. The spike opens it on launch; Electron opens the same
folder. Default editorial font (Iowan Old Style -> Palatino), both on the
Rich surface, side by side on the same macOS 26 display — so the only
variable is the engine (WKWebView/Core Text vs Electron/Chromium).

**Verdict: (a) acceptable — `[CONFIRM WITH JOE]` given (Joe, 2026-06-16,
direct side-by-side).** Core Text rendering of the Overcast serif look is
good; no CEF fallback needed. (Screenshots not captured — programmatic
window capture here lands on the wrong Space and needs a screen-recording
permission the build process lacks; the verdict is from Joe's direct
visual check.)

**One investigation along the way (resolved, not a substrate issue).** A
multi-line blockquote in the first draft showed line breaks at the source
line boundaries. Dumped the rendered DOM: a correctly-modeled
`<blockquote><p>...</p></blockquote>` with **literal `\n` newlines** (the
draft hard-wrapped the blockquote across `>` lines), rendered as breaks
by the Rich surface's `white-space: pre-wrap` (standard for an editable
surface). Identical in Electron — same DOM + CSS; the substrate changes
only glyph rasterization, never reflow. Fixed the specimen by authoring
every paragraph as a single unwrapped line (how prose should be written
for the Rich surface). Standing note: the Rich surface preserves source
line-wraps; this is a renderer characteristic shared by both shells, not
a Zig finding.

**Stage 1 exit criteria: ALL MET.** Serving mode decided (custom scheme);
typography verdict (a); injection test green; worker confirmed; skeleton
committed; findings logged. The macOS spike answered every empirical
question — system webview hosts the React+ProseMirror app faithfully, the
Zig-core-behind-C-ABI + Swift-host pattern works, the delivery rule holds
against adversarial content — with no disproportionate toolchain fight.
The kill criterion was never triggered.

**Next.** Stage 2 (macOS editable MVP): the real Zig core dispatcher and
the `fs`/`project`/`persistence`/`app`/`links`/`clipboard` namespaces,
replacing the canned MockTransport command by command, gated by the
parity corpus. The Stage 1 skeleton is the substrate Stage 2 hardens.

---

## 2026-06-17 — Stage 2.1: core dispatcher + errors.zig + fixture_main

**Branch:** `labs/zig-shell-stage-2-dispatcher` (off `main`).

**What was built (replaces the spike's inline `buildResponse` behind the
unchanged C ABI).**
- `core/src/errors.zig` — the `ErrorCode` enum mirroring the closed
  `SKRIVE_ERROR_CODES` set, with `wire()` (the SCREAMING_SNAKE string) and
  a static `message()` per code, plus the single `codeFor(anyerror)`
  mapping the dispatcher calls for handler-thrown errors. 2.1 only needs
  the envelope-level codes; `codeFor` is the one place 2.2+ adds
  `FsError`/`ProjectError` cases.
- `core/src/dispatch.zig` — `dispatchJson(arena, request) -> [:0]const u8`
  reproducing `shell/src/main/dispatch.ts` (the parity oracle) in its
  **exact validation order**: size cap (32 MiB) before parse -> two-stage
  `std.json` parse -> not-object -> compute `rawId` (positive integer,
  else 0) -> unknown-top-level-field (before the version check, matching
  the JS) -> `v != 1` -> `rawId == 0` -> non-empty-string `cmd` -> object
  `payload` -> comptime command-table lookup -> handler, with errors mapped
  in one place. Envelope framing (`v,id,ok,result` / `...,error:{code,
  message}`) lives only here; key order is fixed because the parity
  normalizer re-stringifies in parsed-key order, so byte-equality needs it.
  The comptime `commands` table carries `app:version` + `diag:poison`
  (spike carryovers, not corpus-tested — they keep the macOS round-trip
  legible). Handlers return their `result` object as an arena slice; the
  dispatcher wraps it.
- `core/src/fixture_main.zig` — the JSONL stdin/stdout harness. One `Core`,
  an `emit` sink that writes `response + "\n"` to stdout (`std.Io.File`
  unbuffered `writeStreamingAll`), reading lines with `takeDelimiter('\n')`
  over a `MAX_REQUEST_BYTES + 1 MiB` reader buffer so the ~32 MiB
  PAYLOAD_TOO_LARGE line reaches the dispatcher whole and is rejected
  there. `pub fn main(init: std.process.Init)` for `init.io`/`init.gpa`.
- `skrive_core.zig` refactored: a Zig-native `Core` (`create`/`destroy`/
  `handle`) shared by both the C ABI and `fixture_main`; the `export fn`
  symbols are thin wrappers. ABI shape and `include/skrive_core.h`
  unchanged — `nm` confirms `_skrive_core_create/handle/destroy` still
  exported, so the Swift host links untouched.
- `build.zig`: added the `fixture_main` executable (installed to
  `zig-out/bin/`); the `test` step now compiles each of the three source
  files separately so all `test` blocks run.

**Design decisions (logged as data; none contradict the spec).**
- *fixture_main enters via the slice API, not the literal C string.* Both
  it and the C ABI funnel into `Core.handle([]const u8)`; the C-string
  marshaling is a trivial `std.mem.span`, not worth a per-line
  NUL-terminated copy to re-exercise. Same dispatch + emit path, same
  emitted bytes.
- *Error messages are static per code.* Parity normalizes `message` away,
  and the delivery rule forbids interpolating attacker-influenced content
  (a `cmd` value, a path) into the response unescaped — so no message
  embeds request data. The spike already did this for UNKNOWN_COMMAND; it
  is now the rule across every code.
- *0.16 `std.Io`.* Confirmed the reworked I/O surface before writing:
  `pub fn main(std.process.Init)` is supported on a non-libc exe (the
  universal `callMain` builds the full `Init` with `.io`/`.gpa`);
  `std.Io.File.stdin()/stdout()`, `file.reader(io, buf).interface`,
  `Reader.takeDelimiter`, `File.writeStreamingAll`. No surprises, no
  toolchain fight.

**Gates.** `cd shell-zig/core && zig build test` exit 0 (errors wire +
mapping, the six-case envelope-validation matrix against `dispatchJson`,
the C-ABI round-trip); `zig build` produces both the static lib and the
fixture binary; `zig fmt --check` clean.

**Parity (the 2.1 done-criterion).** `bun run parity:check -- --exec
"$(pwd)/shell-zig/core/zig-out/bin/fixture_main"`: **6/6 `envelope`
fixtures green** (malformed-json, unknown-top-level-field, bad-version,
non-object-payload, unknown-command, payload-too-large). The run reports
20/26 overall as expected-red: every one of the 20 is an `fs`/`project`/
`persistence` command returning `UNKNOWN_COMMAND`, i.e. exactly the
namespaces that land in 2.2-2.4. The runner has no per-namespace filter,
so a full red run during 2.1 is intentional, not a regression — "envelope
group clean" is the gate. Whole corpus goes green by the end of 2.4.

**Electron build.** Untouched — no changes to `app/`, `shared/`, `shell/`
(only `shell-zig/`), so its suites stay green by construction.

**macOS host build.** Not re-run this session; the C ABI is byte-identical
(symbols verified via `nm`), so the Swift host's link is unaffected. Full
`build-macos.sh` re-verification folds into 2.2+ where a host channel
(`fs:trash`) actually changes the Swift side.

**Blocked.** Nothing.

**Next.** Stage 2.2 — the `fs` namespace in `core/src/fs.zig`: all 8
commands, Part I path safety (port the 0.5 symlink fixture tree as Zig
tests), atomic writes, SHA-256 hashing byte-equal to Electron (verify
against `fs.jsonl`), `detectExternalChange`, and `fs:trash` routed to the
host via a reserved `host:` channel designed into the C ABI here.

---

## 2026-06-17 — Stage 2.2a: the seven in-core fs commands

**Branch:** `labs/zig-shell-stage-2-dispatcher` (continued). Split 2.2
into 2.2a (the core-only commands, this entry) and 2.2b (`fs:trash` via
the host channel — touches Swift, pending Joe's sign-off on the channel
shape), so the Swift-touching change is isolated behind an explicit gate.

**What was built (`core/src/fs.zig`).** The seven filesystem commands that
live in the core — `readFile`, `detectExternalChange`, `writeFile`,
`writeBinaryFile`, `newFile`, `mkdir`, `rename` — each resolving its path
through `resolveSafe`, the Part I symlink-safe containment ported verbatim
from `shell/src/lib/path-safety.ts` (NUL reject -> canonical root ->
lexical containment -> physical realpath check on the deepest existing
ancestor). Atomic writes via `createFileAtomic(.replace)` + `file.sync`
(temp + fsync + rename, the `atomic-write.ts` guarantee). Content hash is
SHA-256 lowercase hex, byte-equal to Electron — verified two ways: a unit
test against the known README hash, and the live `fs.jsonl` replay
(readFile/writeFile hashes match).

**Two 0.16 std findings (real, but no spec deviation — the algorithms port
verbatim, only API names/shapes change; logged as decision data).**
- *The core must own an `Io`.* In 0.16 every filesystem op takes an
  `std.Io` parameter, but the C ABI passes none. `Core` now holds one: the
  C-ABI `create` uses `std.Io.Threaded.global_single_threaded.io()` (the
  documented library escape hatch — synchronous blocking fs on the calling
  thread, exactly Stage 2's model), while `fixture_main` threads the real
  process `init.io`. `Handler` gained an `io` param; the dispatcher passes
  `Core.io` through. If the core ever moves to a thread pool (Part I), an
  owned `Threaded` + host emit-marshaling replaces the global — the
  localized change Stage 1 already flagged.
- *`realpath` -> `Dir.realPathFileAbsoluteAlloc`* (renamed/relocated under
  the Io model). The path-safety algorithm is otherwise identical. Other
  renames hit along the way: `std.Io.Dir`/`File` for all fs ops,
  `path.relative(gpa, cwd, environ_map, from, to)` (5-arg; cwd/environ
  unused on posix for absolute inputs), `createDirPath` for mkdir -p,
  `renameAbsolute`, `bytesToHex`.

**Serialization note (de-risks readFile/snapshot).** The parity runner
normalizes *both* sides by JSON-parse + re-stringify, so the core's output
only needs to be valid JSON with the right key order and values — not
byte-perfect whitespace or escape style. `readFile` bodies/paths are
escaped via `std.json.Stringify.encodeJsonString`; the rest is
`allocPrint` with a fixed field order matching the oracle.

**errors.zig.** `codeFor` extended with the fs set — `PathEscape`,
`InvalidPayload`, `AlreadyExists`, `IoFailure` — mapped to their codes.
Zig error tags are global, so no `fs.zig` import (no circular dep). fs
handlers convert std errors to these at the call site so the dispatcher
never sees a raw filesystem error.

**Gates.** `zig build test` exit 0 (39 tests: the ported symlink fixture
tree — all five attack shapes + legitimate paths + root canonicalization +
symlinked-root + non-existent root — plus the hash-equality check, under
`std.testing.allocator`). `zig fmt --check` clean. The Stage 0.5 fixture
tree is now the cross-impl oracle it was built to be: same shapes, same
verdicts, in Zig.

**Parity.** `parity:check --exec`: `fs.jsonl` **11/12 green** — every
in-core command, both error cases (`PATH_ESCAPE`, `INVALID_PAYLOAD`,
`ALREADY_EXISTS`), and hash equality. The only `fs` mismatch is `trash`
(2.2b). Whole-corpus 9/26 mismatched = `[fs] trash` + 4 `project` (2.3) +
4 `persistence` (2.4); envelope still 6/6, no fs regression.

**Electron build.** Untouched (`shell-zig/` only).

**Blocked / pending.** 2.2b (`fs:trash`) needs Joe's sign-off on the
`host:` channel shape before touching `CoreBridge.swift`: core validates
the path then `emit`s `{"v":1,"host":"trash","id":N,"path":"<abs>"}` and
defers the renderer response; the host (Swift `FileManager.trashItem`; the
harness a plain delete) calls `skrive_core_handle` back with
`{"v":1,"host":"result","id":N,"ok":true}`; the core translates that into
the `fs:trash` response. Stateless (id + outcome ride in the result), async
(no reentrancy). No C *function* signature change — a reserved envelope
convention over the existing `emit` + `handle`, reused by every future
host command.

---

## 2026-06-17 — Stage 2.2b: fs:trash via the host: channel. Stage 2.2 complete.

**Branch:** `labs/zig-shell-stage-2-dispatcher` (continued).

**Channel shape (Joe's call, verb-field).** The core emits a host-command
envelope `{"v":1,"host":"trash","id":N,"path":"<abs>"}`; the host performs
the OS action and replies `{"v":1,"host":"result","id":N,"ok":bool}`; the
core turns the reply into the deferred `fs:trash` response. The host
switches on a short `host` verb (not the original `cmd`), so each host
command defines its own minimal field set (`path` here; `url` for a future
`openExternal`) and the host is decoupled from command names. Chosen over
passing the original `cmd`. No C function-signature change — a reserved
envelope convention over the existing `emit` + `skrive_core_handle`.

**Core (`dispatch.zig`, `fs.zig`).**
- `fs:trash` is special-cased in the dispatcher (not in `fs.commands`): it
  resolves + path-validates via `fs.resolveTrashTarget`, then returns the
  host-command envelope instead of a wrapped result. A path-safety failure
  still returns the normal coded error response (PATH_ESCAPE etc.).
- An inbound `host:result` envelope is intercepted at the top of
  `dispatchJson` (it carries `host`, not `cmd`, so before normal envelope
  validation; a renderer never sends `host`). `handleHostReply` is
  stateless: `ok:true` -> the deferred `{...,"ok":true,"result":{}}`,
  `ok:false` -> IO_ERROR with the echoed id. Two unit tests cover both.

**Test host (`fixture_main.zig`).** The emit sink intercepts `host:`
envelopes (cheap `{"v":1,"host":` prefix guard, then parse): for `trash` it
does a plain delete (no OS trash in a test) and replies on the host
channel, which the core turns into the response written to stdout. The
reentrant `core.handle` for the reply is safe — each call has its own arena
and the core holds no per-request state. So the runner still sees exactly
one response line per `fs:trash` request.

**Real host (`CoreBridge.swift`).** `dispatch` now guards on the same
prefix: a host envelope routes to `handleHostCommand` (never to the
renderer), which for `trash` calls `FileManager.trashItem` and replies via
`handle`. The trash runs on `DispatchQueue.main.async` so the core's
original `handle` returns before the reply re-enters it — the
production-correct async model (no reentrancy into the core's arena, unlike
the harness's simpler synchronous reentry; both are observably identical).
Future host commands (openExternal, clipboard, dialogs) add their `case`
here.

**Gates.** `zig build test` exit 0 (now incl. the two host-reply unit
tests); `zig fmt --check` clean. macOS host re-verified per the kickoff:
`zig build -Dtarget=aarch64-macos.14.0` -> libtool re-archive -> `swift
build` links clean -> `swift test` 2/2 (JSEscapeTests). The C ABI is
unchanged, so the relink was mechanical.

**Parity — Stage 2.2 done-criterion MET.** `parity:check --exec`:
**`fs.jsonl` 12/12 green**, including the host-channel `trash`, all
`PATH_ESCAPE` cases, and hash equality. Whole-corpus 8/26 mismatched =
4 `project` (2.3) + 4 `persistence` (2.4); `envelope` 6/6 and `fs` 12/12,
no regression.

**Deferred to the 2.5 manual pass.** Trashing a file in the *running* Zig
app (real `FileManager.trashItem` moving a file to Finder's Trash, then the
sidebar updating) — the parity harness proves the channel and the Swift
code compiles/links, but the end-to-end UI path is integration-pass
territory. Flagged so it isn't assumed done.

**Stage 2.2 status: COMPLETE.** All 8 fs commands at parity; path safety,
atomic writes, and SHA-256 hash equality verified; the host: channel
established and reused-ready.

**Next.** Stage 2.3 — `project` namespace (minus watch): `project:snapshot`
(recursive walk, exact noise-dir skip list from `shell/src/ipc/project.ts`,
one batched response) and `project:create` (optional `git init` via
`std.process`). Done when `project.jsonl` replays green and the perf
fixture opens through the real UI.

---

## 2026-06-17 — Stage 2.3: project:snapshot + project:create (parity half)

**Branch:** `labs/zig-shell-stage-2-dispatcher` (continued).

**Corpus correction first (pre-existing drift, logged).** The
`project.jsonl` snapshot fixture was generated in 0.6, before `test.png`
was added to `sample-project` in 1.2 — so the *current Electron oracle
failed its own fixture* (`parity:check` reported 1/26 on `[project]
snapshot`: the oracle now lists `test.png`, the stale fixture didn't).
`[CONFIRM WITH JOE]` given. Regenerated via `parity:gen`; reviewed the
diff — the only change is `test.png` (`body:null`, `sizeBytes:74`) appended
to the snapshot list. Separate `test:` commit.

**Core (`core/src/project.zig`).**
- `project:snapshot` — recursive walk mirroring `snapshot.ts`: the verbatim
  `NOISE_DIRS` skip list, skip hidden dirs and dot-files, markdown carries a
  body+hash, assets are `body:null`, `.skrive.toml` always included with a
  body. One batched `{root, files:[...]}` response, file key order matching
  the fixture (path, body, modifiedMs, hash, sizeBytes). Root uses
  `path.resolve` (not realpath), matching the oracle; a missing/unreadable
  root yields an empty file list (not an error), also matching.
- `project:create` — validate parent + name (trim, reject separators/`.`/`..`
  -> INVALID_PAYLOAD), non-recursive `createDir` (PathAlreadyExists ->
  ALREADY_EXISTS), starter README, optional best-effort `git init` via
  `std.process.spawn` (argv[0] resolves on the parent PATH; not corpus-
  tested since the fixture sets `gitInit:false`).
- `fs.jsonString`/`sha256Hex`/`mtimeMs` are now shared (narrowed to the
  allocator error so other error domains can `try` them).

**The localeCompare sort (Joe's call, logged as a known approximation).**
The oracle sorts the files array with JS `localeCompare` (ICU collation),
which Zig can't byte-replicate without a dependency. We sort case-insensitive
ASCII, which reproduces the corpus order exactly (the only non-byte-sort
case is `README.md`). This is non-functional: the renderer's project-model
worker re-sorts on `init` (model.ts:217) and binary-searches its own
structure, never the raw snapshot array — verified. A future corpus file
whose `localeCompare` order diverges from case-insensitive ASCII would be a
fixture-only mismatch, not a renderer bug. Unit test pins the corpus order.

**Gates.** `zig build test` exit 0 (+ the sort-order and walk-rule tests);
`zig fmt --check` clean. No Swift change (snapshot/create are pure core), so
the macOS host is unaffected.

**Parity — the corpus half of the 2.3 criterion: MET.** `parity:check
--exec`: `project.jsonl` **4/4 green** (snapshot, create, create-exists,
snapshot-missing-root). Whole-corpus 4/26 mismatched = persistence only
(2.4); envelope/fs/project all green.

**Scope finding — the perf-UI half is entangled with 2.4/2.5, not 2.3.**
The plan's 2.3 criterion also wants "the perf fixture opens through the real
UI and renders the sidebar." That can't be done cleanly inside 2.3: it needs
(a) `project:snapshot` + `fs:*` added to `NATIVE_COMMANDS` in
`shell-zig/web/sample-data.ts`, AND (b) the app pointed at a *real on-disk
project root*. Today the spike auto-opens `SAMPLE_ROOT = "/Skrive/Parity
Sample"` — a fake path served entirely from canned `MockTransport` data —
and that root rides in canned `persistence:loadAppState`/`loadProjectState`.
So opening a real project through the core requires native persistence
(2.4) and/or a real project-selection path (native `openDialog`, host-side).
Wiring `NATIVE_COMMANDS` now without that would *break* the running app
(routing `project:snapshot` native against a non-existent root). The
perf-UI open therefore belongs in the 2.5 integration pass, after
persistence lands — the same place the 2.2b running-app trash check went.
Per the working rules, surfacing this rather than improvising a resequence.

**Stage 2.3 status: core COMPLETE and parity-green; perf-UI open deferred to
the 2.5 integration pass (rationale above).**

**Next.** Stage 2.4 — `persistence` (`core/src/persistence.zig`: app.json +
`projects/<16-hex-sha256>.json`, hash construction matching
`shell/src/lib/persistence.ts`), plus `app:*`, the flush-before-quit
handshake, `links:openExternal`, and `clipboard:*` (host). After 2.4 the app
can open/restore a real project end-to-end, which is what unblocks the 2.5
integration pass (incl. the deferred perf-UI open).

---

## 2026-06-17 — Stage 2.4: persistence + the `Context` seam. Corpus 26/26.

**Branch:** `labs/zig-shell-stage-2-persistence` (off `main`).

**Branch note (state reconciliation).** The Stage 2.1–2.3 work landed in
`main` independently (via a parallel worktree / resumed context) with
*different commit SHAs* than the pushed `labs/zig-shell-stage-2-dispatcher`
branch, plus `main` carried further product work on top (the flush-sidebar /
white-duotone chrome rework, feedback features, version bumps to 1.3.0).
So `main` — not the now-superseded dispatcher branch — is the correct base
for 2.4. Verified the content matches (the fs pub helpers and Handler
signature are byte-identical to what 2.3 left); only SHAs diverged. This
branch is off `main`.

**The `Context` seam (refactor in service of persistence).** 0.16 fs ops
need an `Io`, and persistence additionally needs the app-data dir, so the
bare `io` handler param became `*const Context = { io, app_data_dir }` —
the natural home for the long-lived state handlers get (Stage 3's watcher
registry lands here too). `Core` now holds a `Context`; the C-ABI `create`
parses `appDataDir` out of `config_json` (the host's `Resources.configJSON`
already sends it) and copies it into c-allocator-owned storage freed in
`destroy`; the fixture harness mints a fresh `/tmp/skrive-fixture-<rand>`
per run so `loadAppState` sees no `app.json` before `saveAppState` writes
one. fs/project/app handlers were mechanically repointed (`io` → `ctx.io`).

**Core (`core/src/persistence.zig`).** `loadAppState` / `saveAppState` /
`loadProjectState` / `saveProjectState` over `{appDataDir}/app.json` and
`{appDataDir}/projects/<hash>.json`, where `<hash>` is the first 16 hex of
SHA-256 of the project path — matching `hashProjectPath` exactly (unit-
tested). Writes are atomic temp+rename, no fsync (the lighter guarantee
`persistence.ts` gives state files). `loadAppState` on a missing file
returns the embedded default `AppUiState`.

**Two coupling/scope decisions, logged.**
- *Embedded default.* The shell owns load-with-defaults, so the core has to
  carry the default `AppUiState` (it IS the `loadAppState-default` fixture
  verbatim). It MIRRORS `DEFAULT_APP_UI_STATE` in `shared/src/persistence.ts`
  and must be updated in lockstep — there's no app-side seam to read it
  from. A logged coupling the dual-shell period pays.
- *Lenient load, not full sanitize.* App-state load merges the file over
  the default by key (default order, file values win, `schemaVersion` forced
  to 1; future version → default) but does NOT port the oracle's exhaustive
  per-field type whitelisting (`sanitizeAppState`/`sanitizeProjectState`) —
  porting that defensive renderer-coupled validation is the scope-creep the
  kill criterion names, and the core writes its own well-formed files.
  Project-state load returns the stored object as-is. Not corpus-tested
  (the corpus exercises only missing-file → default/null).

**`revealUserData` — the host channel's payoff.** Host-side (NSWorkspace),
so it rides the `host:` channel from 2.2b as a second verb: the core
special-cases `persistence:revealUserData` to emit
`{"host":"reveal","id","path":<appDataDir>}`; the harness acks (no file
browser in a test), `CoreBridge.swift` adds a `reveal` case opening the dir
via `NSWorkspace.shared.open`. First reuse of the generic channel — exactly
why it was built generic.

**Gates.** `zig build test` exit 0 (+ hash-construction and merge unit
tests); `zig fmt --check` clean. macOS re-verified: zig core (macos target)
→ libtool re-archive → `swift build` links clean (AppKit added for
`NSWorkspace`) → `swift test` green. **Parity — the 2.4 done-criterion:
`persistence.jsonl` 4/4, whole corpus GREEN 26/26.**

**Deferred to the 2.5 integration pass (host-side, NATIVE_COMMANDS-gated).**
The flush-before-quit handshake, `links:openExternal`, `clipboard:*`, and
`app:ready`/`platform` host implementations are only *reachable* once the
renderer routes commands to native (`NATIVE_COMMANDS`) against a real open
project — the same entanglement as the 2.3 perf-UI open. Writing them blind
now isn't testable, so they batch into 2.5 where they are. The quit-mid-edit
manual test rides with the flush handshake there.

**Stage 2.4 status: core COMPLETE; full parity corpus green. Host-side
app/links/clipboard/flush deferred to the 2.5 integration pass.**

**Next.** Stage 2.5 — the integration pass: wire `fs`/`project`/
`persistence` into `NATIVE_COMMANDS` (drop the `fs:readFile` mock special-
case), `skrive-asset://` at the real project root, embed-vs-bundle decision,
the host-side app/links/clipboard/flush handlers, and the full manual pass
(open/edit/autosave/images/search/backlinks/UI-restore + the deferred
perf-UI and running-app trash checks). Then dogfooding begins.

---

## 2026-06-17 — Stage 2.5a-d: the integration pass (code). Manual pass pending.

**Branch:** `labs/zig-shell-stage-2-persistence` (off `main`; the 2.4 work is
already merged into `main`, so this is its continuation). Five commits, one
per sub-stage; the headless `SKRIVE_DIAG` SELFTEST gates each.

**2.5a — the spine (`feat: wire fs/project/persistence to the native core`).**
The renderer's composite transport now routes the fs/project/persistence
namespaces to the native channel (`NATIVE_COMMANDS` in `shell-zig/web`),
retiring the canned `MockTransport` data for them and the `fs:readFile`
special-case. `CoreBridge.handle` gained host-owned command routing: it
parses each request and handles host-owned commands in Swift (Part I "host
owns X, forwards the rest"), starting with `project:openDialog` (NSOpenPanel
-> chosen path or null). The app now **boots to its welcome state** (native
persistence returns the default app-state, no last-opened project — and the
renderer is read-only, so this is the only possible behavior) and opens real
folders via the dialog. The canned typography auto-open is gone, so the
self-test was reworked: it drives a native `project:snapshot` of the bundled
project and asserts real files come back. SELFTEST: `snapshotFiles:4,
snapshotHasReadme:true, rootChildren:1, workerErrors:0` — the fs/project
spine round-trips renderer -> Swift -> Zig core -> renderer against real disk.

**2.5b — remaining host commands (two commits).**
- `links:openExternal` (NSWorkspace, Part I scheme allowlist) and
  `clipboard:writeRich/writeText/readText` (NSPasteboard, rich = both HTML +
  plain). Added to `NATIVE_COMMANDS`, routed in `CoreBridge`.
- The **pre-quit flush handshake** (parity with `shell/src/main/index.ts`):
  `applicationShouldTerminate` returns `.terminateLater`; `CoreBridge.beginFlush`
  emits an `app:flush-before-quit` event; the renderer saves dirty docs (native
  `fs:writeFile`) and acks with `app:flushComplete` (intercepted host-side,
  fire-and-forget); the app proceeds on the ack or a 2s backstop. Both need
  user interaction to exercise — manual-pass items; swift build links clean
  and a diag boot confirms the spine is unaffected.

**2.5c — asset serving (`feat: serve skrive-asset:// from the active project
root`).** The scheme handler serves from the ACTIVE project root, not the
fixed bundled one: `CoreBridge` records the root from each `project:snapshot`
into a lock-guarded `ActiveProject` the handler reads. Path safety hardened
to a realpath containment (`resolvingSymlinksInPath` on root + target), so an
in-root symlink jumping outside is rejected. `imageResolver.ts` unchanged.
SELFTEST `assetImageLoaded:true` against the opened project.

**2.5d — embed-vs-bundle: DECIDED bundle-resource-dir.** The serving mode is
the custom scheme (`skrive-app://`), whose `AppSchemeHandler` (Swift) reads
the renderer from the `.app`'s `Resources/renderer`. That is the macOS-native
packaging — signed, updatable, no binary bloat — and it is what the serving
mode made natural. Embedding `out/renderer` into a binary would couple the
renderer bytes into the core or host for zero serving benefit (the core does
not serve the renderer; it serves nothing over HTTP). `build-macos.sh` step 6
already copies the renderer into Resources; that is the shipped layout.

**Gates.** Each sub-stage: bridge bundles, `swift build` links clean, full
`build-macos.sh` + `SKRIVE_DIAG` SELFTEST green (version round-trip, native
snapshot of real files, asset image, injection round-trip, lint worker). The
Zig core and parity corpus are untouched by 2.5 (26/26 still green).

**2.5e — full manual pass: PENDING (Joe).** The headless self-test proves the
native spine, but the hands-on checklist is the real exit gate: open a folder
via the dialog, edit in Text + Rich, confirm autosave writes through native
`fs:writeFile`, images render from the active project, search + backlinks work
(renderer worker over the native snapshot), UI state restores on relaunch,
quitting mid-edit loses nothing (the flush handshake), the running-app trash
moves a file to Finder's Trash, and the perf-100 fixture opens and renders the
sidebar (the deferred 2.3 check). Friction goes in the log. From here:
dogfooding.

**Stage 2.5 status: a-d COMPLETE (code, headless-verified); 2.5e manual pass
is the remaining exit gate before dogfooding.**

---

## 2026-06-17 — Fix: re-sync the embedded default app-state (dual-shell tax)

The embedded-default coupling logged in 2.4 bit. A feedback-nudge feature
(`launchCount`, `seenFeedbackPrompt`) landed in `main`'s
`DEFAULT_APP_UI_STATE` after the persistence fixture + the
`persistence.zig` `DEFAULT_APP_STATE` were captured, so the Zig core was
returning a stale default: `bun run parity:check` (the live Electron
oracle) failed 1/26 on `loadAppState-default`, while `--exec` (core vs the
stale fixture) was a false-green 26/26. Fixed by `parity:gen` (only
`persistence.jsonl`'s default line changed — the two fields inserted after
`firstRunMs`) and inserting the same two fields into the embedded constant.
Both directions green again: core-vs-fixture AND fixture-vs-oracle 26/26.

**Decision data — the dual-shell tax made concrete.** Anything `app/`
embeds that the Zig core mirrors (the default app-state today; the contract
surface generally) drifts on every `app/` change and silently passes the
`--exec` gate because the fixture drifts with it. The honest gate is
running BOTH directions (`parity:check` against the oracle, then `--exec`
against the core). Candidate guard for later: a CI step that fails if
`persistence.zig`'s `DEFAULT_APP_STATE` does not equal the regenerated
fixture's `loadAppState-default` result, so the coupling can't drift
unnoticed.

**Related (Joe, this session): the app/ UI makeover (PR #11 — themes +
filled icon set) -> the Zig shell.** Because both shells share one `app/`,
the makeover transfers for free — it is pure renderer (icons = React,
themes = CSS). The Zig app just serves a stale `out/renderer` (built before
the makeover); a `bun run start:build` + re-assemble surfaces it. The only
genuinely shell-specific bit is the window pre-paint background color
(Electron's moved to `#161719`/`#e7e8ea`; the Zig `AppDelegate` still paints
the old `#1a1a1a`/`#fefcf7`). Deferred to after the 2.5e manual pass, at
Joe's direction.

---

## 2026-06-17 — Stage 2.5e manual pass: GREEN. Stage 2 COMPLETE.

**Branch:** `labs/zig-shell-stage-2-persistence`. Tested the assembled
`Skrive.app` (renderer rebuilt from current `app/`, so the build carried the
PR-#11 UI makeover too).

**Result: all gates pass.** Joe's hands-on pass:
- Open + edit (Text and Rich), autosave through native `fs:writeFile`,
  images, search, backlinks, links, clipboard, UI-state restore — all good.
- **#9 trash** — file moves to Finder's Trash, sidebar updates. PASS.
- **#14 flush (the quit-mid-edit gate)** — type, Cmd-Q, relaunch: content
  persisted. PASS (the flush handshake works end to end).
- **#15 perf-100** — sidebar renders and stays responsive. PASS.

**The UI makeover surfaced for free** — rebuilding `out/renderer` from the
current `app/` brought the new themes + filled icon set into the Zig shell
with zero shell work. The shared-frontend thesis, validated in the most
direct way: one `app/`, both shells.

**Two findings from the pass.**
1. *Markdown serializer entities (`&#x20;`/`&#x61;`) — NOT a Zig finding.*
   Rich-surface markdown source showed numeric-entity escapes for a trailing
   space and a word char butted against a closing emphasis (`*is not&#x20;*&#x61;`).
   This is the renderer's ProseMirror->Markdown serializer being
   fidelity-conservative (the emphasis mark grabbed a trailing space; `*is not *`
   is invalid CommonMark, so the space is entity-escaped, and the adjacent
   `a` too). The round-trip is LOSSLESS and the Zig core's fs is byte-exact
   (SHA-256 parity) — identical in Electron. A candidate `app/` serializer
   refinement (trim the mark), not a shell concern. Not logged against the
   experiment.
2. *Cmd-Q didn't quit — fixed.* The programmatic AppKit app installed no
   `NSApp.mainMenu`, so Cmd-Q had nothing to bind to. Added a minimal app
   menu (About/Hide/Quit, Quit -> `terminate:`), which also unblocked the
   flush test (Cmd-Q is how it's exercised). This is the App-menu half of
   Stage 4.4 pulled forward; the Edit menu (dialog text fields) stays
   deferred — the editor's own copy/paste already works via WKWebView, so it
   wasn't touched.

**Shared-state note (worked in practice).** The Zig shell uses the same
app-data dir as production Electron Skrive (`~/Library/Application
Support/Skrive`), so it read Joe's real `app.json` and restored his session,
and writes back to it. Cross-shell state sharing — a plan goal — works on
real state. (No isolation override exists; if experimental writes to
production prefs ever become a concern, add a `SKRIVE_APP_DATA_DIR` env
override.)

**Gate 3 (Part VI — stop-and-decide before Stage 3): CLEAR.** The pass found
no blocker-class problems traceable to the architecture. The two findings are
incomplete-feature (the app menu) and renderer-serializer (the entities) —
neither is the Zig-core/host design. The substrate hosts a real editable
Skrive faithfully.

**Stage 2 exit criteria: ALL MET.** Parity corpus 26/26 (`fs`/`project`-
minus-watch/`persistence`/`app`/`links`/`clipboard`); manual pass green;
dogfooding can begin. The canned spike is now a real native core, command by
command.

**Deferred (carried forward, none blocking).** Stage 4.4 Edit menu; the
window pre-paint color (`#161719`/`#e7e8ea`); housekeeping the now-dead
canned data in `shell-zig/web/sample-data.ts`.

**Next.** Dogfood real writing sessions on the Zig build (friction -> log);
then Stage 3 (the watcher: `project:watch`/`unwatch` + `project:change`
events via `watcher-c`), the one shell primitive with real platform depth.

---

## 2026-06-18 — Stage 3 (the watcher): code-complete, manual pass PENDING

**Branch:** `labs/zig-shell-stage-3-watcher` (off `main` after Stage 2 was
confirmed already merged — see the merge note below). Four commits, one per
sub-stage, all green.

**Merge note (process).** Setting out to "merge Stage 2 to main first," a
local fast-forward + push was rejected: `origin/main` already had Stage 2
via a GitHub rebase-merge (identical trees, new SHAs), so the local
`labs/zig-shell-stage-2-persistence` tip was a stale pre-merge copy. Lesson
logged in memory: check `origin/main` before re-merging a stage branch.

**What shipped.**
- **3.1 — vendor + link.** `e-dant/watcher` vendored in-repo at
  `shell-zig/core/vendor/watcher/` (decision: in-repo over `build.zig.zon`
  fetch — offline, reproducible, one `git rm` from a clean kill). It is just
  three files (the header-only C++ core, the C ABI header, the 77-line C
  shim) + LICENSE + a provenance README. `build.zig` compiles the one C++ TU
  into every artifact that pulls in the core, links libc++, and links
  CoreFoundation/CoreServices (FSEvents) for executables.
- **3.2 — translate + stabilize.** `watcher.zig` maps watcher-c events to the
  renderer's `ProjectChange` shape, matching chokidar rather than improving
  on it. Path filter mirrors chokidar's `ignored` predicate exactly (shared
  `filter.zig` leaf module: NOISE_DIRS / isMarkdown). Renames disambiguated
  by existence (gone side -> unlink, present side -> add), so the backend's
  from/to ordering is irrelevant. Write-finish stabilization rebuilt (80ms
  stable on size+mtime, 30ms poll — the Electron shell's `awaitWriteFinish`
  values, which watcher-c does not provide); unlink + dir events emit
  immediately; create-then-delete before stabilizing is a transient file and
  emits nothing. A dedicated poll thread owns timing; one `Io.Mutex`
  serializes the shared queue/pending map and every allocator op so a
  non-thread-safe allocator stays race-free.
- **3.3 — dispatch + events.** `project:watch`/`unwatch` wired through a
  `WatcherCtl` slot on the Core, reached via `Context.watcher_ctl`
  (single watcher per core; re-watch closes the previous, like the Electron
  `activeWatcher`). The Core's emit bridge turns each stabilized
  ProjectChange into a `{v:1,event:"project:change",payload:{kind,path}}`
  envelope and hands it to the host emit callback.
- **3.4 — host + renderer.** The CoreBridge C emit callback now copies the
  message synchronously then marshals delivery with `DispatchQueue.main.async`
  — the core emits from the watcher's poll thread now, so the callback can no
  longer assume it is on main (exactly the change CoreBridge's header comment
  predicted). `project:watch`/`unwatch` added to NATIVE_COMMANDS. `Skrive.app`
  builds and the Swift host links clean.

**Key decision data — self-write suppression is NOT in the shell.** The
Electron shell forwards every chokidar event faithfully (`ignoreInitial`
aside) and the renderer dedups echoes of the app's own saves via content
hash (`fs.detectExternalChange` against the tab `diskHash`,
`app/src/stores/project.ts`). Per "mirror Electron first," the Zig core emits
faithfully too — no in-core suppression. This removed the trickiest item the
master plan had budgeted for. The plan's guessed 200/50 debounce was also
corrected to the real 80/30 from `shell/src/ipc/project.ts`.

**Toolchain findings (Zig 0.16).**
1. `zig test` runs ALL transitively-reachable `test` blocks, not just the
   root file's. Once dispatch/skrive_core imported watcher, the live e2e test
   ran inside several test binaries IN PARALLEL — a fixed temp-dir name
   collided. Fixed by `std.testing.tmpDir` (unique per run). (This also
   explains the per-target test counts looking inflated since Stage 2.)
2. Threading/sleep moved under the IO model: `std.Thread.{Mutex,sleep}` are
   gone; mutual exclusion is `std.Io.Mutex` (atomics + OS futex — real across
   any OS threads; "single_threaded" in `global_single_threaded` names the
   async scheduler, not a process-wide claim), sleep is
   `std.Io.sleep(io, .fromMilliseconds(n), .awake)`.
3. Cross-target macOS SDK plumbing. Under an explicit `-Dtarget=...macos` Zig
   cross-compiles and does NOT auto-detect the host SDK (Stage 2's pure-Zig
   core never hit this — no C headers). The vendored C++ needs the SDK's
   framework headers AND `usr/include` (Security.framework pulls in
   `libDER/`). Fix: `build.zig` adds both from `b.sysroot`, `build-macos.sh`
   passes `--sysroot "$(xcrun --show-sdk-path)"`, and a `lib` step builds only
   the static archive (the native fixture harness links FSEvents directly and
   stays native). The archive itself links no frameworks — it has no link
   step; the Swift host links them.

**Tests.** `watcher.zig` has two live FSEvents end-to-end tests under a
leak-checking allocator: (1) add / change / unlink + a non-markdown file
filtered out; (2) mkdir->addDir, nested-path add, file rename (unlink+add),
file delete, rmdir->unlinkDir. Plus pure unit tests for the filter predicate
and rel-path mapping. Core suite green; ran the e2e set repeatedly with no
flakiness. Parity corpus 26/26 throughout (events are not request/response,
so they are out of corpus scope — see the gap below).

**HONEST PARITY GAP (logged, not hidden).** The JSONL parity corpus is
request/response only; it cannot cover unsolicited `project:change` events.
Watcher parity therefore rests on the Zig mutation tests above plus the
side-by-side manual pass below — not on fixture replay. This is the one
namespace the corpus does not gate.

**3.5e — MANUAL PASS: PENDING (Joe).** The assembled
`shell-zig/macos/.build/Skrive.app` is ready. Hands-on gate, side by side
with the Electron build:
1. Open a project in the Zig build. In another editor (or Finder), edit a
   `.md` file in that project -> Skrive's view updates (the watch-sync
   re-reads + the editor shows the external change / conflict prompt),
   exactly as Electron does.
2. Create a new `.md` file externally -> it appears in the sidebar.
3. Delete a file externally -> it disappears from the sidebar.
4. Rename a file externally -> old name gone, new name present.
5. Create a folder + a file inside it externally -> both appear.
6. Confirm the app's OWN autosaves do NOT cause spurious conflict prompts
   (renderer hash-dedup working).
7. Soak: leave it watching during a normal writing session; watch for
   runaway memory or CPU from the poll thread. Friction -> this log.

**Status: Stage 3 code-complete and headless-verified; 3.5e manual pass is
the remaining exit gate.** Deferred items unchanged (window pre-paint color;
dual-shell embed-default drift guard; Stage 4.4 Edit menu).

**3.5e finding #1 (FIXED) — host crash on the first external edit.** First
dogfood touch (editing a watched `.md` in Obsidian) crashed the Zig build
(`SIGTRAP`, `dispatch_assert_queue_fail`) while Electron stayed up. Crash
report: faulting thread = the watcher poll thread,
`pollPending -> emit -> watcherEmitBridge -> CoreBridge emit closure ->
swift_task_isCurrentExecutor`. Root cause: the C emit callback was a closure
created inside the `@MainActor CoreBridge.init`, so Swift 6 treated it as
MainActor-isolated and asserted the executor AT CLOSURE ENTRY. Synchronous
responses always enter on main (pass); the watcher emits from its poll thread,
where the entry check trapped before the body's `DispatchQueue.main.async`
could hop. Fix (`7eee15c`): hoist the callback to a top-level `nonisolated`
function (also the only form that makes a C function pointer — a
static-method reference does not), copy synchronously, dispatch to main.
**This is a host-layer Swift-concurrency detail, not a Zig-core/architecture
blocker** — the core's threaded emit was correct; the host just couldn't be
re-entered off-main (same class of incomplete-host-detail as the 2.5e Cmd-Q
menu). Gate 3 stays clear. Retest pending.

**Not a bug — expected: editing an OPEN document externally doesn't live-update
the editor.** Both shells deliberately do not reload an open tab's buffer from
disk (that would clobber unsaved edits); the watcher updates the project MODEL
(sidebar/backlinks/lint) and a disk drift surfaces as a conflict prompt on the
next save (`detectExternalChange` vs the tab `diskHash`). So the watcher pass
should be judged by SIDEBAR reaction to create/delete/rename, not by an open
document's text changing. (Joe observed Electron "not showing" an Obsidian edit
to an open file — that is this by-design behavior, identical in both shells.)

**3.5e finding #2 (FIXED, `11fc4a4`) — delete-to-Trash was invisible; the one
real library limitation in Stage 3.** Dogfooding: deleting a `.md` in Obsidian
left a stale, un-clickable node in the Zig sidebar (gone on disk, still in the
model) while Electron removed it; renaming had left a duplicate earlier (same
root cause — the unlink half lost). Diagnosed with a temporary file-based event
logger (libc `fopen` to `/tmp/skrive-watch.log`, always-on, thread-safe,
launch-method-independent — env-gated stderr was too fragile; the logger was
removed before commit). Ground truth: a real `unlink` (Obsidian's `.OBSIDIANTEST`
probe) came through as `effect=destroy`, but a move-to-Trash produced NO
watcher-c callback at all. Root cause in the vendored `watcher.hpp`
Apple/FSEvents branch: it only emits a rename when it can PAIR a renamed-from
and renamed-to event inside the watched tree (stashes the from-path in
`last_rename_path`, waits for the to-path). A move whose destination is outside
the tree — exactly a delete-to-Trash, the common macOS delete — stashes the
from-path and never emits. chokidar (Electron) does NOT pair; it checks each
path's existence and emits unlink/add separately. Fix (Joe-approved, forks the
vendored lib — documented in `vendor/watcher/README.md` "Local modifications"):
patch the FSEvents rename branch to emit destroy if the path is now missing,
create if it exists. Our Zig layer already splits renames into unlink+add, so
pairing was unneeded; the patch also fixes moves INTO the tree. Verified: a
move-to-Trash now arrives as `effect=destroy` -> `unlink`, file disappears at
parity with Electron.

**TWO build-cache traps burned real time this session — both now mitigated, log
loudly.** (1) **SwiftPM never relinked** the host when only the Zig core
changed: it does not track the `.a` (linked via `unsafeFlags`) as an input and
content-hashes sources, so every "rebuild" silently reused an OLD host binary
linked against a STALE `libskrive_core.a`. Fixes to the core (and the
nonisolated crash fix, and the logging) appeared to have no effect because the
running app never contained them. `touch`-ing sources did NOT help (content
hash, not mtime). FIX (`f891cf9`): `build-macos.sh` removes the linked product
before `swift build`, forcing a relink (~1s, objects cached). (2) **Zig's C
cache didn't invalidate `watcher-c.o`** when the included `watcher.hpp` header
changed, so the patched header didn't reach the `.a` until `rm -rf
core/.zig-cache`. Rarer (the vendored header almost never changes), so not
scripted around — but if a `vendor/` header edit ever "doesn't take," clean the
zig cache. **Lesson: when a native change seems to have no effect, verify the
artifact actually contains it (check the SwiftPM bin-path binary mtime vs the
`.a`, or a runtime marker) BEFORE re-debugging the logic.**

**Stage 3 status now: all known watcher bugs fixed** (crash on external edit
`7eee15c`; delete-to-Trash `11fc4a4`). Rename, create, delete, and external
edit all behave at parity with Electron in dogfooding.

**3.5e manual pass: GREEN (2026-06-22). Stage 3 COMPLETE; merged to `main`.**
Joe's hands-on pass, side by side with Electron: external edit (no crash),
file create/delete (delete-to-Trash now removes from the sidebar), file
rename (no duplicate), and — final check — Finder directory operations:
create folder -> addDir, nested `.md` -> add under it, delete folder
(to Trash) -> unlinkDir, all at parity, no issues. The directory-trash path
exercises the same FSEvents move-out the `11fc4a4` patch fixed (it emits
destroy/create regardless of path type; the Zig layer maps `path_type=dir`
-> addDir/unlinkDir), and the renderer prunes the subtree cleanly on
unlinkDir. Branch `labs/zig-shell-stage-3-watcher` fast-forwarded to `main`
(linear history, no merge commit). Stage 4 (diff via the Rust staticlib,
then history) is next.

---

## 2026-06-22 — Stage 4 scope decision: diff/checkpoints/git NOT ported

**Branch:** `labs/zig-shell-stage-4-native-shell` (off `main`).

**Decision (Joe).** Stage 4 is reduced to **4.0 (native app-shell parity)
+ 4.4 (host polish + closing sweep)**. Sub-stages **4.1 (diff), 4.2
(checkpoints), 4.3 (git history) are dropped** — not ported to the Zig
shell. Reasoning surfaced this session:

- Diff, checkpoints, and git-history are stand-in version-history features
  that assume Markdown/git conformity (history = git commits or a non-git
  checkpoint *fallback*; change view = line diff over Markdown source).
  Skrive is graduating away from that framing (positioning: a writing+notes
  app, Markdown demoted to storage/transport plumbing).
- Porting features slated for replacement is exactly the wasted parity work
  this plan's own kill-criteria name. The labs migration must not "bridge on
  feature work that is rushed."
- The current **Electron** diff/git/checkpoint features stay shipping and
  **untouched** (no rip-out ahead of a replacement, so no no-history
  regression window). The Zig build keeps them **mocked** in
  `shell-zig/web/sample-data.ts`; they never enter the Zig core, and the
  parity corpus never includes them. (The corpus already had no diff/history
  fixtures — those were to be generated in 4.1-4.3 — so nothing is removed.)
- A **Skrive-native version history** is a real but **deferred** future
  feature: document-model-aware (block/semantic, aligned with the editor
  north-star / bespoke-core direction), git-independent (no repo assumption,
  owns its storage rather than being the non-git fallback), with git demoted
  to an optional later integration. Designed fresh, pure-JS-first in `app/`
  under the feature-placement rule (both shells + a fixture when it earns
  shell commands) — not now.

**File-open also deferred from 4.0.** Investigating the 4.0 file-open /
`.md`-association item showed the master plan's claim that it "rides the
existing contract" is wrong: there is no host->renderer open verb in
`shared/src/ipc-contracts.ts`, `App.tsx:196` literally calls it "the URL
handler we don't have yet," and the Electron main has no `app.on('open-file')`
/ `open-url` handler (the associations are declared in `electron-builder.yml`
but the open event is unhandled). So opening a double-clicked `.md` and
focusing it is net-new cross-shell feature work, not host chrome — it belongs
to the future open-with/version-history track. Deferring it makes 4.0
genuinely host-only: zero `app/`/core/contract changes. The master plan's
Stage 4 section was annotated with this scope decision (4.1-4.3 prose kept for
history, marked DEFERRED; the file-association bullet struck through).

**Stage 4 as it will execute:**
- **4.0** — host-only Swift in `shell-zig/macos/`: full standard menu bar
  (Edit/View/Window/Help via first-responder selectors), `WKNavigationDelegate`
  / `WKUIDelegate` external-link + window-open policy through the existing
  `links:openExternal` allowlist, `WKWebView.isInspectable` (dev-gated),
  pre-paint window background corrected to `#161719`/`#e7e8ea`.
- **4.4** — dock-icon light/dark swap; verify `persistence:revealUserData`;
  full side-by-side manual parity checklist.

**Housekeeping this commit.** Landed the previously-uncommitted master-plan
Stage 4 elaboration (4.0 section, native-feel-deference, iOS row) onto the
branch; reverted dogfooding noise on the `typography-sample` parity fixture
(stray frontmatter removal). Untracked release artifacts (DMG/zip) and scratch
`.md` files left alone.

---

## 2026-06-22 — Stage 4.0: native app-shell parity. Manual pass GREEN.

**Branch:** `labs/zig-shell-stage-4-native-shell`. Host-only Swift in
`shell-zig/macos/`; zero `app/`, core, or contract changes.

**What shipped.**
- **Full standard menu bar** (`AppDelegate.setupMenu`) replicating Electron's
  *default* macOS menu via first-responder selectors so WKWebView's first
  responder handles them in the editor and in dialog fields: App
  (About/Services/Hide/Hide-Others/Show-All/Quit), Edit
  (undo/redo/cut/copy/paste/paste-and-match/delete/select-all), View
  (reload, full screen), Window (minimize/zoom/close-Cmd-W/bring-all-to-front),
  Help. Default menu only — no app-specific File items (New/Open/Save live in
  the renderer palette; scope guard from the plan). Close lives in Window (no
  File menu) so Cmd-W binds.
- **Link / navigation policy.** `WKNavigationDelegate.decidePolicyFor` allows
  the app + asset origins and renderer-internal schemes (about/blob/data),
  routes the Part I allowlist (http/https/mailto/tel/skrive) to the browser
  and cancels, and refuses any other scheme — the main frame can never leave
  `skrive-app://`. `WKUIDelegate.createWebViewWith` opens `target=_blank` /
  `window.open` externally and returns nil (no popup webview). The allowlist
  is centralized in a new `ExternalLink` helper shared with the bridge's
  `links:openExternal` (single source of truth).
- **Pre-paint background** corrected `#1a1a1a`/`#fefcf7` -> `#161719`/`#e7e8ea`
  (the current Electron values).

**GOTCHA (real bug, caught by a compiler warning).** The first cut of
`decidePolicyFor` typed its `decisionHandler` as `@escaping (...) -> Void`,
but the protocol requirement is `@escaping @MainActor @Sendable (...) -> Void`.
The mismatch made it a *near-miss* overload, NOT the protocol method — WebKit
would never have dispatched to it and the link guard would silently no-op.
Swift flagged it as "nearly matches optional requirement"; matching the exact
closure type fixed it. Lesson: treat "nearly matches optional requirement"
warnings on delegate conformances as correctness bugs, not style noise.

**SUBSTRATE / HOST FINDING (Web Inspector).** Dogfooding turned up "can't use
a web inspector." Bisected it with runtime introspection (temporary
diagnostics, since removed): `webView.isInspectable == true`, `_inspector`
returns a valid `_WKInspector` that responds to `show`/`isVisible` — but
calling `show` leaves `isVisible == false`. **The private programmatic
`_WKInspector.show()` is a silent no-op on macOS 26.** So a menu/keyboard
"Toggle Developer Tools" affordance cannot work via private API on this OS;
it was removed rather than left as a dead control. The *supported* entry
points do work: **Safari's Develop menu** (Develop > this Mac > Skrive —
confirmed by Joe) and right-click "Inspect Element" (reinforced with the
legacy `developerExtrasEnabled` preference alongside `isInspectable`, both
dev-gated). This is a host/OS detail, not an architecture issue — Gate stays
clear; logged in the native-feel/substrate-finding mold.

**Dev gate.** `#if DEBUG` is confirmed active in the SwiftPM debug build
(`build-macos.sh` defaults to debug), and `isInspectable`/`developerExtras`
are gated on it, so a future `-c release` build ships without the inspector.

**Manual pass: GREEN (Joe, side by side with Electron).** Editing shortcuts in
the editor and dialog fields, Cmd-W/Cmd-M/zoom/full-screen, external links
opening in the browser without disturbing the app, no stale launch flash, and
the Web Inspector opening via Safari's Develop menu. Stage 4.0 done; 4.4
(dock-icon light/dark swap, `revealUserData` verify, closing parity sweep) is
the remaining Stage 4 work.

---

## 2026-06-22 — Stage 4.4: host residual polish + the closing parity sweep

**Branch:** `labs/zig-shell-stage-4-native-shell`.

**Dock-icon light/dark swap — SKIPPED for the labs build (Joe's call).** The
Electron shell swaps the *running* dock tile between a light and a dark PNG on
every system-appearance change (`applyDockIcon`, `index.ts:43-57`), because
macOS never swaps a flat `.icns` for dark mode. Replicating it needs both a
light and a dark tile, but the Zig host ships only a single dark `skrive.icns`
(intentionally a distinct brand mark from the Electron build's icon), and no
light variant of that mark exists. Producing a brand asset for a pure-polish
swap on the experimental build is exactly the marginal work the Stage 4 scope
trim says to avoid, so this is deferred. **Logged minor parity gap:** the Zig
dock tile is static across appearances; revisit if/when the build graduates and
a light mark exists. No code change.

**`persistence:revealUserData` — verified at parity (code review).** Core
(`dispatch.zig:184`) handles the command by emitting a `host:reveal` envelope
carrying the app-data dir; the host (`CoreBridge.swift:244`) opens that folder
with `NSWorkspace.shared.open(URL)`. Electron (`persistence.ts:52`) does
`shell.openPath(app.getPath('userData'))`. Both open the same shared folder
(`~/Library/Application Support/Skrive`) in Finder — a match (open-the-folder,
not reveal-and-select, on both sides). Already in `NATIVE_COMMANDS`, so served
by the core. Manual confirm folded into the sweep below. No code change.

**CLOSING PARITY CHECKLIST (run side by side with the Electron build).** This
is the Stage 4 exit gate. Diff/history are out of scope (the corpus excludes
them; the Zig build serves them from the mock by design) and the dock-icon
swap is a logged gap; everything else must match.

*Host chrome (4.0, re-confirm):*
1. Menu bar: Edit shortcuts work in the editor (Text + Rich) and in a dialog
   text field; Cmd-W / Cmd-M / Zoom / Toggle Full Screen work.
2. Links: an http(s) link in a note opens in the browser; a `mailto:` opens
   Mail; no link click navigates or blanks the app frame; no stray popup.
3. Web Inspector opens (Safari Develop > this Mac > Skrive).
4. No stale launch flash; pre-paint background matches first paint.

*Files + editing (`fs`):*
5. Edit a doc, autosave fires, content survives Cmd-Q + relaunch.
6. New file, rename (with reference rewrites), delete-to-Trash all behave as
   in Electron.
7. Edit a file externally while open -> conflict prompt on next save
   (`detectExternalChange`).
8. Images render in preview (`skrive-asset://`).

*Project + persistence:*
9. Open project (dialog) and create project (with/without git init).
10. 500-file perf fixture opens and renders the sidebar.
11. UI state (open tabs, panel widths, theme) restores on relaunch.
12. `revealUserData` opens `~/Library/Application Support/Skrive` in Finder.

*Renderer worker features (shared `app/`, must be identical):*
13. Search, backlinks, dead links, orphans, rename-with-references.

*Watcher (Stage 3, re-confirm under a real session):*
14. External create / delete / rename / folder ops reflect in the sidebar; the
    app's own autosaves don't trigger spurious conflict prompts.

*Native-feel dogfooding lens (note findings, not a hard gate):*
15. Scroll/caret/selection/IME/dead-keys feel native on WebKit across both
    editor surfaces; log any Chromium-vs-WebKit divergence.

**Parity corpus: 26/26 GREEN both directions** — against the Zig core
(`--exec ./shell-zig/core/zig-out/bin/fixture_main`) and against the live
Electron oracle (`bun run parity:check`). 4.0/4.4 touched no core code, so this
also confirms no regression.

**CLOSING SWEEP: GREEN (Joe, 2026-06-22). STAGE 4 COMPLETE.** Hands-on
side-by-side pass against Electron: "everything looks and feels good" — host
chrome, files/editing, project/persistence (incl. `revealUserData`), worker
features, and the watcher all at parity; native feel good on WebKit across both
editor surfaces. The two intentional differences held as designed: diff/history
served from the mock (deferred, not ported — see the scope decision), and a
static dock tile across light/dark (logged gap).

**Stage 4 outcome (reduced scope).** macOS native app-shell parity reached: the
Zig build is feature-indistinguishable from Electron on everything in scope and
is now a livable daily driver. 4.1-4.3 (diff/checkpoints/git) deliberately not
ported; a Skrive-native version history is a deferred future feature. Honest
residual gaps, all logged, none blocker-class: dock-icon appearance swap;
file-open/`.md`-association (net-new cross-shell feature, deferred); updater
(Stage 6). Substrate findings this stage: the `decidePolicyFor` closure-type
trap, and `_WKInspector.show()` no-op on macOS 26 (use Safari Develop /
right-click). Next: Stage 5 (Windows host) or the deferred feature tracks, per
Joe's direction.

---

## 2026-06-22 — Stage 5.0: host-language decision (ZIG) + cross-compiled skeleton

**Branch:** `labs/zig-shell-stage-5-windows-host` (off `main`).

**Decision: the Windows host is written in ZIG**, not the master plan's C++
default or its C# contender. This was a `[CONFIRM WITH JOE]` gate; Joe's call,
leaning Zig because it matches the thesis best ("it's from scratch and if it
doesn't work then we know what we need to do"). The plan's table is corrected
in place (the dismissal was feasibility-wrong).

**Research that drove it (current 2025-2026 facts, sources in the session).**
- *Native AOT cannot cross-OS compile* (MS docs, explicit): a win-x64 AOT
  binary must be built ON Windows. That kills the plan's "C# + CsWin32 + Native
  AOT middle path" as a *primary dev loop* under the develop-on-Mac constraint.
- *The official managed `Microsoft.Web.WebView2.Core` is not AOT-clean*
  (WebView2Feedback #4800); C#+AOT only works via the third-party
  `smourier/WebView2Aot`. Non-AOT C# *does* `dotnet publish` from macOS — the
  only first-class Mac-dev path among the managed options, but it re-adds a
  60-80MB managed runtime (philosophically the same animal the experiment is
  shedding).
- *Zig-as-host is feasible, contra the plan's table.* `awesomo4000/turf` is a
  live pure-Zig, C++-free WebView2 COM binding (hand-declared vtables, ships
  `WebView2Loader.dll` for x86/x64/aarch64, cross-builds to Windows from Zig
  alone). Rust's `webview2-com` is the maintained alternative. The hand-rolled
  COM surface for our thin shim is ~500-1000 LOC; the callback COM objects +
  refcounting are the bug-prone part.
- *Same ceiling for every language:* WebView2 is Windows-only, so any host can
  only be BUILT on macOS, never RUN. The language choice is about build/iteration
  ergonomics and COM-glue maintenance, not Mac-side running.
- *Raycast's new platform* (technical deep-dive) independently validates the
  ARCHITECTURE — native shells wrapping system WebViews (WKWebView / WebView2),
  one shared React+TS frontend, no Electron — but chose C#+.NET8+WPF, no AOT,
  350-450MB RSS: the heavy end, different priorities. Validates the shape, not
  the C# pick for Skrive's lean goal.

**Decision matrix (develop-on-Mac + lean thesis are the deciding axes).**

| Option | Build from Mac | Installer size | COM/maint. risk | New language |
|---|---|---|---|---|
| **Zig host (chosen)** | cleanest (no MSVC/SDK/xwin) | smallest, no runtime | own ~500-1000 LOC glue forever | none (matches core) |
| C# non-AOT | full `dotnet publish` | +60-80MB runtime | lowest (managed wrapper) | +.NET |
| C# + AOT | cannot (AOT needs Windows) | small native | 3rd-party `WebView2Aot` | +.NET |
| Rust (webview2-com) | cross-compiles (xwin), can't run | small, no runtime | maintained binding | +Rust |
| C++ (old default) | cross-compiles, can't debug COM | smallest | hand WRL/COM | +C++ |

**Honest risk accepted:** we own the WebView2 COM binding forever (no upstream),
and Zig is pre-1.0. Turf de-risks feasibility; maintenance is the standing cost.

**What was built (the question 5.0 answers: does a unify-on-Zig host link the
EXISTING core — C++ watcher and all — into a runnable Windows binary, built
entirely on a Mac? YES).**
- `shell-zig/core/build.zig`: expose the core as a consumable `skrive_core` Zig
  module (`addModule`), with the vendored watcher C++ TU + libc++ riding along.
  Purely additive — nothing in the existing lib/fixture/test graph depends on
  it, so native macOS builds are byte-for-byte unaffected (parity stayed 26/26).
- `shell-zig/windows/`: a path-dependency package (`build.zig` + `.zon` +
  `src/main.zig`). The host imports the core module and calls the **native
  `Core` API directly** — no C-ABI marshaling between a Zig host and a Zig core;
  the C ABI stays reserved for the foreign Swift host. `main.zig` is a bare
  Win32 window (RegisterClassExW / CreateWindowExW / standard message loop,
  Win32 hand-declared in the Turf idiom) plus an `app:version` round-trip
  through the core before the window opens (emit → stderr for now; 5.1 swaps it
  for ExecuteScript into WebView2). Defaults to `x86_64-windows-gnu` so a plain
  `zig build` from macOS produces the exe.

**0.16 std findings (logged as data; no spec deviation — the host owns these
hand-declarations either way).** `std.os.windows` in 0.16 dropped `WINAPI`
(use `callconv(.winapi)` / `std.builtin.CallingConvention.winapi`) and
`WPARAM`/`LRESULT`, and made `BOOL` a wrapper type. Declared the ABI-identical
primitives locally (`WPARAM=usize`, `LPARAM/LRESULT=isize`, `BOOL=i32`) so the
message loop compares against plain ints. The base handle/`LPCWSTR`/`ATOM` types
are still in `std.os.windows` and reused.

**Toolchain de-risk (the big result).** The pre-existing core — every Zig source
plus the vendored e-dant/watcher C++ TU under libc++ — cross-compiles to
`x86_64-windows` from Apple-Silicon macOS with no external toolchain
(`zig build lib -Dtarget=x86_64-windows` produced `skrive_core.lib`). So the
core needs **zero changes** for Windows; the Stage 5 "any core change is a design
bug" gate is clear so far. `linkWatcher`'s macOS-framework branch is already
os-tag-guarded, so it no-ops cleanly on Windows.

**Gates — MET.** `Skrive.exe` is a valid PE32+ cross-compiled from macOS; core
unit tests exit 0; core native build exit 0; **parity corpus 26/26** against
`fixture_main` (core unchanged); `zig fmt --check` clean on the host + build
files; `.gitignore` extended for `shell-zig/windows/{zig-out,.zig-cache}`. The
exe RUNS only on Windows — the `app:version` proof-of-life and the window first
appear at the 5.1 first-light gate (Joe, on Windows).

**Next.** Stage 5.1 — WebView2 environment + controller on the HWND; serving
(empirical pick: virtual-host mapping vs `WebResourceRequested` vs custom scheme,
mirroring the macOS 1.2 bake-off incl. secure-context / module workers); the
message bridge (`WebMessageReceived` in → `Core.handle` → emit → `ExecuteScript`
out, reusing the delivery rule + a Zig `JSEscape`); the Windows renderer
transport (`window.chrome.webview`); the injection round-trip. This is the first
hand-rolled WebView2 COM glue (Turf / `webview2-com` as references) and the first
Windows-run gate.

---

## 2026-06-22 — Stage 5.1: WebView2 host, the message bridge, serving (code-complete; Windows-run gate pending)

**Branch:** `labs/zig-shell-stage-5-windows-host` (continued).

**The heart of the Zig-host bet: the hand-rolled WebView2 COM glue, all
cross-compiled from macOS.** None of it RUNS until it is on Windows, so
correctness comes from references, not the compiler — the ABI is anchored to
the real `WebView2.h` (SDK 1.0.3351.48): vtable slot orders and IIDs
transcribed verbatim, not reconstructed.

**Modules (`shell-zig/windows/src/`).**
- `win32.zig` — the Win32 surface (window class, message loop, dynamic-load +
  GetProcAddress, GetClientRect, SetWindowLongPtr back-pointer, PostMessageW,
  CoTaskMemFree). The 0.16 primitives (WPARAM/LRESULT/BOOL) re-declared locally.
- `webview2.zig` — the COM ABI. Interfaces consumed (Environment, Controller,
  ICoreWebView2_3, WebMessageReceivedEventArgs) plus IUnknown for QI/Release. A
  GUID comptime-parser builds the IIDs. **Correctness tactic against the ~73-slot
  vtables: only the methods the host calls are given real signatures; every
  other slot is a pointer-sized `Slot` filler grouped into array runs whose
  lengths are audited against the header slot numbers in comments** — a wrong
  count is then visible by arithmetic and can't silently shift a real method's
  offset. The loader entry point is resolved dynamically from
  `WebView2Loader.dll` (no MSVC import lib at build → clean cross-compile).
- `handlers.zig` — the three COM objects the host IMPLEMENTS (env-created,
  controller-created, web-message). Each is an `extern struct` (vtable pointer
  first, so `*Handler` is a valid interface pointer) + a plain callback + ctx,
  decoupled from `app.zig` to avoid an import cycle. AddRef/Release are no-ops
  returning 1 (app owns them for life); QueryInterface answers IUnknown + the
  handler IID.
- `app.zig` — orchestration: window -> CreateEnvironment -> onEnvCreated:
  CreateController(hwnd) -> onControllerCreated: get the webview, QI to _3, map
  the virtual host, inject the bridge, subscribe to web messages, size +
  navigate. Bridge: renderer->host via `TryGetWebMessageAsString` -> `Core.handle`;
  host->renderer via the core's emit.
- `jsescape.zig` — the delivery-rule escaper, a byte-for-byte port of the macOS
  `JSEscape.swift`, **with unit tests that RUN on the native build host** (the
  one part of 5.1 verifiable on macOS — green: structural escapes, `</script>`
  neutralization, U+2028/2029, C0 controls, UTF-8 passthrough).
- `shell-zig/web/native-bridge-win.ts` — the Windows renderer transport
  (`window.chrome.webview.postMessage` out, `__skriveDispatch` in;
  `app:platform` -> `win32`). Deliberately a separate file from the macOS
  `native-bridge.ts` so that bundle stays byte-identical; DRYing the two is a
  later refactor once both shells build in one place.

**Serving decision (deviation from the plan's framing, logged).** The master
plan describes serving via `WebResourceRequested` interception. For the app
origin, `ICoreWebView2_3::SetVirtualHostNameToFolderMapping` is the simpler
equivalent: it maps `http://skrive.app/` to the on-disk `renderer/` dir, giving
a real web origin (ES modules + module workers load, unlike `file://`) with a
fraction of the COM surface. Request interception is reserved for the asset
origin (the `skrive-asset://` equivalent with path containment) in 5.2.
`index.html` uses relative `./assets/...` paths, so root-mapping serves it as-is.

**UI-thread marshaling implemented now, not deferred.** Every core emit is
copied (c_allocator, thread-safe) and `PostMessage(WM_SKRIVE_EMIT)`'d to the
window, so `ExecuteScript` always runs on the UI thread, FIFO-ordered — the
Windows analogue of the macOS host's `DispatchQueue.main.async`. This is needed
from the start because once a project opens, the Stage 3 watcher emits
`project:change` from its own poll thread and WebView2 is UI-thread-affine
(the macOS host learned this as a SIGTRAP).

**0.16 finding.** `extern struct` fields that are function pointers must specify
a calling convention, so the handlers' Zig callbacks are typed `callconv(.c)`
(the `app.zig` `on*` callbacks too). The COM vtable slots use `callconv(.winapi)`
(the single Win64 convention; the hidden `this` is the first arg).

**ABI-risk spots flagged for the first Windows run (compile-verified only).**
(1) `ICoreWebView2Controller::put_Bounds(RECT)` passes a 16-byte aggregate by
value; on Win64 that is lowered to a hidden pointer, which Zig's
`callconv(.winapi)` should do — first thing to check if the webview renders at
zero size. (2) The QI from the base `ICoreWebView2` up to `_3`, and the
`SetVirtualHostNameToFolderMapping` slot at absolute vtable index 72, depend on
the filler-run arithmetic being exactly right. (3) `userDataFolder` is null
(defaults next to the exe; 5.2 points it at `%APPDATA%/Skrive`).

**Assembly.** `shell-zig/build-windows.sh [x64|arm64] [debug|release]` mirrors
`build-macos.sh`: renderer bundle -> bundle `native-bridge-win.ts` to an IIFE ->
`zig build -Dtarget` -> stage `shell-zig/windows/dist/` (Skrive.exe +
`renderer/` + `native-bridge.js` + `WebView2Loader.dll`). The whole bundle is
produced on macOS; `dist/` is what gets copied to Windows. `WebView2Loader.dll`
for x64/arm64 vendored in-tree (`vendor/webview2/`, from NuGet 1.0.3351.48).

**Gates — MET (build/assembly + Mac-runnable logic).** The full host
cross-compiles to a PE32+ from macOS; `build-windows.sh x64` assembles a
runnable `dist/`; the bridge TS bundles (8.4 KB IIFE) clean; `jsescape` unit
tests green; core unit tests green and **parity 26/26** (core still byte-for-byte
unchanged — the Stage 5 "no core changes" gate holds); `zig fmt` clean; repo
typecheck clean.

**PENDING — the 5.1 done-criteria are Windows-gated (Joe).** Copy
`shell-zig/windows/dist/` to a Windows machine (Win11 has the WebView2 runtime
by default) and run `Skrive.exe` from a terminal (console subsystem prints
HRESULT diagnostics). Gate: the UI renders (welcome state), `app:version`
round-trips renderer -> host -> Zig core -> renderer, no console errors. The
injection round-trip (`diag:poison`) test harness is deferred to a follow-up
within 5.1 once first light is confirmed. If the window is blank, the flagged
ABI-risk spots above are the first suspects.

**Next.** Joe's first Windows run. If green: Stage 5.2 (host feature fill —
dialogs, trash, clipboard CF_HTML, open-external, single-instance, %APPDATA%,
NTFS watcher) and the asset-origin request interception. If red: the diagnostics
narrow it to serving, the bridge, or a vtable offset.
