# Zig Shell Results Memo

**Status.** In progress — a *running* memo, current through **Stage 4** (macOS native app-shell parity, reduced scope; merged to `main` at `87a903f`). The master plan names this file as the Stage 6.3 close-out, but per the log's own discipline ("so later stages and the results memo don't have to reconstruct them") it accumulates findings as stages land. The quantitative baseline comparison (installer size, cold start, RSS, update download) and the final graduation decision are the Stage 6.3 sections and are marked PENDING below — they need the Windows host and a re-measure on the Zig builds.

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

## Numbers vs baseline — PENDING (Stage 6.3)

Not yet measured on the Zig builds. The Stage 0.7 Electron baselines (installer DMG size, cold start to first keystroke, RSS on the 500-file fixture) are recorded in the log and are the comparison targets. The Zig-build re-measure + update-download size are Stage 6.3, after Windows and distribution land. The graduation axes this architecture actually targets are installer size, cold start, and memory baseline (editor-latency *parity* is required; improvement is not claimed).

## Decision recommendation — PENDING (Stage 6.3), interim read

Too early for the graduation call (it is evidence-based at 6.3, needs the numbers and the Windows data point). **Interim:** through Stage 4 the experiment has produced no architecture-class blocker — the core/host boundary has held clean (every host need was an addition, never a core change), parity is corpus-gated and manually confirmed on macOS, and the build is preferred-usable. The open risk with the widest error bars remains Stage 5 (Windows host); per the plan, any *change* (not addition) the Windows host forces on the core's design would damage the "one core, thin hosts" thesis and is the next real gate.
