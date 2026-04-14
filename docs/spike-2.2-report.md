# Phase 2.2 decorations spike — report

**Status.** Complete. All three questions answered yes. Go decision: proceed to Step 4 (full Phase 2.2 implementation).

## What the spike is

A throwaway branch (`spike/phase-2.2-decorations`) that mounts two CodeMirror 6 `ViewPlugin` decorations on a hardcoded sample document. The goal is a yes/no answer to three questions before committing to the full inline preview implementation.

Files involved:

- `src/lib/editor/spike/decorations.ts` — both plugins.
- `src/routes/spike/decorations/+page.svelte` — a bare CM6 instance with the sample document. The real `Editor.svelte` is untouched.
- This report.

To run it: `npm run tauri dev`, then navigate to `/spike/decorations`. Move the cursor between lines and watch the decorations toggle.

## The three questions

### Q1. Can a widget decoration render an inline image inside a markdown line?

**Implementation.** A `WidgetType` subclass (`ImageWidget`) renders an `<img>` element with capped max dimensions. A `ViewPlugin` scans the visible ranges for `![alt](src)` matches and replaces each match with a `Decoration.replace` carrying the widget. The replace is suppressed on the line containing the cursor so the raw syntax remains editable — same cursor-awareness pattern used for the emphasis plugin.

**Answer.** Yes. Images rendered inline and standalone as intended; the `![alt](src)` syntax reappears on the cursor line. Detailed line-height and baseline tuning is deferred to the production implementation — the spike only had to prove the widget approach is viable, and it is.

### Q2. Can a replace decoration collapse `**bold**` markers on lines where the cursor is absent, while keeping the bold text styled?

**Implementation.** The emphasis plugin scans visible ranges for `**...**` matches on lines other than the cursor line. For each match it stacks three decorations: a `Decoration.replace` on the leading `**`, a `Decoration.mark({ class: "cm-spike-bold" })` on the inner text, and a `Decoration.replace` on the trailing `**`.

**Answer.** Yes. `**` markers disappear on non-cursor lines and the inner text renders bold via the `cm-spike-bold` class. The known-broken pathological cases (inline code spans containing stars, nested emphasis) behave as predicted — that's a regex-scanner limitation, not a CM6 limitation, and the production implementation will walk the markdown syntax tree instead.

### Q3. Does the fold restore cleanly when the cursor returns to the line?

**Implementation.** The same `ViewPlugin.update` hook rebuilds decorations on `update.selectionSet`. Returning to a previously folded line excludes that line from the decoration set, which puts the `**` markers back in the document view at their original positions.

**Answer.** Yes. The fold restores cleanly when the cursor returns to the line. `update.selectionSet` is the right trigger.

## Decision

**Go.** Step 4 proceeds on the plan as written. The production decorations will be rewritten against the markdown syntax tree (not regex) and split into the per-feature files listed in `docs/phase-2-plan.md`.

## Notes written during implementation

- The regex scanner is deliberately minimal. It misses escaped asterisks, inline-code spans containing stars, and nested emphasis. These are not what the spike is evaluating — it's evaluating whether CM6 can be persuaded to do the visual trick at all, and the scanner just needs to be good enough to put decorations in front of a human for a few minutes of inspection.
- Images are captured inside a wrapper `<span class="cm-spike-image">`. If Q1 comes back partial because of baseline issues, that wrapper is where the production version will hang alignment styles.
- The cursor-awareness for the image widget mirrors the emphasis plugin intentionally. In the real product a user clicking a rendered image probably wants to *see* the markup to edit it, which is the same reason we hide bold markers only when the cursor isn't on the line.
- Both plugins watch `update.selectionSet`. If Q3 comes back with noticeable flicker, the fix is probably not to debounce but to make the decoration set diff cheaper — only rebuild the lines that actually crossed the cursor boundary.
