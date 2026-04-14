# Icon Inventory

The complete list of icons Skrive will need across the project lifetime, prioritized by phase. This is a working checklist — mark icons off as you draw them.

The visual style spec lives in [`design-system.md`](design-system.md#iconography). Read that first if you haven't yet. Everything below assumes the same 24×24 grid, 1.5px starting stroke, currentColor approach.

---

## How to use this doc

### Status legend

- `[ ]` — Not started
- `[~]` — In progress / draft exists in paper.design
- `[x]` — Drawn, exported, wrapped in a Svelte component, available in the app

### Naming convention

`Icon{Domain}{Variant}.svelte` — e.g.:
- `IconLayoutRaw.svelte`
- `IconLayoutSplit.svelte`
- `IconFileMarkdown.svelte`
- `IconChevronDown.svelte`

### Where they live

```
src/lib/icons/
├── index.ts                  # re-exports every icon
├── IconLayoutRaw.svelte      # one component per icon
├── IconLayoutSplit.svelte
├── ...
└── brands/                   # third-party brand marks (exception)
    ├── ObsidianMark.svelte
    ├── NotionMark.svelte
    └── ...
```

### Drawing workflow

1. Open the 24×24 template canvas in paper.design
2. Draw the icon
3. Export as SVG with `currentColor` strokes (not hardcoded hex)
4. Open `src/lib/icons/IconWhatever.svelte`, paste the SVG paths into the template
5. Add the import to `src/lib/icons/index.ts`
6. Visit `/icons` in the dev app to see it in context

The `/icons` gallery route gets built early in Phase 2.1 so this loop is fast from the moment you have the first icon.

---

## Brand icons exception

Third-party services (Obsidian, Notion, Bear, Astro, Docusaurus, Next.js, GitHub) have trademark logos. We use the **real official marks** for those, not custom interpretations. They live in `src/lib/icons/brands/` as a separate folder, and they are **not your work to draw**.

When we need a brand icon:
1. Pull from the brand's official asset page
2. Save as `src/lib/icons/brands/{Name}Mark.svelte`
3. Respect the brand's usage guidelines (clear space, do-not-modify rules, color requirements)

This is the only exception to "all custom."

---

## Phase 2.1 — Must have for the next milestone

**6 icons.** Drawing target: complete before Phase 2.1 implementation begins.

These are the Phase 2 critical-path icons. The split view, sidebar, and header bar can't be built without them.

| | Name | What it is | Notes |
|---|---|---|---|
| `[~]` | `layout-raw` | Single rectangle | The "writing only" mode. Editor bounds only — `rect x=3 y=5 w=18 h=14`, centered on the 24 grid. A quiet fullscreen feeling. |
| `[~]` | `layout-split` | Two side-by-side rectangles | Editor + preview joined at a common seam. Divider carries the same 1.5px weight as the outer frame. |
| `[~]` | `layout-preview` | Rectangle with text lines inside | Reading mode. Three short horizontal strokes inside the frame; the last one ragged (text block, not literal). |
| `[~]` | `sidebar-toggle` | Frame + rail column, filled or hollow (state pair) | **Pair, not a single icon.** `shown` state fills the rail column with material; `hidden` state is the same frame and divider with the rail hollow. Implement as one Svelte component `IconSidebarToggle.svelte` taking a `shown: boolean` prop that conditionally renders the inner filled `<rect>` — cheaper than two files and lets the material transition animate as a single element. |
| `[~]` | `chevron-down` | Two strokes meeting at 40° | Angle locked at **40°** (rise 5 over run 6 — points `6,10 → 12,15 → 18,10`). Generic disclosure indicator used everywhere. **Strong candidate for the Skrive constant** — if this angle feels right after a few more icons use it, document it below and adopt it. |
| `[~]` | `dot-unsaved` | Small filled pip (circle, r=3) | Filled brass circle centered at `12,12`. The only place the accent color appears in the header — pressed brass on cream. CSS would also work; drawing it as an SVG keeps the sizing decision alongside every other icon. |

**Drawing notes for the set:**
- The three layout icons are a related set. Draw them together. They tell you whether your style is internally consistent.
- `chevron-down` is reused everywhere — it's worth iterating on more than the others.
- All six need to work at 16×16 *and* 24×24. Hand-draw both variants.
- The 16×16 variants use a softer **1.25px stroke** (not the 1.5px of the 24×24 set). Tune by eye, not by ratio — what matters is that the small mark looks the same weight as the large one optically.
- Fill-based features (the `dot-unsaved` pip, the `sidebar-toggle` rail fill) survive the scale-down intact. Stroke-based interior marks do not — a line with round caps needs ~1 unit of clearance on each end, which leaves almost nothing inside a 4-unit-wide rail at 16px. Prefer fills for interior indicators.

---

## Phase 2.3 — Frontmatter UI

**0 new icons.** The frontmatter panel header is a text label, not an icon, per the icon-light direction. If we change our minds during 2.3 implementation, add an icon here.

---

## Phase 3.1 — Link graph commands

**3 icons.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `link` | A simple chain link, two ovals interlocked | Used in the backlinks panel and anywhere we show "this file links to." |
| `[ ]` | `link-broken` | Same chain link with a slash through it | Dead link warnings. The slash should be 1.5x the stroke width to feel deliberate, not accidental. |
| `[ ]` | `rename` | A simple pencil | Right-click rename action. Reused as the generic "edit anything" icon throughout the app. |

---

## Phase 3.2 — Lint engine

**3 icons (16×16 only — gutter markers).**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `lint-warn` | Triangle with a small dot inside | Editor gutter warnings. 16×16 only — these never appear at 24px. |
| `[ ]` | `lint-error` | Filled circle, or a careful X mark | Editor gutter errors. Color-coded with `--skrive-error`. |
| `[ ]` | `lint-info` | Lowercase i in a circle | Editor gutter informational notices. Could share with the universal `info` icon. |

---

## Phase 3.3 — Structural diff

**5 icons.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `diff-added` | Plus sign in a small enclosure | Marks newly added blocks in the diff view. |
| `[ ]` | `diff-removed` | Minus sign in a small enclosure | Marks removed blocks. |
| `[ ]` | `diff-moved` | Two-arrow swap, or a curved arrow | Marks blocks that moved position. **This icon is on the demo path** — get it right. |
| `[ ]` | `diff-reworded` | Pencil with a tilde or wave | Marks paragraphs whose text changed. Could share with `rename` if it works. |
| `[ ]` | `history` | Clock face with rewind, or stacked layers | Opens the file history panel. |

---

## Phase 4 — Importers

**1 new icon + brand exception.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `import` | Down-arrow into a box or folder | Generic "import to project" action. |

**Brand icons (not your work):** `ObsidianMark`, `NotionMark`, `BearMark`. Pulled from each brand's official assets.

---

## Phase 5 — Exporters

**4 new icons + brand exception.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `export` | Up-arrow out of a box or folder | Generic "export from project" action. Visual mirror of `import`. |
| `[ ]` | `file-pdf` | Page with a folded corner, "PDF" mark or distinguishing detail | PDF export target. |
| `[ ]` | `file-html` | Page with angle brackets, or `<>` motif | HTML export target. |
| `[ ]` | `file-epub` | Open book | ePub export target. |

**Brand icons (not your work):** `AstroMark`, `DocusaurusMark`, `NextMark`, `NotionMark` (reused).

---

## Phase 6 — Polish

**2 new icons.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `settings` | Sliders, not a gear | Gears are visually busy. Sliders are quieter and more editorial. |
| `[ ]` | `keyboard` | Keyboard outline with key dots | Keyboard shortcut reference. |

---

## Phase 7 — License & distribution

**2 new icons.**

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `key` | A skeleton key, drawn carefully | License key entry dialog. This icon is on the buy/upgrade path — give it personality. |
| `[ ]` | `lock` | Closed padlock | Pro-feature gating indicator. Appears next to gated export targets. |

---

## Universal utility

**8 new icons.** These get used across many phases — draw them when you need them, not all at once.

| | Name | What it is | Notes |
|---|---|---|---|
| `[ ]` | `search` | Magnifying glass | Search field affordance, command palette indicator. |
| `[ ]` | `plus` | Plus sign | New file, add anything. Pair with `chevron-down` to test consistency between angles and intersections. |
| `[ ]` | `x` | Close mark | Dismiss dialogs, close panels, clear inputs. **Custom-drawn** — not a font character. |
| `[ ]` | `check` | Checkmark | Confirmation, completed state, "saved" affordance. |
| `[ ]` | `chevron-up` | Same line as `chevron-down`, rotated 180° | Don't draw twice — rotate via CSS or a single shared component. |
| `[ ]` | `chevron-left` | Back navigation | Same — could share a base shape with `chevron-down`. |
| `[ ]` | `chevron-right` | Forward navigation, disclosure | Same. |
| `[ ]` | `dots-horizontal` | Three small dots in a row | Overflow menu. Horizontal feels lighter than vertical for sidebar contexts. |

---

## Counts

| Phase | New icons | Cumulative |
|---|---:|---:|
| 2.1 must-have | 6 | 6 |
| 2.3 frontmatter | 0 | 6 |
| 3.1 link graph | 3 | 9 |
| 3.2 lint | 3 | 12 |
| 3.3 structural diff | 5 | 17 |
| 4 importers | 1 | 18 |
| 5 exporters | 4 | 22 |
| 6 polish | 2 | 24 |
| 7 license | 2 | 26 |
| Universal utility | 8 | 34 |

**Total custom icons across the project lifetime: 34.**

Of those, ~6 also need a hand-drawn 16×16 variant (the gutter markers and small chevrons). That brings the total drawing count to roughly **40 distinct icons**.

The Phase 2.1 batch of 6 is the only one that's blocking. Everything else can be drawn in time for the phase that needs it.

---

## Drawing log

A place to capture lessons learned as you draw. Update freely.

### Open notes

- The Phase 2.1 batch lives in paper.design as `Plate 01 · Iconography · Phase 2.1`, with the exploration pass on `Plate 01b · Variants · Exploration`. Drafts exist; Svelte components and exports do not yet — that's the jump from `[~]` to `[x]`.
- Candidate for the Skrive constant: the **40° chevron angle**. Draft only — confirm after 2–3 more icons use it and still feel right.

### Lessons from drawing the first batch

- **The three layout icons did work as a set.** Drawing them together (shared rect dimensions, shared 1.5px stroke, shared round caps) made it obvious when one was inconsistent. Do the same for every future batch.
- **16px is not a scaled 24px.** It's a separate drawing with its own stroke, its own margins, and sometimes its own content. At 16px the `sidebar-toggle` rail can hold a filled block but cannot hold a stroked interior line — round caps alone eat the entire clearance. First draft of the 16 variant had a marker clipping the outer frame; the fix was to drop the marker, then to switch the whole mark system to fills.
- **Sidebar-toggle needed to become a pair.** A single "toggle" icon can't represent both states honestly — the button needs to *show* that it changes something. Filling the rail for `shown` and hollowing it for `hidden` keeps both states in one component and lets the transition animate as a single fill change.
- **First instinct on `dot-unsaved` was a diamond (hallmark reference), but the pip won on restraint.** The diamond was interesting, but brought more personality than a save indicator should. The filled circle stays out of the way until it's needed, which is the whole job.
- **Brass appears exactly once in the set** — on `dot-unsaved`. Resist the urge to add it anywhere else. Color-as-meaning only works if the color is rare.

### The Skrive constant

The unifying detail that runs through every icon — see [`design-system.md`](design-system.md#the-skrive-constant).

**Status:** *draft candidate.* **40°** — the angle of `chevron-down` (rise 5 over run 6). A shallow chevron feels deliberate, not aggressive. Confirm the constant once a few more angled-feature icons (notably `link`, `diff-moved`, `rename`) echo the same number. If they do, adopt it and document here with finality. If they fight it, pick a different unifier.
