# Zig Shell Results Memo

**Status.** Running memo, now current through **Stage 6 Milestone 3** (Windows host complete + distribution: macOS Sparkle + Windows WinSparkle updaters, signed/notarized macOS DMG, NSIS installer, both appcasts; M1-M3 on `main`, M4 graduation underway). Stage 5 brought up the Zig Windows host (dogfood-confirmed); Stage 6 M1/M2 shipped the macOS updater + CI pipeline, M3 the Windows side. The **size** baseline comparison is now MEASURED (below); **cold start + RSS** remain PENDING (they were never captured for Electron either, so they need a packaged-vs-packaged measure of both shells). The graduation **decision is already committed** (2026-06-23) — see the Decision section; these numbers document the win rather than deciding it.

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

### Cold start + RSS — still PENDING (packaged-vs-packaged, both shells)

Neither was captured for Electron at 0.7 either (logged PENDING Joe), so both need a fresh measure of BOTH packaged builds on the same machine, same method:

- **Cold start to first keystroke** — stopwatch the packaged build cold (fresh login or `killall`), dock-bounce to caret-ready, median of 3. macOS: both builds run on the dev box. Windows: on Joe's box.
- **RSS after opening the perf fixture** — open `docs/fixtures/perf-100` (100 files; the plan's "500" is stale prose — the generator makes 100), let lint settle (~2s), sum the main + renderer/webview process RSS (`ps -o rss=` / Activity Monitor / Task Manager). Measure the SAME fixture on both shells.

These two are the only numbers left to fully close the quantitative case; the size axis is already decisively in the Zig column (and, with system-webview reuse instead of a bundled Chromium, RSS is expected to follow — to be confirmed, not claimed).

## Decision — COMMITTED (2026-06-23): graduate

The graduation call is made: the Zig shell is the architecture, Electron is on a sunset path. The evidence that carried it:

- **No architecture-class blocker, on BOTH platforms.** The core/host boundary held clean through Stage 5 — every host need (macOS Swift AND Windows Zig) was an *addition*, never a *change* to the core's design. The widest-error-bars risk (the Windows host forcing a core change) did not materialize: parity stayed 26/26, the core byte-identical end to end. Stage 6 (updaters, crash logs, installer, CI) was likewise all host/renderer/build-side.
- **The size thesis is confirmed** (above): ~132 MB → ~3.4 MB installer, ~127 MB → ~3.4 MB update download. The Chromium tax the experiment set out to shed is gone.
- **Both builds are livable daily drivers**, dogfood-confirmed by Joe on macOS and Windows.

Still to close (NOT blockers — confirming, not deciding): cold start + RSS, packaged-vs-packaged on both shells; and the live N→N+1 auto-update install proof, which unblocks at the cutover (when a Zig build publishes as the non-prerelease headline — see `docs/graduation-cutover.md`). Editor-latency parity is the one axis where the bar is "match, not beat," and it has held hand-and-eye across both editor surfaces.
