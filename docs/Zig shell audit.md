# Zig Shell Audit

**Status.** Audit complete, 2026-06-10. No code changed. Companion: `Zig shell ecosystem survey.md` verifies the available libraries/patterns, answers the secure-context question flagged below, and sharpens the spike plan accordingly.

**Question.** Could Skrive's shell be a purpose-built Zig binary driving a native webview (WKWebView / WebView2 / WebKitGTK), hosting the existing React + ProseMirror + CodeMirror frontend unchanged, shedding the Chromium-plus-Node runtime that Electron bundles?

**Verdict in one paragraph.** The frontend is already in unusually good shape for this: a single typed bridge (`window.skrive`, contract in `shared/src/ipc-contracts.ts`), zero Electron or Node imports anywhere in `app/src`, and a Markdown round-trip that lives entirely in renderer-side pure JS. The real migration surface is not the editor — it is the ~2,800 lines of TypeScript business logic that currently live in the Electron main process (link graph, search, history, project scanning, TOML config), plus three genuinely hard shell primitives Electron currently hides: the file watcher, the updater, and the secure-context behavior of custom URL schemes in native webviews. The architecture is roughly 80% ready by accident of good discipline; the remaining 20% is well-defined and mostly enumerable.

---

## Two framing findings before the sections

### F1. The existing Zig experiment docs target a stack that no longer exists

`Zig diff experiment.md`, `Zig lint experiment.md`, and `Zig link graph experiment.md` were written for the Tauri/Rust era. They reference `src-tauri/src/diff.rs`, `src-tauri/src/lint.rs`, and a Rust link graph. Since the stack reset:

- The **diff** is Rust via NAPI in `native/diff/` — the only experiment that still has a systems-language baseline, but the FFI story changed from C-ABI-into-Rust to N-API addon (or a Zig sidecar process).
- The **lint engine** is now pure TypeScript running in a Web Worker (`app/src/lib/lint/`).
- The **link graph** is now TypeScript in the Electron main process (`shell/src/lib/link-graph/`, 669 lines).

This changes what the experiments measure. Lint and link graph would now be "Zig vs JS," not "Zig vs Rust" — much easier for Zig to win on raw numbers, but no longer a test of whether Zig beats a peer systems language. The portfolio docs need re-grounding before any of them start, or their decision rules will be calibrated against baselines that aren't there.

### F2. The Chromium tax and the webview ceiling are different problems

`Ledger-criteria.md` tracks **webview-fundamental ceilings**: composition, browser layout, the editor living inside an engine you don't own. A Zig + native-webview shell does not address a single category-1 ledger entry — the editor still renders in a browser engine (Safari's, in fact, on macOS, which lags Chromium on some CSS).

What this architecture *does* address is the **Chromium tax**: ~100MB+ of bundled runtime per install, the Node main process, Chromium's memory baseline, Electron's security-update treadmill, and slow cold start. Those are real and worth pursuing — but they belong in `case-for-zig.md` territory (known on day one), not the ledger.

Practical consequence: if the ledger ever fills with category-1 entries, the answer is native text rendering, not zig-webview. Keep both documents honest about which problem this experiment solves. They are compatible directions — a Zig shell is a plausible stepping stone toward native surfaces later — but conflating them would rationalize the rebuild on evidence it doesn't have.

---

## 1. Architecture & Modularity

### What's already right

- **Frontend decoupling: strong.** Every bridge call in `app/src` goes through `window.skrive`, typed by `SkriveIpc` (`shared/src/ipc-contracts.ts:327-563`). No `ipcRenderer`, no Node imports, no Electron imports in renderer code. `app/package.json` has zero Electron dependencies. The renderer bundle (`out/renderer/`) is plain static HTML/JS/CSS and can in principle load unchanged in any webview, given three things: a bridge injecting `window.skrive`, an equivalent of the `skrive-asset://` scheme, and module-worker support.
- **Round-trip is shell-agnostic.** Parse, serialize, dirty tracking, schema — all in `app/src/lib/projection/`. Only Markdown strings cross the IPC boundary. Swapping the shell does not touch the editor's correctness story at all.
- **The frontend is already swappable in the direction the audit asks about.** New ProseMirror nodes, toolbar features, slash commands, themes — all pure JS-side today. A Zig shell preserves that exactly, because the contract is data-shaped, not API-shaped.

### Gaps

**G1. No transport abstraction.** There are two implementations of the bridge contract: the Electron preload (`shell/src/preload/index.ts`, 223 lines) and the legacy web shim from the Tauri era (`src/lib/platform-web/core.ts`, dead code, never tested against the React app). They share nothing. Recommend a `createSkriveBridge(transport)` factory in `shared/`, where a transport is `{ invoke(cmd, payload), on(event, handler) }`. Then Electron IPC, native-webview postMessage, and a browser shim (which the skrive.md website refresh wants anyway) become three thin transports under one tested contract. This ships value with zero Zig work.

**G2. No command envelope.** IPC registration is ad-hoc `ipcMain.handle()` per namespace file — fine for Electron, but a native webview bridge is a single string-marshaled channel, so you need a JSON envelope regardless: `{ id, cmd, payload }` request, `{ id, ok, result | error }` response, plus a push channel for events (`project:change`, `updater:status`, `app:flush-before-quit`). Define the envelope now and route Electron's handlers through one dispatch function. This is the "command registry" the audit scope asks about, it makes the Zig dispatcher a mechanical port, and it is independently testable.

**G3. Business logic lives in the wrong process for a Zig world.** ~2,819 of the shell's ~3,919 lines are not shell plumbing: link graph (669), checkpoint manager (438), persistence (391), `.skrive.toml` parser (291), git history (151), search (106), plus project scanning and manifest building. In a Zig shell there is no Node runtime to run this TypeScript. Three options:

1. **Port it all to Zig.** Maximum surface, slowest path, and per F2 it buys little — none of this code is slow because of Electron.
2. **Move pure-text analysis into the renderer/workers.** Link graph, search, and frontmatter inference are pure functions over file contents. Lint already lives in a worker. The shell then exposes only primitive FS ops plus a batched project snapshot. This keeps the logic in JS where it stays malleable (and shared with the website embed), and shrinks the Zig surface to true shell primitives.
3. **Hybrid.** Option 2 now; port hot paths to Zig later only when measured.

Recommend option 2. One caveat: native webview IPC is string-marshaled and *slower* than Electron's structured-clone IPC. A 500-file project scan must cross the bridge as one batched JSON payload (or a paginated stream), never per-file round-trips. Design the snapshot command shape with this in mind.

**G4. Reusable Zig core: yes, and it falls out naturally.** The app-agnostic kernel is: window + webview lifecycle, custom scheme handler serving an embedded `dist/`, JSON command dispatch, sandboxed FS namespace, watcher, dialogs/trash/open-external. That is a `skrive-shell` Zig package any future markup tool (or the multi-markup direction) could reuse. Keep Skrive-specific commands in a separate module registered against the dispatcher.

**G5. Build integration.** Keep the frontend a fully separate Vite project building to `dist/` (it nearly is — `electron-vite` is the only Electron-flavored piece, and only for the main/preload targets). In `build.zig`, either add a system-command step invoking `bun run build`, or — simpler and more robust — treat `dist/` as a prebuilt input and embed it via `@embedFile` behind the custom scheme. Embedding gives the single-binary story, which is half the point.

---

## 2. Core Features & Planned Functionality

| Concern | Today | In a Zig shell | Difficulty |
|---|---|---|---|
| MD round-trip | Pure JS in renderer | Unchanged | None |
| Autosave | Renderer debounce → `fs:writeFile` atomic (tmp + fsync + rename, `shell/src/lib/atomic-write.ts`) | Same pattern, directly expressible in `std.fs` | Low |
| Atomic writes | Solid | Port pattern verbatim | Low |
| File watching | chokidar v4 | **Hardest single feature.** Zig std has no watcher. FSEvents (macOS) + ReadDirectoryChangesW (Windows) bindings, plus the event coalescing, rename pairing, and debounce chokidar does for free | High |
| Folder dialog | `dialog.showOpenDialog` | NSOpenPanel / IFileDialog | Low-medium |
| Trash | `shell.trashItem` | NSWorkspace recycle / IFileOperation | Low-medium |
| Open external | `shell.openExternal` + allowlist | NSWorkspace / ShellExecuteW, same allowlist | Low |
| Asset serving | `skrive-asset://` protocol | WKURLSchemeHandler / WebResourceRequested | Medium |
| History (git) | spawns system `git` | `std.process.Child`, portable | Low |
| History (checkpoints) | Pure FS logic in TS | Port or move per G3 | Medium |
| Persistence | JSON in `userData` | Platform app-data dirs (`~/Library/Application Support`, `%APPDATA%`) | Low |
| Updater | electron-updater + GitHub Releases | **Lost entirely.** Sparkle (macOS) + WinSparkle or a hand-rolled GitHub-releases checker with staged swap | High |
| Menus / multi-window / tray | Not implemented in Electron either | Not a porting burden | — |

The full bridge surface is ~40 invoke commands across 10 namespaces plus 4 event channels. A usable MVP needs roughly the `fs`, `project`, `persistence`, and `links` namespaces (~20 commands) plus the watcher; `diff`, `history`, and `updater` can stub to empty exactly the way the old web shim did.

Extensibility hooks (command palette registry, themes, keyboard workflows) all live in `app/src/lib/commands/registry.ts` and CSS — untouched by a shell swap.

---

## 3. Cross-Platform Support

- **macOS (WKWebView).** The engine is Safari's, not Chromium. Two consequences. First, CSS floor: `light-dark()` in `app/src/index.css` needs Safari 17.5+ → effectively macOS 14.5 minimum, or ship the `data-theme` fallback path. Module workers are fine (Safari 15+). Second, **typography will visibly change**: today macOS and Windows render identically because both are Chromium; with native webviews, the Overcast look (Fraunces/Palatino) renders through Core Text on macOS and Chromium on Windows. For a product whose soul is typography, this is a product decision, not just a technical one — it needs an eyeball gate in the first spike.
- **Windows (WebView2).** Evergreen Chromium, so near-parity with today's rendering — but it is a *runtime dependency*: preinstalled on current Win 10/11, yet the installer should handle the bootstrap case. The loader (WebView2Loader) must be linked or shipped. Zig cross-compiles the binary from macOS happily, but packaging (NSIS) and WebView2 testing mean keeping the per-OS CI matrix anyway.
- **Linux (WebKitGTK).** Out of scope, consistent with the current desktop-only/no-Linux platform decision. WebKitGTK lags both other engines and cannot realistically be cross-compiled; don't let it creep into the experiment.
- **Secure-context risk (must be verified empirically, Spike 1).** `navigator.clipboard` — which the preview copy path uses with rich HTML payloads — is only available in secure contexts. An app served from a custom scheme may not be a secure context in WKWebView; WebView2 has explicit custom-scheme registration with secure-treatment options; WKWebView's story is murkier and apps commonly fall back to localhost serving or `loadFileURL`. Storage APIs (localStorage/IndexedDB) on custom schemes have similar per-engine quirks. This single question can reshape the asset/serving design, which is why it gates everything else.
- **Packaging.** DMG + notarization and NSIS survive unchanged conceptually; entitlements get simpler (no Chromium helpers). The win: a Zig shell binary is single-digit MB against today's ~100MB+ per platform, and cold start should improve substantially — but measure the Electron baseline first so the claim is a number, not a vibe.
- **Testing plan.** Per-OS CI for build + the parity harness (section 5); manual checklist per OS for watcher behavior, dialogs, clipboard, and typography sign-off.

---

## 4. Security & Correctness

### Current posture (good, with one finding)

Sandbox on, context isolation on, node integration off, navigation denied with `shell.openExternal` allowlisted to `https?|mailto|tel|skrive`, every FS op funneled through `resolveSafe`, no eval anywhere.

**Finding S1 — containment is lexical, not physical.** `resolveSafe` (`shell/src/ipc/fs.ts:22-35`) uses `path.resolve` + `path.relative`, which never touches the disk. A symlink *inside* the project pointing *outside* it passes the check; reads, writes, and the `skrive-asset://` handler (which mirrors the same logic) will follow it out of the root. Severity today is low — single-user local app, the renderer is the only caller, and the user chose the project root — but it is exactly the kind of subtle gap that must not be ported naively. Fix in both worlds: `realpath` the resolved target's parent and re-verify containment. Worth a small fix in the Electron shell now.

### Zig-shell posture

- **The bridge is the entire attack surface.** Every command goes through one JSON envelope: parse with typed `std.json` into per-command structs (reject unknown fields), impose payload size caps, and keep the command table closed — no dynamic registration from JS, which also answers the "no arbitrary eval or FS access from JS" requirement by construction.
- **Response injection is the classic native-webview bug.** Bridges deliver responses via `evaluateJavaScript`. If a response containing file content is string-interpolated into that script, a Markdown file becomes a script-injection vector into your own UI. The pattern must be: JSON-encode the full envelope, escape it as a JS string literal, and call one fixed dispatch function. This deserves a dedicated test with adversarial file contents.
- **Webview dependency audit.** This is the highest-risk dependency decision in the whole proposal. The C `webview/webview` library and the Zig bindings ecosystem around it (the bindings you mentioned included) are thin, variably maintained, and I can't vouch for any specific one's quality without evaluating it directly. Two credible paths: vendor a binding and audit it line-by-line (they are small), or write the platform glue directly — the macOS surface is modest objc-runtime `msgSend` work for WKWebView, and Windows is COM calls against the WebView2 loader. Direct glue is more upfront work but removes the least-trustworthy link from the chain and is itself the reusable core (G4). Evaluate the bindings in Spike 1 before committing either way.
- **Privacy.** Offline-first is preserved; the updater remains the only network path, and it shrinks to one HTTPS check you wrote yourself. No telemetry surface exists or is added.

---

## 5. Code Quality, Performance & Maintainability

- **The parity oracle already exists.** The 14 shell vitest suites (link-graph extract/fixtures/rename, skrive-toml, checkpoint, atomic-write, persistence, manifest) are exactly the fixture-oracle discipline the experiment docs prescribe. Port the *fixtures*, not the tests: a small harness that drives the Zig shell's dispatch function with recorded `(cmd, payload) → result` pairs gives cross-implementation parity testing for free, and doubles as the regression suite for the Electron shell.
- **Zig practices for the shell.** Arena allocator per bridge request (parse, handle, serialize, reset — the request/response shape is the natural arena boundary); comptime platform dispatch for the windowing/dialog/watcher glue; one error set per subsystem surfaced to JS as structured `{ code, message }`. The allocator-discipline sections of the lint and link-graph experiment docs carry over intact even though their targets moved languages.
- **Toolchain risk.** Zig is pre-1.0 with real breaking changes between releases. Pin the version in `build.zig.zon`/CI, vendor everything, and budget upgrade time per release. `zig fmt` in CI alongside the existing typecheck step; frontend stays TS-strict as-is.
- **Honest performance accounting (ledger discipline).** The link graph, search, and lint are not slow because of Electron — they are JIT-compiled JS on a hot VM, and moving them behind a string-marshaled bridge can make end-to-end *worse*. The measurable wins this architecture actually offers: installer size (~100MB → single-digit MB), memory baseline (no bundled Chromium + Node processes; WKWebView's content process is shared system infrastructure), cold start, and update-cadence/security-surface ownership. Claim those; don't claim editor-latency wins the design doesn't deliver.
- **Documentation.** If a spike starts, it needs its own README covering: build order (frontend dist first), the envelope spec, the transport contract, and the frontend-swap guide (which is short, because the answer is "implement `SkriveIpc`").
- **Housekeeping flag.** The dead Tauri/Svelte trees (`src-tauri/`, root `src/`, `svelte.config.js`, `vite.config.js`, `static/`, `build/_app/`, the four `legacy:*` scripts) actively confused this audit's tooling and inflate every future one. Archive to a branch and delete from `main`.

---

## 6. Overall Risks & Recommendations

### Red flags, prioritized

1. **Stale experiment docs (F1)** — decision rules calibrated against a vanished Rust stack. Re-ground before any experiment starts.
2. **Ledger/Chromium-tax conflation risk (F2)** — this architecture must not be sold internally as fixing webview ceilings.
3. **Secure-context unknowns** — clipboard and storage behavior on custom schemes can reshape the serving design; it gates everything.
4. **Watcher and updater are systematically underestimated** in every Electron-alternative discussion; here they are explicitly the two High cells in the table.
5. **Typography divergence across engines** — a product-soul risk unique to Skrive, needs an early eyeball gate.
6. **Symlink containment gap (S1)** — fix in Electron now, design correctly in Zig from day one.

### Roadmap — each stage leaves a working state

**Stage 0 — ships value regardless of Zig (do in the Electron app, now):**
- Transport abstraction + command envelope (G1, G2)
- Symlink-aware `resolveSafe` (S1)
- Batch-shaped project snapshot command (G3 caveat)
- Delete legacy trees; re-ground or annotate the three experiment docs
- Record baseline numbers: installer size, cold start, RSS after opening a 500-file project

This is the "what lands in shipped Skrive regardless" tranche, in the experiment docs' own idiom — and Stage 0 is most of what makes the frontend genuinely shell-agnostic, which the website embed wants anyway.

**Spike 1 — the question-answering weekend.** Zig + WKWebView loading the existing `out/renderer` bundle with a stub `window.skrive` (hardcoded read-only project, the web-shim trick). Answers empirically: secure context / clipboard / storage, module workers, `light-dark()`, asset scheme, typography by eye, and whether the Zig webview bindings are usable or you write the glue. Gate it like the diff experiment: if the toolchain fights for more than a weekend or two, that is itself the result.

**Spike 2 — real `fs` + `project` namespaces in Zig;** link graph and search moved to a renderer worker. Editable single project with autosave. This is the MVP the audit scope asks about.

**Spike 3 — the watcher.** Its own time-box; FSEvents first.

**Spike 4 — Windows/WebView2 port of Spike 2.** Only now does cross-platform cost become known rather than estimated.

Packaging, signing, and the updater come after a graduate/fail decision, not before.

### Success metrics

- **Standalone editor "done":** all ~40 commands implemented or explicitly stubbed; the fixture parity harness green against the Zig dispatch; the same renderer bundle boots on WKWebView and WebView2; autosave + watcher + external-change detection verified per OS; typography signed off by eye.
- **Framework "done":** the `skrive-shell` core builds with zero Skrive-specific code; a second toy app (even a 50-line note viewer) runs on it; the envelope and transport are documented well enough that the frontend-swap guide is one page.
- **The numbers that justify it:** installer size, cold start, and RSS against the Stage 0 baselines — published in the results memo in the existing memo format.

### Token-efficient prompting for future sessions

- `shared/src/ipc-contracts.ts` is the canonical artifact; it alone specifies most of the Zig surface. Paste it, not the handlers.
- Port one namespace per session, fixtures-first: give expected `(cmd, payload) → result` pairs from the vitest fixtures and ask for the Zig handler that satisfies them.
- Keep a short `zig-shell/CLAUDE.md` with the envelope spec, allocator convention, and error-shape convention so each session starts calibrated instead of re-deriving.
- For the platform glue, one platform per session; the comptime dispatch seam keeps them independent.

### Relationship to the experiment portfolio

This audit does not replace the diff/lint/link-graph portfolio — it reorders it. The shell spike is now the highest-information experiment available, because F1 hollowed out two of the three originals: the calibration question moved from "is Zig better than Rust at algorithms" to "is a Zig shell viable as the substrate." The diff experiment (the one survivor with a real systems-language baseline) still makes sense afterward, retargeted at the NAPI module. The ledger keeps running in parallel, unchanged, tracking the question this architecture deliberately does not answer.
