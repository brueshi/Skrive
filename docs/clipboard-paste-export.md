# Clipboard Paste-In / Copy-Out

Make the clipboard boundary clean in both directions: paste rich content from
anywhere (a web page, Google Docs, Word, another Markdown tool) and have it
land as canonical Skrive Markdown; copy from Skrive and have it paste cleanly
into both Markdown-aware targets and rich-text targets (Gmail, Docs, Word).

This is a living tracker. Each stage is a separate commit on
`feat/clipboard-paste-export`. Deviation from the decisions below without
amending this doc is a bug.

## Why the two directions are not symmetric

The clipboard carries multiple representations at once — usually `text/plain`
alongside `text/html`, sometimes app-specific formats and binary images.

- **Copy-out** is mostly free here. We already render Markdown to HTML for the
  preview (`marked`). A dual-write clipboard puts the selection's raw Markdown
  on `text/plain` and its rendered HTML on `text/html`; the rich target gets
  formatting, everything else gets clean Markdown. The HTML comes from the same
  renderer as the preview, so what you see is what you paste.
- **Paste-in** is the genuinely new work: take the richest representation (the
  HTML) and convert it to canonical Markdown. HTML parsing plus the long tail
  of source-specific cruft is not something to hand-roll.

## Decisions

| Decision | Choice | Why the alternative lost |
| --- | --- | --- |
| Paste-in engine | **unified / mdast** (`rehype-parse` → `rehype-remark` → `remark-stringify`, `remark-gfm`) | Turndown ships faster but emits Markdown strings with no neutral AST seam. mdast is already in the tree (lint, link graph), and the mdast intermediate is the markup-neutral seam the multi-markup direction needs: future AsciiDoc/reST swaps the stringifier, not the parser. |
| Unrepresentable formatting (colour, underline, font size) | **Drop** | Preserving as raw inline HTML pollutes the canonical source and fights the multi-markup direction. Dropping keeps the source clean. |
| Copy-out | **Dual-write** (`text/plain` = Markdown source, `text/html` = rendered) | Plain-only loses rich-target formatting; the plain representation is still literal Markdown, so dual-write is strictly more useful. |
| Pasted binary images | **Write bytes to a sibling `assets/` folder**, insert a relative link | Base64 inline bloats the source and is brittle; a project-root store grows unbounded and orphans images when a doc moves. A sibling `assets/` keeps images near their doc and portable. |

## Architecture

Layered so the conversion logic is pure and fully testable in isolation, with
I/O and editor wiring kept at the edges.

- `app/src/lib/clipboard/` — pure conversion, no DOM.
  - `htmlToMarkdown.ts` — the unified pipeline; `htmlToMarkdown(html) → string`.
  - `cleanHtml.ts` — a narrow hast plugin that pre-cleans source-specific cruft.
  - Copy-out reuses `renderMarkdown` from `lib/preview/markdown.ts` (Stage 1
    adds an absolute-URL image resolver mode so images survive the paste).
- A thin CodeMirror extension (`EditorView.domEventHandlers`) wires the DOM
  `paste`/`copy`/`cut` events to those pure functions and dispatches editor
  transactions (Stages 1–2).
- Binary image writes go through Electron main via IPC (the renderer is
  sandboxed) (Stage 3).

## House-style Markdown emit conventions

Because nothing else in the app serialises Markdown yet, the `remark-stringify`
options in `htmlToMarkdown.ts` are the de-facto Skrive emit conventions. Keep
them in sync wherever we emit Markdown in future.

- ATX headings (`#`), not setext
- `-` for unordered list bullets
- `*` / `**` for emphasis / strong
- Fenced code blocks (` ``` `)
- `---` for thematic breaks
- one-space list-item indent, incrementing ordered-list markers

## Stages

### Stage 0 — Conversion core (done)

`htmlToMarkdown` plus the `cleanHtml` pre-clean, with tests. No UI wiring; the
codebase builds and the full suite passes.

- Pipeline: `rehype-parse` (fragment mode) → `rehypeCleanRichText` →
  `rehype-remark` → `remark-gfm` → `remark-stringify` (house style). All stages
  synchronous, so the eventual paste handler can run it inline.
- `cleanHtml` unwraps elements that would otherwise mis-convert: `<b>`/`<i>`
  whose inline style cancels the formatting (the Google-Docs / Word
  fake-emphasis wrappers), and `<u>` (no faithful Markdown form — dropped
  rather than silently reinterpreted as italic, per the drop decision).
- Styling that Markdown can't represent is dropped for free: `rehype-remark`
  ignores style attributes, so colour / font / size never survive.
- Tests (`app/__test__/clipboard/htmlToMarkdown.test.ts`): a table of
  structural conversions, the drop/cleanup cases, and a round-trip block
  asserting `htmlToMarkdown(renderMarkdown(md)) === md` for house-style
  Markdown — the guard against either half drifting.

Dependencies added to `@skrive/app`: `unified`, `rehype-parse`,
`rehype-remark`, `remark-gfm`, `remark-stringify`, `unist-util-visit`, and
`@types/hast` (dev).

### Stage 1 — Copy / cut out (dual-write), editor surface only (done)

CodeMirror `domEventHandlers` for `copy`/`cut`: `text/plain` gets the
selection's raw Markdown, `text/html` gets `renderMarkdown(selection)`.

- `app/src/lib/clipboard/copyOut.ts` — pure, DOM-free: `selectionMarkdown(state)`
  joins non-empty ranges (null when nothing is selected, so the editor's
  copy-the-current-line default still runs), and `buildClipboardPayload(md)`
  returns `{ text, html }`.
- `app/src/components/editor/clipboard.ts` — thin extension wiring the DOM
  events to those functions; `cut` additionally deletes the selection via a
  transaction (we called `preventDefault`, so the browser won't).
- Wired into `Editor.tsx` as `clipboardCopyExport()`.
- Tests (`app/__test__/clipboard/copyOut.test.ts`): selection gathering
  (single, multi-range, mixed empty) and the dual-write payload.

**Image resolver.** Copy-out calls `renderMarkdown(md)` with no options — the
identity resolver, exactly as the preview does today. So the copied HTML is
byte-identical to the preview, remote (`http(s)`) image URLs render in rich
targets, and relative paths behave as they do in-app. The originally-floated
absolute-`file://` resolver was dropped: web targets won't load `file://`
images, so it would add path logic without making local images render. When a
project-aware resolver lands (Phase 6), copy-out inherits it for free.

**Out of scope.** Copy-out from the read-only preview pane (needs a
selection→source map that does not exist today). Embedding local images as
data URIs so they render in web targets is a possible future enhancement.

### Stage 2 — Paste in (HTML → Markdown)

CodeMirror `paste` handler: if the clipboard has `text/html`, run
`htmlToMarkdown` and dispatch a transaction inserting at the selection;
otherwise fall back to the default plain-text paste. This is where the
real-world smoke testing (paste a live web page) lives.

### Stage 3 — Paste in (binary images)

Detect `image/*` on the clipboard, write the bytes to a sibling `assets/`
folder via Electron main, insert a relative `![](assets/…)` link.

Deferred to this stage (do not affect earlier stages):

- **Filename scheme** for pasted images — leaning timestamp + short hash to
  avoid collisions.
- **Unsaved-document case** — no sibling directory exists until the doc is
  saved; likely prompt to save first.
- **Verify** the existing `fs` IPC handles binary writes before committing the
  approach.
