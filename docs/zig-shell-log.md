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
