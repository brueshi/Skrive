# Zig Shell Results Memo

**Status.** Running memo, now current through **Stage 6 Milestone 3** (Windows host complete + distribution: macOS Sparkle + Windows WinSparkle updaters, signed/notarized macOS DMG, NSIS installer, both appcasts; M1-M3 on `main`, M4 graduation underway). Stage 5 brought up the Zig Windows host (dogfood-confirmed); Stage 6 M1/M2 shipped the macOS updater + CI pipeline, M3 the Windows side. The **size, cold-start, and RSS** comparisons are now MEASURED on macOS (below; packaged Electron v1.6.0 vs native v1.7.1) — only the Windows cold-start/RSS pair is still open. The graduation **decision is already committed** (2026-06-23) — see the Decision section; these numbers document the win rather than deciding it. Headline: installer ~39x smaller, cold start ~2x faster, RSS ~12% lower.

**Resolves (so far).** Whether the Ghostty pattern — one Zig core behind a C ABI, a thin per-platform native host, the system webview running the byte-identical React frontend — can reach feature parity with the shipping Electron build on macOS. **Through Stage 4: yes, for everything in the reduced scope, with no architecture-class blockers.**

**Blocks.** Stage 5 (Windows host) and Stage 6 (distribution + the quantitative graduation decision). Neither is started.

---

## Scope (what "parity" means here)

Stage 4 was deliberately narrowed (decision 2026-06-22, recorded in the master plan and the log). **Diff, checkpoints, and git history were NOT ported** to the Zig shell: they are Markdown/git-conformist stand-in version-history features that Skrive is moving away from as it repositions from "Markdown editor" to "writing+notes app." Porting features slated for replacement is the wasted parity work the experiment's own kill-criteria warn against. So:

- The Electron build keeps diff/checkpoints/git shipping and untouched; the Zig build serves them from the renderer mock; the parity corpus never included them.
- A Skrive-native version history (document-model-aware, git-independent, git as an optional later integration) is a deferred future feature, not part of this experiment.

Stage 4 therefore = **4.0 native app-shell parity + 4.4 host polish**, both host-only Swift.

## What was built (through Stage 4)

| Layer | State after Stage 4 |
|---|---|
| Zig core (dispatch, fs, project, persistence, watcher) | Complete and corpus-gated. Unchanged by Stage 4 (host-only work). |
| C ABI (host <-> core) | Two functions + emit callback, stable; carries the `host:` channel for trash/reveal. |
| Swift macOS host | Full standard menu bar, link/navigation policy, dev-gated Web Inspector, theme-aware pre-paint, asset + app custom-scheme serving, flush-on-quit, watcher event marshaling. |
| Parity corpus | 26/26 green both directions (`--exec` vs the Zig core AND `bun run parity:check` vs the live Electron oracle). |
| Diff / checkpoints / git | Out of scope — mocked in the Zig build, real in Electron (see above). |
| Windows host, updater | Not started (Stages 5-6). |

The macOS Zig build is a **livable daily driver**: Joe's hands-on side-by-side pass against Electron ("everything looks and feels good") covered host chrome, files/editing, project/persistence (incl. `revealUserData`), the renderer worker features, and the watcher, all at parity.

## What was hard-won (findings the next executor should not re-pay for)

**Stage 4 / WebKit substrate.**
- **`decidePolicyFor` closure-type trap.** A `WKNavigationDelegate.decidePolicyFor` whose `decisionHandler` omits the protocol's exact `@escaping @MainActor @Sendable` closure type is a *silent near-miss overload* — Swift compiles it, WebKit never dispatches to it, and the link guard no-ops. The compiler's "nearly matches optional requirement" warning is the only signal; treat it as a correctness bug on any delegate conformance, not style noise.
- **`_WKInspector.show()` is a no-op on macOS 26.** The private programmatic inspector-open does nothing (verified at runtime: `isInspectable == true`, `_inspector` returns a valid object responding to `show`/`isVisible`, but `isVisible` stays false after `show`). So there is no programmatic DevTools toggle on this OS; the supported entry points are Safari's Develop menu (Develop > this Mac > Skrive) and right-click "Inspect Element" (reinforced with the legacy `developerExtrasEnabled` preference alongside `isInspectable`). This is a host/OS detail, not an architecture issue.

**Carried from earlier stages (still the sharp edges of this substrate).**
- **SwiftPM does not relink the host when only the Zig `.a` changes** (untracked input, content-hashed sources; `touch` doesn't help). `build-macos.sh` removes the linked product to force a ~1s relink. Zig's C cache can likewise miss a vendored-header change (`rm -rf core/.zig-cache`). Lesson: when a native change "has no effect," verify the artifact contains it before re-debugging logic.
- **Cross-target macOS SDK plumbing.** An explicit `-Dtarget=...macos` does not auto-detect the host SDK; vendored C/C++ needs `--sysroot` + framework + `usr/include` paths wired from `b.sysroot`.
- **Off-main emit + Swift 6 isolation.** The watcher emits from its poll thread; the C emit callback must be a top-level `nonisolated` function (copy-then-`DispatchQueue.main.async`), not a `@MainActor`-captured closure, or Swift 6 traps at callback entry.

## Dogfooding, distilled (through Stage 4)

- The "one core, thin hosts" thesis held: every Stage 4 item was host-only Swift with **zero `app/`, core, or contract changes**. The OS chrome Electron supplied for free (menus, link policy, window behavior) is exactly what the per-platform host is for.
- The shared-`app/` thesis keeps paying: renderer changes (themes, icon set, editor surfaces) appear in the Zig build for free on a rebuilt `out/renderer`.
- Native feel on WKWebView reads good across both editor surfaces (CM6 Text + ProseMirror Rich). The native-feel watch-list (font-smoothing `antialiased`, programmatic smooth-scroll, bespoke drag-scrub) remains open tuning, not surgery — to be judged hand-and-eye during continued dogfooding (Gate 1.3 mold), not by the latency harness.
- Honest behavioral note carried forward: editing an *open* document externally deliberately does not live-reload the buffer in either shell (conflict-on-save via `detectExternalChange`); judge the watcher by sidebar reaction.

**Residual gaps after Stage 4 (all logged, none blocker-class):** dock-icon light/dark swap (skipped — needs a light brand asset the Zig build lacks); file-open / `.md`-association (net-new cross-shell feature, deferred — no open-path verb exists in either shell today); the updater (Stage 6).

## Numbers vs baseline (Stage 6.3 / M4d)

Per the master plan, perf comparison is packaged-vs-packaged only. The graduation axes this architecture targets are installer size, cold start, and memory baseline (editor-latency *parity* is required; improvement is not claimed).

### Size — MEASURED (the headline win)

| Metric | Electron (0.7 baseline) | Zig shell | Delta |
|---|---|---|---|
| macOS installer (DMG) | 132 MB | **3.4 MB** | ~39x smaller |
| macOS update download (full artifact) | 127 MB (updater zip) | **3.4 MB** | ~37x smaller |
| Windows installer (Setup.exe) | not captured at 0.7 | **3.8 MB** | — |
| Windows portable (zip, x64) | — | **1.7 MB** | — |

The Zig macOS DMG and Windows zips are the signed/published `labs-1.5.0` assets; the Setup.exe is the M3 NSIS installer. The Setup.exe bundles the 1.6 MB WebView2 Evergreen bootstrapper, which runs only if the runtime is absent — the runtime itself is shared OS infrastructure, not shipped in the app.

**Update download is the full artifact, by design.** Sparkle/WinSparkle ship the whole binary each release (no delta machinery) precisely because a ~2-4 MB artifact makes deltas irrelevant — so an auto-update pulls single-digit MB, versus Electron's ~127 MB. (The Electron *Windows* installer baseline was never captured at 0.7; only the macOS DMG was, so that cell is left blank rather than guessed.)

### Cold start + RSS — MEASURED (macOS, packaged-vs-packaged)

Measured on the dev Mac (Apple Silicon): Electron **v1.6.0** vs native **v1.7.1**, same machine, same `docs/fixtures/perf-100` (100 files; the plan's "500" is stale — the generator makes 100). Cold start: `killall` between runs, stopwatch to caret-ready, median of 3. RSS: a before/after **PID diff** (macOS reparents WebKit content processes to launchd, so parent-PID attribution fails), summed after lint settled (~3s). Native counts `SkriveShell` + its WebKit content process and **excludes** the system-shared WebKit GPU/Networking (generous to native, but honest — that infra is shared across all WKWebView apps); Electron counts main + renderer + GPU + utility (all dedicated).

| Metric | Electron (1.6.0) | Native (1.7.1) | Delta |
|---|---|---|---|
| Cold start to caret (median of 3) | 1.25 s (1.06 / 1.25 / 1.41) | 0.61 s (0.56 / 0.61 / 0.81) | **~2x faster** |
| RSS on perf-100 | 542.9 MB (main 171.6 + renderer 239.5 + GPU 84.7 + utility 46.9) | 480.4 MB (host 93.2 + content 387.1) | **~12% lower (~62 MB)** |

**Honest reading.** The decisive wins are **size** (installer ~39x, update download ~37x) and **cold start** (~2x faster — the thin native shell has far less to spin up than Electron's main+helper Chromium fleet; the Electron runs even crept *up* across repeats, likely the sunset build's launch update-check now 404ing the flipped feed). **RSS is a modest win (~12%), not dramatic** — and notably the native WebKit *content* process (387 MB) is heavier than Electron's renderer (239 MB); native wins on total only because Electron also runs a dedicated GPU + utility process and a heavier main. That tracks with the architecture: once the same web UI is loaded, runtime memory is broadly comparable whether the browser is bundled or the system's. So the memory benefit is real but small; the footprint and startup benefits are large.

Windows cold-start/RSS remain open — same method on Joe's box when convenient; the macOS numbers already close the quantitative case.

## Skrive vs the field — Notion, Obsidian, Zed (macOS, 2026-06-24)

Footprint + startup against Skrive's nearest neighbors, on the dev Mac (Apple Silicon). Size = on-disk `du -sh /Applications/*.app` (identical method for all); startup = stopwatch to usable, median of 3, cold (`killall` between). Skrive = native v1.7.1.

| App | Install (on-disk) | Cold start (median/3) |
|---|---|---|
| **Skrive** | **10 MB** (3.4 MB download) | **0.61 s** |
| Notion | 283 MB (~28x) | 2.36 s (~3.9x) |
| Zed | 373 MB (~37x) | 0.81 s (~1.3x) |
| Obsidian | 482 MB (~48x) | 1.36 s (~2.2x) |

**Reading (honest).**
- Skrive is the smallest by 28-48x — including vs the Rust-native one.
- Skrive is the fastest to start; it edges Zed (0.61 vs 0.81 s), though that gap is within the stopwatch's ~0.1-0.2 s human margin — call it a tie-to-slight-lead. Matching a Rust+GPU native editor from a system-webview app is the surprising part; vs Obsidian/Notion the 2-4x lead is beyond noise.
- The Zed datapoint subverts "native = small": Rust buys Zed its speed but not its footprint (373 MB, heavier than Notion). Footprint is about what you SHIP, not the language. Skrive is tiny because it reuses the OS's already-resident WebKit instead of bundling a renderer/runtime; Electron ships Chromium, Zed ships its own GPU renderer + tree-sitter/LSP machinery, Skrive ships almost nothing.

**Fairness caveats.** Different scopes (Notion: databases/collab/cloud; Obsidian: plugin ecosystem; Zed: full code editor + LSP; Skrive: focused writing). "Usable" is defined per app, and Notion's startup is partly network-bound (cloud workspace load). It's a "desktop app you open to write in" comparison, not feature-for-feature. Startup is stopwatch-grade (±~0.1-0.2 s); a scripted launch-to-first-paint timer would tighten it for public use.

## Decision — COMMITTED (2026-06-23): graduate

The graduation call is made: the Zig shell is the architecture, Electron is on a sunset path. The evidence that carried it:

- **No architecture-class blocker, on BOTH platforms.** The core/host boundary held clean through Stage 5 — every host need (macOS Swift AND Windows Zig) was an *addition*, never a *change* to the core's design. The widest-error-bars risk (the Windows host forcing a core change) did not materialize: parity stayed 26/26, the core byte-identical end to end. Stage 6 (updaters, crash logs, installer, CI) was likewise all host/renderer/build-side.
- **The size thesis is confirmed** (above): ~132 MB → ~3.4 MB installer, ~127 MB → ~3.4 MB update download. The Chromium tax the experiment set out to shed is gone.
- **Both builds are livable daily drivers**, dogfood-confirmed by Joe on macOS and Windows.

Still to close (NOT blockers — confirming, not deciding): cold start + RSS, packaged-vs-packaged on both shells; and the live N→N+1 auto-update install proof, which unblocks at the cutover (when a Zig build publishes as the non-prerelease headline — see `docs/graduation-cutover.md`). Editor-latency parity is the one axis where the bar is "match, not beat," and it has held hand-and-eye across both editor surfaces.
