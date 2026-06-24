# Graduation cutover runbook (Stage 6 M4b)

The Electron -> Zig graduation is a **staged, timing-coupled release flip**. It
is deliberately NOT pre-merged: the steps must run in order, and two of them are
Joe's to trigger (tag pushes) or coordinated with the website makeover. This
runbook is the single source of truth for the sequence and the exact CI edits.

See [[project_zig_m4_graduation_plan]] for the decisions behind it.

## Why it can't just be merged ahead of time

1. Existing Electron users auto-update through **electron-updater**, which polls
   the latest `v*` **Electron** release's manifest (`latest-mac.yml` /
   `latest.yml`, published by `release.yml` with `--publish always`). So the
   final toast-bearing Electron build MUST ship as a `v*` tag via `release.yml`
   — the last time that pipeline runs on a tag.
2. The live Zig auto-update feed only turns on when a Zig build publishes as a
   **non-prerelease** (so `releases/latest` and the forever-URL aliases
   resolve). Today `zig-shell.yml` publishes `labs-*` / `win-labs-*` as
   prereleases.
3. If `v*` is added to `zig-shell.yml` while `release.yml` still has it, a `v*`
   tag fires **both** pipelines (collision). So `release.yml` loses `v*` and
   `zig-shell.yml` gains it in the **same** cutover commit — applied AFTER the
   final Electron build, never before.

## Preconditions

- [ ] M4a shipped: the migration-toast code is in a released Electron build (or
      is about to be, as the final toast build in Step 1).
- [ ] `skrive.md/download` (the toast target) resolves to the native build —
      delivered by the website makeover. If it is not ready, temporarily point
      `MIGRATION_DOWNLOAD_URL` (app/src/App.tsx) at the GitHub Releases URL
      before Step 1.
- [ ] A green `zig-shell.yml` run exists (the labs prerelease pipeline is known-
      good end to end).

## Step 1 — ship the final Electron build (toast), via release.yml

This is the LAST Electron `v*` release. Existing users auto-update into it and
see the migration notice.

```
# from main, with the M4a toast merged:
git tag v<next>            # e.g. v1.6.0
git push origin v<next>    # fires release.yml -> Electron build + latest*.yml
```

Verify: the release publishes with `latest-mac.yml` / `latest.yml`, and a prior
Electron build auto-updates into it and shows the toast.

## Step 2 — apply the cutover commit (the flip)

Make these two edits in ONE commit, then FF to main.

**`.github/workflows/release.yml`** — drop the `v*` auto-trigger (keep manual
dispatch so a transition-window Electron build is still possible):

```yaml
on:
  # Electron is on a sunset path (Stage 6 graduation). No longer auto-builds on
  # v* tags — zig-shell.yml owns v* now. Manual dispatch only, for a
  # transition-window rebuild if ever needed.
  workflow_dispatch:
```

(Remove the `push: / tags: / - "v*"` block.)

**`.github/workflows/zig-shell.yml`** — add `v*` to the triggers and publish it
as a non-prerelease (labs-* / win-labs-* stay prereleases):

```yaml
on:
  push:
    tags:
      - "v*"          # graduated headline releases (non-prerelease)
      - "labs-*"      # labs prereleases (macOS family)
      - "win-labs-*"  # labs prereleases (Windows)
  workflow_dispatch:
```

In the "Publish release" step, make `prerelease` conditional on the tag:

```yaml
      - name: Publish release
        if: github.event_name == 'push' && env.HAS_SIGNING == 'true'
        uses: softprops/action-gh-release@v2
        with:
          # v* = the graduated headline (non-prerelease, so releases/latest and
          # the forever-URL aliases resolve + the live auto-update feed turns on).
          # labs-* / win-labs-* stay prereleases.
          prerelease: ${{ !startsWith(github.ref_name, 'v') }}
          ...
```

Commit + FF:

```
git commit -m "ci: cut v* over from Electron release.yml to zig-shell.yml"
git push origin HEAD:main
```

## Step 3 — cut the first graduated Zig release

```
git tag v<next+1>          # e.g. v1.7.0
git push origin v<next+1>  # fires ONLY zig-shell.yml now -> non-prerelease
```

This publishes the signed/notarized DMG + the Windows Setup.exe + both
appcasts as a **non-prerelease**, so:
- `releases/latest` resolves to the Zig build,
- the forever-URLs resolve: `Skrive-zig.dmg`, `appcast-zig.xml`,
  `Skrive-Setup.exe`, `appcast-win.xml`,
- the live auto-update feeds (SUFeedURL in the macOS Info.plist and
  updater.zig) go hot.

## Step 4 — prove N->N+1 auto-update live (the gated install proof)

- macOS: a prior signed Zig build offers + installs this release via Sparkle.
- Windows: a prior installed Zig build offers + installs this release via
  WinSparkle (the appcast-win.xml enclosure verifies against the shipped EdDSA
  public key).
- Confirm the website download (skrive.md/download) lands on the native build.

## Rollback

The cutover is two CI edits + tags. To revert before Step 3's tag, restore the
`v*` trigger on `release.yml` and drop it from `zig-shell.yml`. Published
GitHub releases are immutable history; a bad Zig release can be marked
prerelease/draft to take it out of `releases/latest` while leaving the Electron
releases (still present) as the resolved latest.

## After the transition (later sunset, NOT M4)

Once adoption has moved over: stop building Electron entirely (delete
`release.yml`), remove `shell/`, and drop the Rust `native/diff` napi binding.
Tracked separately as the sunset step.
