# Graduating a lab to its own OSS repo

Reusable checklist for promoting a `labs/` project (or `shell-zig`) into a
standalone public repository.

**Why this exists.** Labs are developed inside the monorepo under `labs/` for
fast iteration, one context, and a shared toolchain pin. They graduate into
their own public repos when they earn a name and an audience. The property that
makes this a clean extraction rather than surgery is the **isolation
invariant** every lab is born under (stated in `labs/zig-ui/README.md`):
self-contained build, zero inbound dependencies from the app, and `rm -rf
labs/<x>` breaks no Skrive build. Keep that invariant true and graduation stays
a `git subtree split`, not a rewrite.

**Decided posture** (see memory `project_labs_oss_licensing`): the labs ship
under **Apache-2.0** with contributor agreements (DCO baseline, CLA where
relicense optionality matters) so sole copyright ownership — and therefore the
right to relicense later — is preserved. This is the opposite of the app's
PolyForm-Noncommercial posture, and deliberately so: labs are reusable
libraries whose value is that other people embed them.

---

## 0. Pre-flight — does it qualify?

- [ ] **Isolation invariant holds.** Confirm a self-contained build, zero
      inbound imports from `app/` or `shared/`, and that deleting the lab dir
      breaks no Skrive build. (Grep for inbound references; do a clean build.)
- [ ] **Classification decided** — this changes the ending:
  - **Research** — nothing in Skrive depends on it. Extract-and-forget; safe to
    delete from the monorepo afterward.
  - **Load-bearing dependency** — Skrive will consume it. It needs a
    *published-artifact seam*: the app depends on a pinned published version,
    never a path/subdir import. Do **not** delete the consumer wiring.
- [ ] **It has earned a name.** Working names (e.g. `zig-ui`) get replaced
      before the public repo is created.
- [ ] **License + contribution policy confirmed.** Apache-2.0; DCO baseline;
      CLA before the first external PR (required for a load-bearing lab).

## 1. Legal / attribution prep (in the monorepo, before extraction)

- [ ] Add `LICENSE` — Apache-2.0 verbatim.
- [ ] Add `NOTICE` — your copyright line plus one line per vendored/fetched
      dependency with its license; note any local modifications (patches) you
      carry on a vendored dep.
- [ ] **Dependency audit.** For every dep (vendored source *and* fetched):
      record name, pin/version, and license; confirm Apache-compatibility; and
      where a dep is vendored as source, ensure its own LICENSE file is present.
- [ ] SPDX headers on first-party source (`// SPDX-License-Identifier: Apache-2.0`).
- [ ] **Bundled models/data/assets carry their own license.** Code license is
      not asset license. Never imply Apache-2.0 covers third-party model weights
      or data you don't own.

## 2. Scrub internal references

- [ ] `grep -rE "SKR-[0-9]+"` → `0`. Rewrite any hits as behavior descriptions.
- [ ] Remove internal URLs, Linear links, disk-only planning-doc paths, and
      teammate handles.
- [ ] Secret-scan the subtree's history (gitleaks/trufflehog), especially if you
      preserve git history.

## 3. Extract, with history

- [ ] Choose a history strategy:
  - **Preserve** — `git subtree split --prefix=labs/<x> -b <x>-export` when the
    history is clean.
  - **Fresh** — a clean-history copy (`git init`) when history carries internal
    cruft or anything a secret scan flags.
- [ ] Create the new **public** repo (name = the earned name).
- [ ] Push the export branch as `main`.

## 4. Scaffold the public repo

- [ ] `README` — what it is, explicit non-goals, build/run, toolchain pin,
      license section, contribution policy.
- [ ] `LICENSE` + `NOTICE` (carried over from step 1).
- [ ] `CONTRIBUTING.md` — DCO/CLA policy, PR expectations, how to build and test.
- [ ] CI — build + test on the pinned toolchain.
- [ ] `.gitignore`; issue/PR templates (optional).
- [ ] **Wire the CLA bot** (e.g. cla-assistant). Required *before merging
      contribution #1*, not before the first push — you own 100% of the
      copyright until an outsider contributes, so publishing never waits on this.
- [ ] Tag an initial release (optional).

## 5. Sever or re-wire the monorepo

- [ ] **Research lab** — remove `labs/<x>` (or leave it dormant until you're
      confident), and update docs/logs to point at the new repo.
- [ ] **Load-bearing lab** — replace the path/subdir usage with a pinned
      dependency on the published artifact; keep the monorepo build green; do
      **not** delete the consumer wiring.
- [ ] Update the lab's log in `docs/` with the graduation date and new repo URL.

## 6. Post-graduation

- [ ] The new repo is the source of truth; the monorepo consumes it (dependency)
      or merely references it (research).
- [ ] CLA bot confirmed active before any external PR is merged.
- [ ] Announce / link as desired.

---

## Appendix — zig-ui, first pass (worked instance)

- **Classification: research.** The README is explicit — "no Skrive feature will
  ever depend on this code … `rm -rf labs/` breaks no Skrive build." So it's
  extract-and-forget: no published-artifact seam needed, safe to delete from the
  monorepo after extraction.
- **Name: needs one.** Working name `zig-ui`; naming was deliberately tabled
  until the lab earned it. Pick before creating the repo.
- **SKR refs: 0.** Already clean — no scrub needed (step 2 is a quick confirm).
- **Dependencies:**
  - `sokol-zig` — fetched via `build.zig.zon`, pinned to a `zig-0.16.0` branch
    commit. zlib/libpng license → one NOTICE line.
  - `stb` — vendored source under `vendor/stb/`. Public-domain / MIT dual.
    **Gap: no license text is checked in with the vendored copy — add stb's
    license before publishing**, plus a NOTICE line.
  - **Local kern patch on stb** (GPOS-extension, load-bearing per the lab log).
    This is a modification to a vendored dep — capture it as a patch file or a
    clear note so the change is attributable.
- **Toolchain:** Zig 0.16.0 (matches `shell-zig/core`'s pin). CI must pin the same.
- **History:** likely clean (0 SKR refs), so `git subtree split` should be
  viable — still run a secret scan first.
