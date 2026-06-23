# Zig Shell Master Plan

**Status.** Plan complete, 2026-06-10. Execution not started.

**Goal.** Build a second Skrive shell — a Zig core with a Swift host on macOS and a C++ host on Windows, driving the system webview — that runs the existing React frontend byte-identical and matches every shipped Skrive feature, while keeping the Electron shell green throughout. The endgame is a side-by-side comparison of two complete Skrives on two substrates, decided by use, not by argument.

**Companion documents (read before executing any stage):**
- `docs/Zig shell audit.md` — what the current codebase provides and where the coupling is
- `docs/Zig shell ecosystem survey.md` — verified library picks, platform constraints, and the secure-context findings this plan builds on
- `docs/Ledger-criteria.md` — what this project does NOT claim to solve (webview ceilings)

---

## How to use this document

This section is addressed to the model or person executing the plan.

1. **Work one sub-stage at a time.** Each sub-stage is sized to be completable in a single focused working session and ends with verifiable acceptance criteria. Do not start a sub-stage until the previous one's criteria all pass.
2. **Never modify `app/` or `shared/` except where a sub-stage explicitly says to.** The frontend is the shipping product. Stage 0 changes it deliberately and ships those changes through the Electron build; later stages treat it as read-only.
3. **The Electron build must stay green at every step.** After any change to `app/`, `shared/`, or `shell/`: run `bun run typecheck` and the vitest suites (`cd app && bun run test`, `cd shell && bun run test`). A sub-stage is not done while these fail.
4. **When blocked, stop and write down the blocker** in `docs/zig-shell-log.md` (create it on first use; one dated entry per session: what was attempted, what passed, what blocked). Do not improvise around a failed gate — the gates exist to produce decision data.
5. **Specifications in this document win over inference.** If the envelope spec here conflicts with something you'd naturally write, write what the spec says. If the spec is genuinely wrong, log it and stop.
6. **Anything marked `[CONFIRM WITH JOE]` requires explicit approval before doing.** These are destructive or product-visible decisions.
7. **No emojis anywhere. Conventional commits. One concern per commit.** Branch naming: `labs/zig-shell-<stage>` (e.g. `labs/zig-shell-stage-0-envelope`). Stage 0 work that ships to the Electron product uses normal `feat:`/`refactor:` branches off `main`.

---

## Part I — Target architecture

### Repository layout (monorepo, not a clone)

The frontend is shared. Two shells consume it. A clone would fork the product; this layout keeps the experiment one `git rm -r` from a clean kill.

```
app/                  # React frontend — ONE copy, used by both shells
shared/               # IPC contract + types — ONE copy, used by both shells
shell/                # Electron shell (shipping product)
shell-zig/            # This plan's deliverable
  core/               # Zig: dispatcher, fs, project, persistence, watcher glue
    build.zig
    build.zig.zon
    src/
  macos/              # Swift host: window, WKWebView, bridge, dialogs, Sparkle
  windows/            # C++ host: window, WebView2, bridge, dialogs, WinSparkle
  fixtures/           # Parity corpus (generated in Stage 0.6)
  README.md           # Build order, envelope spec pointer, conventions
native/diff/          # Rust diff crate — gains a staticlib C-ABI target, stays Rust
```

### Language assignment and rationale

| Layer | Language | Why |
|---|---|---|
| Command dispatch, FS sandbox, project snapshot, persistence, checkpoints, git-spawn history, watcher integration, asset embedding | Zig | The experiment's subject. Kept deliberately small (~3k lines target) — shell primitives only |
| macOS host (window, WKWebView, scheme/file serving, message bridge, NSOpenPanel, trash, NSWorkspace, Sparkle, dock icon) | Swift | Every needed API is first-class AppKit/WebKit. The Ghostty pattern: Zig core behind a C ABI, native shell per platform |
| Windows host (window, WebView2 COM, serving, bridge, dialogs, WinSparkle, single-instance) | Zig (decided at Stage 5.0; was "C++ default / C# evaluated") | CORRECTED 2026-06-22: the old note "no maintained Zig WebView2 binding exists" is feasibility-wrong — `awesomo4000/turf` is a live pure-Zig, C++-free WebView2 COM binding (hand-declared vtables, cross-builds to Windows incl. aarch64 from Zig alone). Zig wins on the two axes that actually decide it here: cleanest cross-build from the macOS dev machine (no MSVC/Windows-SDK/xwin), and the lean thesis (smallest binary, no managed runtime, no new language — it matches the core). Native AOT (the plan's "middle path") was killed by the fact that it cannot cross-OS compile. Full decision data in the log's 2026-06-22 Stage 5.0 entry |
| Structural diff | Rust (unchanged) | `native/diff` compiles as `staticlib` with a C ABI and links into the Zig binary. No port, no NAPI |
| Link graph, search, frontmatter, schema inference, lint, all editor logic | TypeScript (renderer/workers) | Pure text analysis; keeping it JS keeps it malleable and identical across both shells |

### Process and data-flow model

One native process (host + Zig core linked together), one webview. The renderer is sandboxed by construction: it has no capability except the bridge.

```
renderer (app/)  --postMessage JSON-->  host (Swift/C++)  --C ABI-->  Zig core
renderer (app/)  <--dispatch callback--  host             <--C ABI--  Zig core
```

- The host owns: window, webview, native dialogs, trash, open-external, clipboard, updater, menu/dock. It forwards everything else to the Zig core verbatim.
- The Zig core owns: command dispatch, all file I/O, project snapshot, persistence files, checkpoints, git spawning, the watcher, diff (via the Rust staticlib).
- The C ABI between host and core is two functions plus one callback:

```c
// Host -> core. `request_json` is a full request envelope. The core replies
// asynchronously via the callback (same thread or core-owned thread pool;
// the host marshals the callback back to the webview's thread).
void skrive_core_handle(SkriveCore* core, const char* request_json);

// Core -> host. `message_json` is a response or event envelope.
typedef void (*SkriveCoreEmit)(void* userdata, const char* message_json);

SkriveCore* skrive_core_create(const char* config_json, SkriveCoreEmit emit, void* userdata);
void skrive_core_destroy(SkriveCore* core);
```

All strings are UTF-8, NUL-terminated, owned by the caller for the duration of the call; the core copies what it keeps. `config_json` carries the app-data directory, project defaults, and the markup extension set (see Part V).

### The envelope (normative)

Every message between renderer and shell is one JSON object. This spec is shared by the Electron shell (after Stage 0), the Zig shell, and any future web shim.

```jsonc
// Request (renderer -> shell)
{ "v": 1, "id": 42, "cmd": "fs:readFile", "payload": { "projectRoot": "...", "relPath": "..." } }

// Success response (shell -> renderer)
{ "v": 1, "id": 42, "ok": true, "result": { /* command-specific */ } }

// Error response (shell -> renderer)
{ "v": 1, "id": 42, "ok": false, "error": { "code": "PATH_ESCAPE", "message": "Path escapes project root: ../x" } }

// Event (shell -> renderer, unsolicited)
{ "v": 1, "event": "project:change", "payload": { "kind": "change", "path": "notes/a.md" } }
```

Rules:
- `id` is a positive integer assigned by the renderer, unique per in-flight request.
- `payload` and `result` are always objects (never bare scalars), so fields can be added without breaking shape.
- Unknown top-level fields are rejected. Unknown `cmd` returns `{ code: "UNKNOWN_COMMAND" }`.
- Maximum request size: 32 MiB. Oversize returns `{ code: "PAYLOAD_TOO_LARGE" }` without parsing.
- Error codes are SCREAMING_SNAKE strings from a closed set defined in `shared/src/ipc-contracts.ts`. Hosts and core never invent codes ad hoc.
- Events delivered before the renderer signals readiness (`app:ready` request, see command table) are queued by the host and flushed in order.

### Renderer delivery rule (security-normative)

Responses and events reach the renderer via the host's JS-dispatch mechanism (`evaluateJavaScript` on WKWebView, `ExecuteScript`/WebMessage on WebView2). The ONLY permitted form is:

```js
window.__skriveDispatch(<JSON string literal>)
```

where the envelope is JSON-encoded and then escaped as a JavaScript string literal (escape `\`, `"`, newlines, ` `, ` `, and `</` sequences). Never interpolate file contents or any payload field into a script string directly. A Markdown file is attacker-controlled input to your own UI; this rule is what prevents it from becoming script. Each host must have a test that round-trips a file containing `"</script><script>"`, backticks, `${}`, and U+2028 through `fs:readFile` intact.

On macOS, `WKScriptMessageHandlerWithReply` (promise-based replies) may be used for request/response instead of `evaluateJavaScript`; events still use the dispatch rule above.

### Path safety (security-normative)

Reimplementation of `resolveSafe` with the symlink gap closed (see audit finding S1). Applies to every FS command and to asset serving, in both shells:

1. `root = realpath(projectRoot)` — fail if it does not exist.
2. `target = resolve(root, relPath)` — lexical join.
3. Lexical check: `relative(root, target)` must not start with `..` and must not be absolute.
4. Physical check: `realParent = realpath(dirname(target))` (the deepest existing ancestor for create-type ops); `realParent` must be inside `root`.
5. Reject `relPath` containing NUL bytes. Normalize to forward slashes in all envelopes.

Error code for any violation: `PATH_ESCAPE`. Stage 0.5 applies this same algorithm to the Electron shell so both implementations are testable against one fixture set.

### Shell command contract (the target surface)

This is the post-Stage-0 contract. It is smaller than today's: `linkGraph:*` and `search:*` leave the shell entirely (they become renderer worker modules), and `project:getManifest`/`project:open` collapse into `project:snapshot`.

| Namespace | Commands (invoke) | Events | Implemented in | Stage |
|---|---|---|---|---|
| `app` | `ready`, `version`, `platform` | `flush-before-quit` (shell→r); `flush-complete` (r→shell) | Host | 2 |
| `links` | `openExternal` (scheme allowlist: `https?`, `mailto`, `tel`, `skrive`) | — | Host | 2 |
| `clipboard` | `writeRich { html, text }`, `writeText { text }`, `readText` | — | Host | 0 (Electron), 2 (Zig) |
| `project` | `openDialog`, `create { parent, name, gitInit }`, `snapshot { root }`, `watch { root }`, `unwatch` | `project:change` | Host (dialog) + Core | 2 (snapshot), 3 (watch) |
| `fs` | `readFile`, `writeFile`, `detectExternalChange`, `writeBinaryFile`, `newFile`, `mkdir`, `rename`, `trash` | — | Core (trash via Host) | 2 |
| `diff` | `computeDiff`, `computeLineDiff` | — | Core (Rust staticlib) | 4 |
| `history` | `getMode`, `setGitHistoryEnabled`, `listForFile`, `readGitBlobAt`, `readCheckpointAt`, `createManualCheckpoint` | — | Core | 4 |
| `persistence` | `loadAppState`, `saveAppState`, `loadProjectState`, `saveProjectState`, `revealUserData` | — | Core (reveal via Host) | 2 |
| `updater` | `current`, `check`, `downloadAndInstall` | `updater:status` | Host (Sparkle/WinSparkle) | 6 |

`project:snapshot` is the batching rule made concrete (audit G3 caveat): it returns ALL project files in one response — `{ files: [{ path, body, modifiedMs, hash }], root }` — never per-file round trips. Binary/asset files are listed with `body: null`; the renderer fetches them via the asset origin. The renderer worker derives manifest, frontmatter schema, and link graph from the snapshot.

Frontend-internal modules (no shell involvement after Stage 0): link graph (including `previewRename` computation — the rewrites it produces are applied through ordinary `fs:writeFile` calls), project search, frontmatter parsing and schema inference, lint (already a worker), all projection/editor logic.

### Zig core conventions (normative)

- **Zig version pinned** in `build.zig.zon` (`minimum_zig_version`) and CI. Start on current stable 0.16.x. Compiler upgrades are their own commits, never mixed with features.
- **Allocators:** one arena per request — parse envelope, handle, serialize response, reset. Long-lived state (watcher registry, open-project record) uses a dedicated allocator owned by `SkriveCore`. `std.testing.allocator` in every test for leak detection.
- **JSON:** `std.json.parseFromSlice` into per-command payload structs. Default unknown-field rejection stays ON. Two-stage parse: envelope first (dynamic), then `parseFromValue` into the typed payload.
- **Errors:** one error set per subsystem (`FsError`, `ProjectError`, ...) mapped to envelope error codes in exactly one place (`src/errors.zig`).
- **Dependencies:** vendored via `build.zig.zon`. Expected full list: `watcher-c` (e-dant/watcher), `zig-toml` (sam701) or tomlc17, the Rust diff staticlib. Nothing else without logging a justification.
- **Atomic writes:** write to sibling temp, fsync, rename — same guarantee as `shell/src/lib/atomic-write.ts`. Use `createFileAtomic`/replace where std provides it.
- `zig fmt` enforced in CI.

---

## Part II — Stage 0: Frontend decoupling (in the Electron product)

**Purpose.** Make the frontend genuinely shell-agnostic, inside the shipping Electron app, so every later stage consumes a stable contract. Every sub-stage here ships to production on its own merits (it is also the groundwork the skrive.md website embed needs). No Zig is written in Stage 0.

**Inputs:** current `main` branch. **Outputs:** contract v1 frozen; parity corpus; baseline metrics; frontend that runs against any conforming transport.

### 0.1 — Envelope and dispatcher in the Electron shell

- Define envelope types and the closed error-code set in `shared/src/ipc-contracts.ts` (add; do not break existing exports yet).
- New `shell/src/main/dispatch.ts`: a single registry `register(cmd, handler)` + `dispatch(envelope) -> envelope`. Re-route all existing `ipcMain.handle` registrations through it (one Electron channel `skrive:invoke` carrying envelopes; events on `skrive:event`).
- Update `shell/src/preload/index.ts` to speak envelopes internally while exposing the SAME `SkriveIpc` surface to the renderer (no `app/` changes in this sub-stage).
- **Done when:** all existing shell vitest suites pass; the app runs; a new unit test round-trips a malformed envelope to `UNKNOWN_COMMAND`/`PAYLOAD_TOO_LARGE` errors.

### 0.2 — Transport abstraction

- New `shared/src/bridge.ts`: `interface SkriveTransport { invoke(cmd, payload): Promise<unknown>; on(event, handler): () => void }` and `createSkriveBridge(transport): SkriveIpc` implementing every method of the contract over the transport.
- Preload becomes a thin Electron transport + `createSkriveBridge`.
- Add `shared/__test__/bridge.test.ts` exercising the bridge against an in-memory mock transport (this mock is also the seed of the future web shim).
- **Done when:** renderer code is unchanged and unaware; typecheck and all suites green; the bridge factory has test coverage for every namespace.

### 0.3 — Clipboard commands

Why: `navigator.clipboard` is unavailable in non-secure contexts, and WKWebView custom schemes are not secure contexts (survey §2). The frontend must stop depending on it before any webview work.

- Add `clipboard:writeRich`, `clipboard:writeText`, `clipboard:readText` to the contract and Electron shell (Electron `clipboard` module).
- Migrate `app/src/components/editor/clipboard.ts` (and any other `navigator.clipboard` callsites — grep `navigator.clipboard` across `app/src`) to the bridge, with `navigator.clipboard` as the fallback only when `window.skrive` is absent (website embed case).
- **Done when:** rich copy from preview works in the running Electron app; no unconditional `navigator.clipboard` usage remains in `app/src`.

### 0.4 — Move text analysis to the renderer; add `project:snapshot`

The largest Stage 0 item. Order matters; keep each step green.

1. Add `project:snapshot` to the Electron shell: one response containing every file (shape in Part I). Internally reuse the existing scan in `shell/src/ipc/project.ts`.
2. New renderer worker `app/src/lib/project-model/` (worker + module): consumes a snapshot, produces manifest, frontmatter schema, and link graph. Move the logic from `shell/src/lib/link-graph/` (extract/graph/rename) and `shared/src/` frontmatter into it — move, don't rewrite; the existing vitest suites move alongside and must pass unchanged.
3. Move project search into the same worker (port of `shell/src/ipc/search.ts` semantics: capped hits, UTF-16 columns).
4. Re-point `app/src/stores/project.ts` at the worker for manifest/linkGraph/search; `linkGraph:*` and `search:*` IPC calls are deleted from the contract; `renameWithReferences` becomes: worker computes rewrites, store applies them via sequential `fs:writeFile`, then `fs:rename`.
5. Incremental updates: on `project:change` or local save, the store feeds the changed file's new body to the worker, which updates manifest/graph in place (mirror of today's main-process behavior in `shell/src/ipc/fs.ts:69-108`).
6. Delete the now-dead shell handlers and `shell/src/state/project-state.ts` link-graph portions. Bump contract version.
- **Done when:** all moved test suites pass in their new home; backlinks panel, dead links, orphans, rename-with-references, and search behave identically in the running app; the shell no longer parses Markdown anywhere.
- `[CONFIRM WITH JOE]` before deleting the old shell handlers — this is the audit's "restructure existing code" case.

### 0.5 — Symlink-safe path containment

- Implement the Part I path-safety algorithm in `shell/src/ipc/fs.ts` (`resolveSafe`) and `shell/src/main/asset-protocol.ts`.
- Add `shell/__test__/path-safety.test.ts` with a fixture tree containing: an in-root symlink to an out-of-root directory, an in-root symlink to an out-of-root file, `..` traversal, absolute paths, NUL bytes. These fixtures are reused verbatim by the Zig core in Stage 2.
- **Done when:** all five attack shapes are rejected with `PATH_ESCAPE`; normal nested paths still pass; existing fs tests green.

### 0.6 — Parity corpus

- New `shell-zig/fixtures/`: a script (`scripts/generate-parity-fixtures.ts`) that drives the Electron dispatcher from 0.1 with recorded requests against a checked-in sample project, writing `fixtures/<namespace>.jsonl` files of `{ request, response }` pairs — one line per command invocation, covering every command and every error code at least once.
- A Node runner (`scripts/run-parity-fixtures.ts`) that replays the corpus against any dispatcher (Electron now; the Zig core later via a small stdin/stdout harness) and diffs responses.
- **Done when:** the corpus replays green against the Electron shell itself; the README in `shell-zig/fixtures/` documents how to regenerate and how to run against a foreign dispatcher.

### 0.7 — Housekeeping and baselines

- `[CONFIRM WITH JOE]` Delete legacy trees: `src-tauri/`, root `src/`, `svelte.config.js`, `vite.config.js`, `static/`, `build/_app/`, the four `legacy:*` scripts (archive branch `archive/tauri-svelte` first).
- Record baseline metrics in `docs/zig-shell-log.md`: installer DMG size, cold start to first keystroke (manual stopwatch is fine, method noted), RSS after opening the 500-file perf fixture (`scripts/build-perf-fixture.ts`). These are the numbers the final write-up compares against.
- **Done when:** baselines logged; `main` contains no Tauri/Svelte remnants; CI green.

**Stage 0 exit criteria (all required to start Stage 1):** contract v1 frozen and documented in `shared/src/ipc-contracts.ts`; bridge factory tested; clipboard off `navigator.clipboard`; link graph/search/frontmatter in renderer worker with green tests; symlink containment fixtures passing; parity corpus replaying green; baselines recorded.

---

## Part III — Stages 1-4: macOS build

### Stage 1 — macOS spike (answers questions; produces a skeleton)

**Purpose.** Empirically settle the platform unknowns with the cheapest possible build before investing in the real core. The spike's code is allowed to be rough; its *findings* are the deliverable, logged in `docs/zig-shell-log.md`.

**Inputs:** Stage 0 outputs (especially the bridge factory — the spike's stub implements `SkriveTransport`). **Outputs:** serving-mode decision; typography verdict; a Swift host skeleton that Stage 2 hardens rather than rewrites.

#### 1.1 — Skeleton

- `shell-zig/macos/`: Swift Package or Xcode project. NSWindow (`titlebarAppearsTransparent`, `fullSizeContentView`, traffic-light inset matching `shell/src/main/index.ts:48-78`), WKWebView, loads the existing `out/renderer` bundle (run `bun run start:build` first; document this ordering in `shell-zig/README.md`).
- `shell-zig/core/`: `build.zig` producing a static library with the Part I C ABI; the only command implemented is `app:version` returning a stub. Swift links it via a modulemap (crib the idiom from Ghostty's `include/ghostty.h` + `module.modulemap`).
- Bridge: `WKScriptMessageHandler` receives envelopes from a tiny injected transport (`window.__skriveNativeTransport`); a renderer-side file maps it through `createSkriveBridge`. Stub the remaining namespaces in JS with canned data (the 0.2 mock transport, preloaded with a small read-only sample project) so the full UI renders.
- **Done when:** Skrive's UI renders in the window, a sample document opens read-only, and `app:version` round-trips renderer → Swift → Zig → renderer.

#### 1.2 — Serving-mode bake-off

Test the three known shapes (survey §2) against a checklist; pick one; log the matrix:

| Shape | Test |
|---|---|
| `loadFileURL(_:allowingReadAccessTo:)` | — |
| Custom scheme (`skrive-app://`) via WKURLSchemeHandler | — |
| Loopback HTTP server in the Zig core (`std.http.Server`, 127.0.0.1, random port, token in URL) | — |

Checklist per shape: lint Web Worker loads and runs (module worker via `import.meta.url`); CSS loads incl. `light-dark()` behavior on the target macOS version; localStorage survives relaunch (informational only — canonical state is native-side); `fetch` of bundled assets works; the `skrive-asset://` image path can be implemented (separate scheme handler is fine in all three shapes); no mixed-content blocks between the app origin and the asset origin.

- **Done when:** one shape is chosen with the matrix recorded. Default expectation is `loadFileURL` or custom scheme; the loopback server is the fallback if worker or storage behavior fails elsewhere.

#### 1.3 — Typography gate (product gate, Joe-judged)

- Render the same documents (use `docs/fixtures/` content plus a Fraunces/Palatino-heavy sample) in Electron Skrive and the spike side by side on the same display.
- `[CONFIRM WITH JOE]` Verdict options: (a) acceptable → continue; (b) unacceptable → the plan's webview layer switches to the CEF fallback (survey §5) and Stage 1 repeats with CEF before any Stage 2 work; (c) unacceptable and CEF unappealing → experiment ends, write-up time.
- **Done when:** verdict logged with screenshots.

#### 1.4 — Injection and worker hardening checks

- Implement the renderer delivery rule (Part I) for real: round-trip a file containing `</script>`, backticks, `${}`, U+2028/U+2029 through a stub `fs:readFile`; assert byte-identical arrival and no script execution.
- Confirm the lint worker shim (`decode-named-character-reference.node-shim.ts`) behaves under the chosen serving mode.
- **Done when:** both checks pass and are committed as repeatable tests (XCTest or a scripted check), not one-off observations.

**Stage 1 exit criteria:** serving mode decided; typography verdict (a); injection test green; worker green; skeleton committed. Findings logged.

### Stage 2 — macOS editable MVP

**Purpose.** A Skrive you can actually write in daily on the Zig shell: open a project, edit, autosave, persist UI state. This stage is where the substrate question starts producing real evidence.

**Inputs:** Stage 1 skeleton + decisions. **Outputs:** the working core that Stages 3-4 extend.

#### 2.1 — Core dispatcher

- `shell-zig/core/src/dispatch.zig`: envelope parse (two-stage, per conventions), command table (comptime-built array of `{ name, handler }`), error mapping in `src/errors.zig`, arena-per-request, 32 MiB cap.
- A test harness binary (`core/src/fixture_main.zig`) reading envelope JSONL on stdin and writing responses on stdout — this is what `scripts/run-parity-fixtures.ts` drives.
- **Done when:** malformed-envelope fixtures from the parity corpus pass against the harness.

#### 2.2 — `fs` namespace

- All 8 commands in `core/src/fs.zig`, path safety per Part I (port the 0.5 fixture tree as Zig tests), atomic writes, content hashing (SHA-256 to match `contentHash` in `shell/src/lib/atomic-write.ts` — verify the exact encoding against a fixture, the hashes must be byte-equal), `detectExternalChange` semantics identical to Electron's.
- `fs:trash` routes to the host (Swift: `FileManager.trashItem(at:resultingItemURL:)`) via a small host-command channel in the C ABI (`emit` with a reserved `host:` namespace the Swift side intercepts).
- **Done when:** `fixtures/fs.jsonl` replays green against the fixture harness, including all `PATH_ESCAPE` cases and hash equality.

#### 2.3 — `project` namespace (minus watch)

- `project:snapshot` in `core/src/project.zig`: recursive walk skipping the same noise-dir set as `shell/src/ipc/project.ts:107-208` (`node_modules`, `.git`, dot-dirs per current behavior — copy the exact list), batched single response.
- `project:openDialog` and `project:create` (with optional `git init` via `std.process.spawn`) — dialog on the host (NSOpenPanel), create in the core.
- **Done when:** `fixtures/project.jsonl` replays green; opening the 500-file perf fixture through the real UI completes and renders the sidebar.

#### 2.4 — `persistence`, `app`, `links`, `clipboard`

- Persistence in `core/src/persistence.zig`: same file locations relative to the app-data dir (`app.json`, `projects/<16-hex-sha256>.json` — hash construction must match `shell/src/lib/persistence.ts` exactly so a future migration could share state), atomic writes, lenient load-with-defaults.
- App-data dir: `~/Library/Application Support/Skrive` on macOS (host passes it in `config_json`).
- `app:ready`/`version`/`platform`, flush-before-quit handshake (host intercepts window close, sends the event, waits for `flush-complete` with the same 2s timeout as `shell/src/main/index.ts:142-165`).
- `links:openExternal` with the scheme allowlist; `clipboard:*` via NSPasteboard.
- **Done when:** corresponding fixtures replay green; quitting mid-edit loses nothing (manual test: type, Cmd-Q immediately, relaunch, content present).

#### 2.5 — Asset serving and integration pass

- `skrive-asset://` equivalent under the chosen serving mode, with Part I path safety; `app/src/lib/preview/imageResolver.ts` must work unmodified (if the URL prefix must differ, the bridge exposes it via `app:platform` extension rather than an `app/` change).
- Embed `out/renderer` into the binary (`@embedFile` manifest generated by a `build.zig` step) OR ship as a bundle resource directory — decide by what the serving mode made natural; log the choice.
- Full manual pass: open project, edit in Text and Rich surfaces, autosave fires, images render in preview, search works (worker), backlinks work (worker), UI state restores on relaunch.
- **Done when:** the manual pass checklist is green and logged. **From this point, dogfood: real writing sessions happen in the Zig build whenever practical.** Friction goes in the log — this is ledger-grade evidence either way.

**Stage 2 exit criteria:** parity fixtures green for `fs`, `project` (minus watch), `persistence`, `app`, `links`, `clipboard`; manual pass green; dogfooding begun.

### Stage 3 — Watcher

**Purpose.** External-change detection at parity. Isolated because it is the one shell primitive with real platform depth.

**Inputs:** Stage 2 core. **Outputs:** `project:watch`/`unwatch` + `project:change` events identical in behavior to chokidar's use today.

- Vendor `watcher-c` (e-dant/watcher's C layer); compile it in `build.zig`; wrap in `core/src/watcher.zig`.
- Translate its events (`effect_type`, `path_name`, `associated_path_name`) to the existing `ProjectChange` shape (`add/change/unlink/addDir/unlinkDir/ready`). Renames arrive paired — emit `unlink` + `add` to match current renderer expectations (verify against how `app/src/stores/project.ts` consumes them; match, don't improve).
- Write-finish stabilization in Zig: debounce per-path; do not emit `change` until size/mtime are stable across a settle interval (chokidar `awaitWriteFinish` equivalent — copy its configured values from the Electron shell if set, else default 200ms settle / 50ms poll). Suppress self-writes: the fs module registers paths it just wrote (by hash) so saves don't echo back as external changes — mirror whatever the Electron shell does here first; if Electron relies on hash comparison in the renderer, keep that and emit faithfully.
- Tests: scripted external mutations against a temp project (touch, append, atomic-rename-replace like another editor saving, delete, mkdir, rmdir, file rename) asserting the emitted event sequence; run the loop long enough to confirm stable memory (leak check via `std.testing.allocator` in unit scope plus a soak note in the log).
- **Done when:** editing a watched file in another editor updates Skrive's UI exactly as the Electron build does, for every mutation type listed.

### Stage 4 — macOS feature parity  *(COMPLETE 2026-06-22 — reduced scope; merged to main at `87a903f`)*

**Purpose.** Close every remaining gap so the two builds are feature-indistinguishable on macOS (updater excepted; that is Stage 6).

**Inputs:** Stages 2-3. **Outputs:** full-parity macOS build.

> **Scope decision (2026-06-22).** Stage 4 is reduced to **4.0 (native app-shell parity) + 4.4 (host polish + closing sweep)**. Sub-stages **4.1 (diff), 4.2 (checkpoints), 4.3 (git history) are deferred and NOT ported to the Zig shell** — their prose below is retained for history, not executed. Rationale: diff/checkpoints/git are stand-in version-history features that assume Markdown/git conformity, which Skrive is graduating away from (positioning: writing+notes app, Markdown as plumbing). Porting features slated for replacement is the wasted parity work this plan's own kill-criteria warn against, and the labs migration must not bridge on rushed feature work. The current Electron diff/git/checkpoint features stay shipping and untouched; the Zig build keeps them mocked (`shell-zig/web/sample-data.ts`); the parity corpus does not include them. A Skrive-native version history — document-model-aware, git-independent, with git demoted to an optional later integration — is a deferred future feature, designed fresh under the feature-placement rule when its time comes, not here. **The file-open / `.md`-association item in 4.0 is likewise deferred**: it is net-new cross-shell work (a host→renderer open verb the contract does not yet have, and which the Electron shell does not implement either — `App.tsx:196` calls it "the URL handler we don't have yet"), not host chrome, so it belongs to that future feature track, not to substrate parity. 4.0 as executed is therefore genuinely host-only with zero `app/`/core/contract changes.

#### 4.0 — Native app-shell parity (do this FIRST — it gates real dogfooding)

**Why first.** Electron supplies a large amount of standard-app behavior for free that the bespoke Swift host must implement explicitly. Until it exists the Zig build is a spike, not something you can live in — so this sub-stage is sequenced ahead of diff/history even though the original plan back-loaded it into 4.4. Dogfooding is meant to run *throughout* Stage 4 (during 4.1-4.3), which requires the app to feel native-complete first.

The audit (2026-06-22): the Electron main has NO custom menu code, so it inherits Electron's *default* macOS menu (App/File/Edit/View/Window/Help with every standard shortcut wired) plus `setWindowOpenHandler` (external links out) and DevTools. The Swift host today has only an About/Hide/Quit app menu — no Edit/Window/View menus, no link/navigation policy, no Web Inspector.

- **Full standard macOS menu bar**, replicating Electron's *default* menu via the standard AppKit first-responder selectors — App (About/Hide/Quit, already present), Edit (`undo:`/`redo:`/`cut:`/`copy:`/`paste:`/`selectAll:`), View (reload, `toggleFullScreen:`, and a dev-gated DevTools toggle), Window (`performMiniaturize:` Cmd-M, `performZoom:`, `performClose:` Cmd-W), Help. WKWebView forwards these to the web content / first responder. **Scope guard: replicate the DEFAULT menu only — NOT app-specific File items.** Skrive's New/Open/Save/command-palette live in the renderer (shared `app/`) and already work; inventing native menu items would break parity, not improve it.
- **External-link / window-open policy** in the `WKNavigationDelegate` (`decidePolicyFor navigationAction` + `createWebViewWith`): route `target=_blank` / `window.open` / off-origin navigations through the `links:openExternal` allowlist, and block the main frame navigating off the `skrive-app://` origin (a link click in a note must not nuke the app). This is parity with Electron's `setWindowOpenHandler` and is also a security boundary.
- **Web Inspector**: set `WKWebView.isInspectable = true` (dev-gated). Not cosmetic — it is the primary tool for diagnosing renderer behavior while dogfooding.
- **Pre-paint window background** corrected to the current Electron values (`#161719` dark / `#e7e8ea` light); the host currently paints the stale `#1a1a1a`/`#fefcf7`.
- **[DEFERRED — see the scope decision above.]** ~~File associations + `skrive://` URL scheme in `Info.plist` plus the open event: opening a `.md` opens its containing folder as the project and focuses that file.~~ This is NOT host chrome — there is no existing contract verb for it (the original "rides the existing contract" claim was wrong), and Electron does not implement it either, so it is net-new cross-shell feature work that belongs to the future version-history/open-with track, not to 4.0.
- **Host-only.** Everything in 4.0 (as executed) is Swift in `shell-zig/macos/`; zero `app/`, core, or contract changes. This is precisely the "per-platform host provides the OS chrome the runtime used to give for free" the Ghostty pattern expects.
- **Done when:** standard editing shortcuts work in the editor and in dialog text fields; Cmd-W / Cmd-M / zoom / fullscreen work; external links open in the browser without disturbing the app; Web Inspector opens; no stale launch flash. From here, dogfooding is realistic.

#### 4.1 — Diff via Rust staticlib  *(DEFERRED — not ported; see scope decision)*

- Add a `staticlib` crate type + `extern "C"` surface to `native/diff` (new `src/capi.rs`; keep the NAPI surface intact for the Electron build). API shape: compute → opaque handle → op iteration → free (the pattern already designed in `docs/Zig diff experiment.md` §FFI surface — reuse it).
- `build.zig` builds/links it (invoke `cargo build --release` as a build step or require the artifact prebuilt; document in README).
- `core/src/diff.zig` wraps it into `diff:computeDiff`/`computeLineDiff`.
- **Done when:** `fixtures/diff.jsonl` (generated from the existing `native/diff/__test__/fixtures.test.ts` cases) replays green; DiffView renders identically in the running app.

#### 4.2 — History: checkpoints  *(DEFERRED — not ported; see scope decision)*

- Port `shell/src/lib/checkpoint.ts` semantics to `core/src/checkpoint.zig`: same storage layout (`projects/<hash>/checkpoints/<fileHash>/<timestamp>_<auto|manual_slug>.md` + `.name` sidecar), same auto-checkpoint interval and content-hash dedup, same retention caps. Byte-compatible layout is required — a user switching shells must keep their history.
- Auto-checkpoint trigger moves with it: `fs:writeFile` on markup files calls into the checkpoint module exactly as `fs.ts:98-106` does.
- **Done when:** checkpoint fixtures replay green; a checkpoint store written by the Electron build lists and reads correctly in the Zig build (round-trip test).

#### 4.3 — History: git  *(DEFERRED — not ported; see scope decision)*

- `core/src/git_history.zig`: spawn system `git` with the same argv as `shell/src/lib/git-history.ts:37-151`, same parsing, same mode detection (`history:getMode`), same enable/disable persistence.
- **Done when:** history fixtures replay green against a fixture repo with known commits.

#### 4.4 — Host completions (residual polish + the closing parity sweep)

Most host work moved to 4.0 (menu bar, link policy, Web Inspector, window background). What remains here is non-dogfood-blocking polish plus the stage-closing manual sweep:

- Dock icon light/dark swap on theme change (parity with `shell/src/main/index.ts:41-95`); the icon itself already ships (Stage 2).
- Verify `persistence:revealUserData` (already routed via the host `reveal` channel in Stage 2.4) behaves at parity.
- **Done when:** full manual parity checklist (write one in the log: every audit §2 table row plus every command namespace) passes against the Electron build side by side.

**Stage 4 exit criteria (reduced scope) — MET (2026-06-22).** 4.0 native-shell parity done (the app is a livable daily driver); the parity corpus (which by the scope decision excludes diff/history) replayed green both directions (26/26 vs the Zig core and vs the live Electron oracle); side-by-side manual checklist green ("everything looks and feels good"); dogfooding showed no blocker-class friction. 4.1-4.3 deliberately not ported (see the scope decision); residual non-blocker gaps logged: dock-icon appearance swap, file-open/`.md`-association (deferred cross-shell feature), updater (Stage 6). See `docs/zig-shell-log.md` for the per-sub-stage record and the two macOS substrate findings (the `decidePolicyFor` closure-type trap; `_WKInspector.show()` no-op on macOS 26).

---

## Part IV — Stages 5-6: Windows and distribution

### Stage 5 — Windows host

**Purpose.** Same Zig core, new host. Widest error bars in the plan; sequence it so the core needs zero changes — any core change required by Windows is a design bug to log and fix properly.

**Inputs:** Stage 4 core (unchanged). **Outputs:** Windows build at the same parity level.

#### 5.0 — Host language decision: C++ vs C# (do the side-by-side, do not assume)

The Part I table assigns C++ on the strength of one data point (zero-native's choice) and the absence of a maintained Zig WebView2 binding. That justifies C++ as the *default*, not as a settled decision. The host is thin and fully isolated behind the C ABI — it is the cheapest layer in the whole plan to revisit — so the language gets chosen on evidence at Stage 5, not inherited from the table. Run an honest bake-off first.

**What the host does (the surface being compared).** Win32 window, WebView2, asset serving via request interception, the message bridge, native dialogs/trash/clipboard/shell-open, single-instance, updater glue, C-ABI link to the core. Almost no business logic — it all lives in the core. This is a host-shim choice, not a core-architecture choice.

**Why C# is a real contender, not an afterthought:**
- WebView2's first-class binding is the .NET one (`Microsoft.Web.WebView2.Core`). The C++ path is raw COM — `ICoreWebView2` interfaces, HRESULT plumbing, event tokens, manual lifetime — for exactly the code that carries this stage's widest error bars. The managed wrapper removes most of that risk.
- Dialogs, `CF_HTML` clipboard, trash, shell-open, named-pipe single-instance all have clean managed equivalents instead of hand-rolled Win32/COM.

**Why C++ is the thesis-aligned default:**
- The graduation scoreboard (Part VI) is installer size, cold start, memory baseline vs Electron. A managed runtime undercuts the headline metric this experiment exists to win: self-contained .NET adds ~60-80MB to the installer; framework-dependent adds an install-time dependency (the same friction the WebView2 bootstrap already costs). Shedding V8+Node only to re-add a managed runtime is philosophically the same animal, smaller.
- Symmetry with the Swift host, which compiles to a native binary.
- Nuance: on *runtime memory* the objection is weak — the WebView2 Edge process tree dominates RSS in both cases; the host's own footprint is in the noise. The sharp objection is *installer size*, not memory.

**The middle path to evaluate, because it may dominate both:** C# + CsWin32 (raw HWND) + `WebView2.Core` attached to that HWND via `CreateCoreWebView2ControllerAsync` + Native AOT. No WinForms/WPF (which is what breaks AOT), so you keep the managed WebView2 ergonomics *and* get a standalone native binary with a small installer. The open risk: the WebView2 managed layer has historically emitted trim/AOT warnings. If it is AOT-clean at Stage 5, this option beats C++ on every axis here and should win. If it is not, C++ stands. **Verify this before writing host code — it is a fact to look up, not a preference.**

**Mechanical consequence of choosing C#:** P/Invoke cannot bind a static library, so the Windows core ships as `skrive_core.dll` (trivial `addSharedLibrary` in `build.zig`) rather than statically linked like the Swift host links `libskrive_core.a`. That asymmetry is fine, arguably cleaner, but note the `SkriveCoreEmit` callback delegate must be kept alive against the GC.

**Decision procedure (`[CONFIRM WITH JOE]`):**
1. Look up current WebView2-SDK Native-AOT/trim status and the CsWin32 HWND-hosting path; log the finding.
2. If the throwaway 5.1 spike is the goal, strongly consider writing it in C# regardless — the managed wrapper answers serving-mode / secure-context / WebView2 questions in a fraction of the time, and the spike is allowed to be discarded.
3. Pick the *shipping* host on the bake-off result, scored against the Part VI axes: installer size first, then host-code risk/maintainability, then cold start. Record the matrix in `docs/zig-shell-log.md`.
4. Rust (`windows-rs`/`webview2-com`, reusing the toolchain already in `native/diff`) is a logged fallback if both C++ and C# disappoint — native and memory-safe, but a third systems language in the host layer with COM ergonomics short of C#'s managed wrapper. Do not pursue unless the bake-off forces it.

The rest of Stage 5 below is written in C++ terms because that is the current default; if 5.0 selects C#, the same sub-stages and acceptance criteria hold with the managed equivalents substituted.

#### 5.1 — Host skeleton

- `shell-zig/windows/`: C++17+, Win32 window, WebView2 via the COM API. Load `WebView2Loader.dll` dynamically (do not static-link the MSVC loader; survey §4 cross-compile note). Evergreen runtime with detection + bootstrapper launch if absent.
- Serving: `AddWebResourceRequestedFilter` + `WebResourceRequested` interception mapping the app origin (Tauri-precedent `http(s)://skrive.localhost` virtual origin) to embedded/bundled assets; same for the asset origin. Confirm secure-context-gated behavior is irrelevant post-Stage-0.3 (clipboard already bridged) but log `window.isSecureContext` anyway.
- Bridge: `WebMessageReceived` in, `ExecuteScript` out, delivery rule per Part I, with the same injection round-trip test.
- **Done when:** the UI renders, `app:version` round-trips, injection test green.

#### 5.2 — Host feature fill

- Folder dialog (`IFileDialog` + `FOS_PICKFOLDERS` — or vendor nativefiledialog-extended), trash (`IFileOperation` + `FOF_ALLOWUNDO`; crib libtrashcan), `ShellExecuteW` open-external with the allowlist, clipboard (`CF_HTML` formatting for `writeRich` — note CF_HTML's odd header format; test paste into Word and a browser), single-instance (`CreateMutexW` + forward argv via named pipe), `revealUserData` (`SHOpenFolderAndSelectItems`).
- App-data dir: `%APPDATA%/Skrive`.
- **Done when:** parity corpus replays green on Windows (the corpus is OS-agnostic except path separators — the forward-slash normalization rule in Part I exists for exactly this); manual checklist green; watcher mutation tests green on NTFS.

#### 5.3 — Windows packaging (pre-update)  *(portable-zip path DONE + merged 2026-06-23; installer moved to Stage 6)*

- **Shipped (merged to main at `6e5bebb`, FF):** the native-polish + packaging-prep surface — nav backstop, app icon, GUI subsystem, DevTools-off-in-release, custom frameless chrome, window-state persistence — and the **portable zip as the dogfood vehicle**, published as a GitHub **prerelease** (`win-labs-5.3.0`, non-`v*` so `release.yml` never fires). The Windows host is **Zig** (5.0 decision), cross-compiled from macOS.
- **Installer deferred to Stage 6** (as this section always allowed: "keep 5.3 to a portable zip for testing"). The installer's tech is coupled to the updater choice (Velopack would own both), so it is decided and built in Stage 6, not here.
- **Done when (revised):** met for the portable path. The installer's "clean machine → writing in under a minute, WebView2 bootstrap included" criterion moves to Stage 6.1.

### Stage 6 — Distribution and updates  *(reframed 2026-06-23: the graduation verdict is IN — see Part VI. This stage now BUILDS the locked system and EXECUTES the hand-off; it no longer evaluates whether to graduate.)*

**Purpose.** A locked-in, repeatable distribution + auto-update system for the Zig family, a proper CI releases workflow, and the actual hand-off from the Electron product to the Zig builds. Parity target: `docs/release-process.md`.

**Inputs:** Stages 4-5 builds — both merged to main; macOS + Windows are livable daily drivers; the thesis is proven on both. **Outputs:** signed/updatable artifacts, a CI release workflow, and Electron users migrated.

**Framing change.** Stage 6 was written as "evaluate the options, then reach a graduation/kill verdict." That verdict is in: **the Zig family is the committed substrate, Electron is on a sunset path** (`project_zig_graduation_commit`). So the sub-stages are now build-and-execute. The one genuinely-open technical choice is the updater engine (6.1), flagged for ratify.

#### 6.1 — The distribution + update system (LOCK IT)

- **Updater engine — DECIDED (2026-06-23): Sparkle (macOS) + WinSparkle (Windows).** Native per platform, battle-proven (Sparkle is the ~20-year indie-Mac standard), **no managed runtime** — Velopack's build-time .NET is the same runtime we deliberately shed. Deciding logic: auto-update runs silently on every user's machine and rewrites the app, so *proven* beats *fewest-moving-parts*; and the ~2MB app makes delta-update sophistication (Velopack's main draw) irrelevant — just ship the whole binary each time. Shared appcast model, enclosures on GitHub Releases, one `generate_appcast` CI step; Sparkle is a small Swift integration in the macOS host, WinSparkle a C DLL the Zig host loads. Maps onto the existing `updater:*` contract (`current/check/downloadAndInstall` + `updater:status` events) so `app/` is untouched. The network + install is **host-native** (Sparkle/WinSparkle do their own HTTP), NOT through the renderer's `net:*` — that reserved capability is for renderer-driven *sync*, a separate concern. The updater is also a security boundary: the EdDSA *private* signing key is a crown-jewel secret (CI only), the public key ships in the app, and the signature-verify path must be airtight. **One open verification (not a re-decision):** confirm WinSparkle's pinned version supports modern signing (Ed25519/EdDSA); if it cannot sign securely, Velopack is the logged fallback — but the default is Sparkle + WinSparkle.
- **Installers.** Windows: hand-rolled **NSIS** (`Skrive-{version}-Setup.exe`, `.md`/`.markdown`/`skrive://` associations, WebView2 Evergreen bootstrap, per-user install), built on the Mac with `makensis`. macOS: **DMG** via `create-dmg`/`hdiutil`. The 5.3 portable zip / `win-labs-*` prerelease stays the dogfood vehicle until the installer lands.
- **Signing.** macOS: Developer ID + notarization (Team Q5Y792924V) in CI — the audience is here and the cert already exists, so do it (effectively free). Windows: **unsigned, demand-gated — do NOT spend on it now.** Signing exists to spare *new* Windows users the SmartScreen "Run anyway" wall, but the demand is ~nil: **26 lifetime Windows installer downloads across every version (v0.0.2→v1.3.0) vs ~85 macOS, as of 2026-06-23 — and much of the 26 is the dev's own test-downloads.** Paying now buys a smoother first-run for an audience that doesn't exist yet. The trigger is the number, not a date: sign when Windows downloads climb materially on their own (dozens/month that aren't you). Re-check anytime:
  ```
  gh api --paginate repos/brueshi/Skrive/releases --jq '.[].assets[]|[.name,.download_count]|@tsv' \
    | awk -F'\t' '$1~/(setup\.exe|Setup\.exe|\.msi)$/&&$1!~/\.sig$/{w+=$2} END{print "Windows lifetime:",w}'
  ```
  When that day comes, evaluate (cheapest first) **Azure Trusted Signing** (~$10/mo, cloud, no hardware token, SmartScreen reputation; business-identity eligibility gate) → **OV cert** (~$100–300/yr, Certum is the budget end; reputation warms over downloads, not instant) → **EV cert** (~$300–600/yr, token; best initial standing but the instant-SmartScreen benefit has eroded). Post-2023 rule: all OV/EV keys must live on a token or cloud HSM — no cheap file certs anymore.
- **Done when:** a clean machine on each OS goes installer → writing in under a minute (WebView2 bootstrap included on Windows), and an N→N+1 auto-update completes on both.

#### 6.2 — The releases workflow (proper CI)

- A new **`zig-shell` GitHub Actions workflow**, separate from the Electron `release.yml` (which stays the Electron product's pipeline and must not be triggered by Zig tags). **A single macOS runner builds the whole Zig family** — the Swift macOS host AND the cross-compiled Windows host (`build-windows.sh`; Zig needs no Windows runner to build). A Windows runner is added only if/when **E2** runs the parity corpus on NTFS. Pin the toolchain via `mlugg/setup-zig`.
- Steps: build core + both hosts → gates (parity corpus 26/26, `jsescape` + core unit tests, `zig fmt`, renderer typecheck) → assemble installers → sign + notarize macOS → publish to GitHub Releases + generate the appcast feed → upload the stable-name aliases (mirror `release.yml`'s alias step so the landing page gets forever-URLs).
- **Tag convention:** `labs-*` / `win-labs-*` prereleases now (non-`v*`, so the Electron `release.yml` never fires); promote to the primary release tags once the Zig builds become the headline download (6.3). This replaces the manual `gh release create` stopgap used for `win-labs-5.3.0`.
- **Done when:** a tagged push produces installable, macOS-signed, auto-updatable artifacts for both OSes from CI, with the appcast feed published.

#### 6.3 — Graduation execution (hand off Electron → Zig)

Deliberately low-tech — no risky auto-migration from one app to a different one:
- The existing Electron `.dmg`/`.zip`/`Setup.exe` releases **stay downloadable** — no existing user is broken.
- Ship a **final Electron build that shows an in-app update toast**: "A new version of Skrive is available" → links to the new Zig build's download. The Electron auto-updater cannot cross to a different artifact, so this is notify-and-redownload, not in-place auto-update; it pulls users forward at their own pace.
- **Repoint the primary downloads** (website + `releases/latest` stable aliases) to the Zig builds; the `zig-shell` workflow becomes the headline release.
- **Electron sunset timeline:** keep Electron as a downloadable fallback through the transition window, then stop building it. Close the open **E1/E2** Windows verification (watcher-on-NTFS + parity corpus) as part of this stage.
- **Done when:** the Zig builds are the default download on every surface, the Electron migration toast is shipped, and E1/E2 are green.

#### 6.4 — Dead-code cleanup + measurement memo

- **Cleanup (Electron / docs / Rust):**
  - *Electron:* the frozen diff/checkpoints/git-history code and its IPC; the bridge mock stubs (`history:*` et al.); ultimately the `shell/` Electron host itself once the sunset window (6.3) closes.
  - *Docs:* the orphaned planning docs the current direction superseded — `planning/version-history-plan.md` (git-primary), the stale `planning/technical-decisions.md` + the technical specifics in `monetization-plan.md`, and the dead-Tauri/Rust Zig experiment docs — marked deprecated or removed.
  - *Rust:* `native/diff` is **retained** (a rendering primitive for the future native version history — version-history plan Decision 9) but is currently bound only via napi-rs to Electron; retarget it to a C-ABI staticlib for the Zig family when native history is built, and drop the napi binding at Electron sunset.
  - Plus: prune the Zig host's leftover bring-up scaffolding (unused diagnostic COM bindings, the `NavigateToString`/inline-test paths) now that first light is long past — keep only what is load-bearing.
- **Measurement memo (now documentation, not a verdict).** Re-measure the Stage 0.7 baselines on the Zig builds (installer size, cold start, RSS on the 500-file fixture; add update download size) and write `docs/zig-shell-results.md` — the win documented, the decision already made.
- **Done when:** the cleanup pass is done (or its remaining items are tracked against the sunset window), and the memo exists.

#### 6.5 — Production-readiness: macOS polish pass + crash logs  *(prerequisite for 6.3 graduation)*

- **macOS shipping-readiness pass.** The recent work was Windows-heavy; before graduating the macOS build, give it its own polish/dogfood pass — the macOS analogue of the Windows 5.3 push — so graduation isn't lopsided. Scope: signed + notarized DMG; plus the residual Stage-4 gaps (dock-icon light/dark swap, which needs the light brand asset; macOS `.md` file-open, the same deferred feature as Windows C1).
- **Crash logs — local, user-grabbable, no telemetry** (privacy-preserving, per Skrive's no-telemetry posture). Write to `%APPDATA%\Skrive\crashes` (Win) / `~/Library/Application Support/Skrive/crashes` (mac):
  - *Native host/core crashes:* an unhandled-exception handler writes a minidump + text log — `SetUnhandledExceptionFilter` + `MiniDumpWriteDump` (Windows), a signal handler / `NSSetUncaughtExceptionHandler` (macOS), a Zig panic handler (core).
  - *Renderer errors (the common case):* `window.onerror` / `unhandledrejection` append to a renderer log via a host-owned `log:append` command.
  - *Webview content-process death:* the host's `ProcessFailed` (WebView2) / `webViewWebContentProcessDidTerminate` (WKWebView) handler logs it.
  - *User send:* a Settings "Reveal / export diagnostics" button (reuses the existing reveal capability) opens or zips the folder; the user sends it in. No automatic upload. Side benefit: field crashes reach the dev without a Windows boot to reproduce.
- **Done when:** macOS ships signed + notarized with its polish gaps closed, and a forced crash on each OS leaves a grabbable log.

**Stage 6 exit criteria:** a locked, CI-driven, auto-updating distribution for both Zig builds; macOS production-ready and crash logging in place; Electron users migrated and the shell on a sunset path; the cruft removed or tracked; the results memo written.

---

## Part V — Future features and extension points

The plan must not paint future Skrive into a corner. These are design constraints on the work above, not work items.

### Native-feel deference (the build's reason for being)

This experiment exists so Skrive is not on borrowed technology that feels *okay*. The bar is that it feels native: the purest scrolling, clicking, typing, and editing the platform can produce. That bar is reachable only because of the substrate choice, and only if the renderer honors it.

**Why the ceiling is higher here.** WKWebView (and WebView2) *is* the operating system's own web engine — the same WebKit Safari uses. Electron ships its own Chromium, which reimplements scroll physics and text interaction rather than inheriting the platform's. So the system webview hands us native momentum and rubber-band scrolling, the OS text stack (smart substitution, Look Up, the dictionary, native context menus, real IME), and platform accessibility essentially for free — things Electron only ever approximates. The native-feel ceiling is genuinely higher on this shell than on Electron.

**The standing rule.** That ceiling is reached only by *not fighting the engine*. On Electron, every place `app/` overrides native behavior is invisible, because Chromium was never native to begin with; on this shell those same overrides are exactly what read as not-quite-native. Therefore: **the renderer defers to the system webview for scroll, text interaction, context menus, spellcheck, and selection unless there is a concrete, logged reason not to.** Any renderer override of native scroll/click/text behavior is a reviewable item — questioned, not assumed. This is not measurable by the latency harness (a regression tripwire) or fully by scripted input; the verdict is hand-and-eye, Joe-judged during dogfooding, in the Gate 1.3 mold. A divergence resolves either as a renderer fix shipped to both shells, or — if WebKit genuinely cannot match — a logged substrate finding.

**Audit snapshot (2026-06-22, entering Stage 4).** The renderer is already disciplined here. Native and intact: scrollbars (no `::-webkit-scrollbar` restyling), scroll physics (every scroll listener is `passive: true`; zero `preventDefault` on `wheel`/`touch`), OS spellcheck/substitutions (handed off in `Editor.tsx`, per-region skips only), the editor's native context menu (custom menu confined to the sidebar file tree), and `user-select`/`touch-action: none` scoped to chrome only. Watch-list of genuine overrides to evaluate on WebKit: (1) `-webkit-font-smoothing: antialiased` on `html, body, #root` (`index.css:165`) forces lighter-than-native text rendering — A/B against removing it, highest perceptual priority since it sits on the text axis; (2) JS `behavior: 'smooth'` scroll-to on programmatic navigation (`Preview.tsx`, outline rail) — validate or make instant if it reads web-y; (3) bespoke pointer-scroll controls with no native equivalent (outline-rail drag-scrub, DiffView synced scroll) — cannot simply defer, so scrutinize their feel directly. Nothing structural fights the platform; the list is tuning, not surgery.

**The feature placement rule.** Every future feature starts pure-JS in `app/`. It earns a shell command only if it needs the filesystem, the OS, or the network — and then it is added as one entry in the command table of BOTH shells in the same change, with a parity fixture. This rule is what keeps the dual-shell period cheap and is enforceable in review: a PR adding a shell command without a fixture and both implementations is incomplete.

| Future direction (from product planning) | Impact on this plan |
|---|---|
| Marginalia / Folio projection layer | Pure frontend (projection + CSS lane already reserved). Zero shell impact. Validates automatically on both shells |
| Multi-markup (AsciiDoc/reST/Org) | The Zig core must be markup-agnostic: the only Markdown-aware shell behavior today is the checkpoint trigger's extension match (`MARKDOWN_EXT` in `fs.ts:16`). In the core, that extension set comes from `config_json`, not a constant. Everything else (parsing, lint, graph) is already renderer-side after Stage 0.4 |
| Cloud sync / publishing / Pages (monetization plan) | Reserve namespaces `net:*` (HTTP through the shell, so the renderer never gets network capability) and `secrets:*` (Keychain / Windows Credential Manager). Do NOT implement; do document the reservation in `ipc-contracts.ts` comments. The envelope and permission model already accommodate them |
| Export pipeline (PDF/print) | Webview print APIs differ per engine (`WKWebView createPDF`, WebView2 `PrintToPdf`). Reserve `export:pdf` as a host command. Note: this is a place the Zig shell may eventually *beat* Electron in output quality via native PDF paths — log it as a candidate experiment, don't build it here |
| Website embed of the editor | The Stage 0.2 mock transport grows into the real web shim: `createSkriveBridge(webTransport)` with in-memory project. Shares 100% of the contract machinery; belongs to the website project, enabled by this plan |
| Plugins / theming | Themes are CSS (shell-agnostic). Any future plugin runtime lives renderer-side; the closed command table is the security boundary that makes third-party code tractable later |
| Native text rendering (the ledger's true endgame) | Out of scope by design. If the ledger ever forces it, this plan's contribution is the C-ABI core and per-platform host structure — the webview gets replaced inside the host, the core and contract survive |
| iPad / iOS (Joe's durable product ambition) | Out of scope here; this plan never targets it. But it is the reason the architecture matters beyond the desktop bake-off: Electron cannot ship to iOS, whereas the C-ABI core + thin-native-host + system-webview pattern can (Ghostty itself ships iOS). What transfers for free: the entire Zig core (it cross-compiles to `aarch64-ios`), the host-agnostic contract + `createSkriveBridge`, and the custom-scheme serving decision (iOS WKWebView is the same WebKit, `WKURLSchemeHandler` is identical API). What is genuinely new and NOT de-risked by this plan: a UIKit/SwiftUI host (no NSWindow/traffic-lights/menu-bar; sandboxed files via UIDocumentPicker + security-scoped bookmarks + iCloud) and — the real cost — a frontend touch-UX pass (touch targets, no-hover, soft-keyboard, ProseMirror/CodeMirror touch+IME behavior in iOS WKWebView). Cheap insurance the desktop work should already be paying: hold the core/host boundary clean (gate 4's "any core change a host demands is a design bug" applies to a future iOS host too) and keep `host:` channel commands abstract verbs, so an iOS host just implements them differently. Verify-before-betting (not assume): Zig→iOS static-lib linking maturity and App Store guideline 4.2 ("minimum functionality") risk for thin webview wrappers |

---

## Part VI — Gates, kill criteria, and graduation  *(VERDICT IN, 2026-06-23: GRADUATE)*

In the spirit of the experiment-portfolio docs: pick the exit honestly. **The exit is picked.** After Stages 1-5 (macOS + Windows both merged to main, both livable daily drivers, parity 26/26 throughout, the core never structurally changed) and a full review of the forward roadmap against the architecture, the decision is to **graduate**: the Zig family is Skrive's committed substrate and Electron is on a sunset path (`project_zig_graduation_commit` memory; the editor north-star is the next real arc). The gates below are retained as the record of how the verdict was reached; the standing kill-criteria still bind during the Stage 6 execution.

**Hard gates — how they resolved:**
1. Stage 1.3 typography (Joe-judged): **PASSED** — no CEF fallback; no fallback ever needed.
2. Stage 1 toolchain friction: **PASSED** — skeleton + spike answers reached without disproportionate fighting.
3. Stage 2 dogfooding: **PASSED** — no blocker-class problems traceable to the architecture.
4. Stage 5 core-change gate: **PASSED** — Windows required *additions* (host capabilities), never a core *design* change; the parity corpus stayed 26/26 and the core stayed byte-identical end to end. The "one core, thin hosts" thesis held on a second OS.

**Standing kill criteria (still apply during Stage 6 execution):**
- Scope creep into porting renderer-side logic to Zig "while in there." Revert and log.
- The Electron build breaking and staying broken because of this work — the shipping product wins until the sunset window (6.3) closes.
- A Zig compiler release forcing a rewrite-scale migration: pause, pin harder, finish on the pinned version, migrate after. (Zig is pre-1.0; this remains a live risk we own — the accepted cost of the lean native substrate.)

**Graduation criteria — met / in execution:**
- Parity green both OSes; manual checklists green; the Zig builds are the daily driver by preference, not discipline. **MET.**
- The Stage 6.4 numbers (installer size / cold start / memory baseline; editor latency parity required, not improvement). **IN PROGRESS** — now documentation of the win, not an input to the decision.
- The maintenance story written down: the dual-shell — now **N-host** — tax is **ACCEPTED and reframed as load-bearing discipline** (it keeps the native surface minimal and the logic in the shared renderer; `project_zig_graduation_commit`), with the Electron **sunset plan** in 6.3.

**Instructive-failure clause (retained for the record; not exercised).** Had a gate failed honestly, `docs/zig-shell-results.md` would record what was learned, the Stage 0 work stays shipped (always product work), `shell-zig/` is archived to a branch, and the ledger absorbs the findings — a decisive negative worth more than an ambiguous positive. None fired; the path was a decisive positive.

---

## Appendix — Quick-reference index for executors

- IPC contract source of truth: `shared/src/ipc-contracts.ts`
- Current Electron handlers (parity reference): `shell/src/ipc/*.ts`
- Path-safety reference + finding: `shell/src/ipc/fs.ts:22-35`, audit §4 S1
- Atomic write reference: `shell/src/lib/atomic-write.ts`
- Checkpoint layout reference: `shell/src/lib/checkpoint.ts`, `docs/checkpoint-storage.md`
- Watcher consumer expectations: `app/src/stores/project.ts`
- Library picks and platform constraints: `docs/Zig shell ecosystem survey.md` §1-3
- Prior art to read before Stage 1: ghostty (`include/ghostty.h`, modulemap idiom), vercel-labs/zero-native (`appkit_host.m`, permission manifest, `webview2_host.cpp`)
- Release process parity target: `docs/release-process.md`, `electron-builder.yml`, `.github/workflows/release.yml`
- Session log (create on first use): `docs/zig-shell-log.md`
