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

Verified in a live test: editor copy emits clean HTML (our handler beats CM's
built-in and prevents the browser's native copy). Copy from the rendered
preview goes through the browser's native copy, which inlines the theme's
`background-color` and bleeds it into rich targets (Google Docs). Addressed by
Stage 1.1 below.

### Stage 1.1 — Preview copy button (done)

A copy button in the preview copies the **whole document** as a clean
dual-write payload — `buildClipboardPayload(stripLeadingFrontmatter(body))`
written via `navigator.clipboard.write` (a click is a user gesture, so the
async Clipboard API is allowed). The payload comes from `renderMarkdown`, not
DOM serialization, so there is structurally no background to bleed; frontmatter
is stripped to match what the preview shows. Verified clean into Google Docs.

- `Preview.tsx` — the button, `copied` state, and the `copyDocument` handler
  (falls back to `writeText` if a rich write is refused). Hidden when the
  document is empty.
- `IconCopy` / `IconCheck` — new icons on the stroke/dual-size convention; the
  success state is a check (shape change, neutral colour). The copy → check
  swap is a blur crossfade (stacked glyphs, ~220ms ease-out, blur bridging the
  gap between states), disabled under `prefers-reduced-motion`.
- `.preview-copy` in `index.css` — top-right ambient button, quiet by default
  and sharper on hover; shifts left of the outline rail via
  `.preview-host.has-rail`.
- Whole-document copy, not selection-aware: the button metaphor implies "copy
  all" and it sidesteps the preview mapping problem.
- Always visible but quiet (muted → fg on hover), favouring discoverability.

Still deferred: clean copy of a *manual selection* inside the preview (needs
the selection→source map). The button is the clean route in preview mode;
manual preview selections keep the browser's native behaviour.

### Stage 2 — Paste in (HTML → Markdown) (done)

A CodeMirror `paste` handler converts the clipboard's `text/html` through the
Stage 0 core and inserts the result; with no rich HTML it declines so CM's
default plain-text paste runs (typed or pasted plain Markdown lands verbatim,
never round-tripped). Verified against live web pages and Google Docs,
including the fake-bold cruft cleanup.

- `markdownForPaste(html)` in `htmlToMarkdown.ts` — the pure decision: returns
  the converted Markdown, or null (defer to default paste) for blank HTML or a
  conversion that yields nothing.
- `clipboardPasteImport()` in `components/editor/clipboard.ts` — thin handler;
  reads `text/html`, dispatches a `replaceSelection` with
  `userEvent: 'input.paste'`, declines on `readOnly` or absent clipboardData.
- Wired into `Editor.tsx` alongside `clipboardCopyExport()`.
- Tests cover the decision (blank / no-content / real HTML); conversion
  fidelity is covered by the Stage 0 fixtures.

Known behaviours (by design): pasting Skrive's own dual-write back in
round-trips through the converter, normalising to house style rather than
landing byte-identical; pasting a binary image does nothing yet (no
`text/html`) — that's Stage 3.

### Stage 3 — Paste in (binary images)

Investigation resolved two of the deferred questions: there are **no untitled
buffers** (every open document has an on-disk path, so a sibling `assets/`
always exists), and the `fs` IPC was **text-only** (so a binary write had to be
added). Split into two commits.

#### Stage 3a — write the bytes + insert the link (done)

Detect an image on the clipboard with no usable HTML (a screenshot or
"Copy Image"; rich HTML still wins so web images stay remote links), write the
bytes to a sibling `assets/` folder via Electron main, insert a relative
`![](assets/…)` link.

- `fs.writeBinaryFile(projectRoot, relPath, base64)` — new IPC: contract
  (`shared`), handler (`shell/ipc/fs.ts`, reusing `resolveSafe`, no
  markdown graph/checkpoint side-effects), and preload bridge.
- `lib/clipboard/pasteImage.ts` — pure helpers (extension map, sibling-`assets/`
  placement, space-free `pasted-image-{timestamp}.{ext}` name, link), tested.
- `clipboardPasteImport()` extended: picks the image off the clipboard
  synchronously, `preventDefault`s, then writes + inserts asynchronously
  (`File` → base64 via `FileReader`). Project root + doc path read from the
  store at paste time. Failures surface as a toast.

#### Stage 3b — render local images (in progress)

Pasted (and all local) images don't render yet — the preview/editor image
resolver is still identity. Wire it up:

- Register a privileged `skrive-asset` scheme + `protocol.handle` in main that
  resolves a project-relative path against the active project root
  (`projectState.root`), confined like `resolveSafe`, content-type by
  extension.
- A renderer resolver rewrites doc-relative image URLs to `skrive-asset://…`
  (http/https/data pass through), wired into the preview (`renderMarkdown`) and
  editor (`setImageResolver` + image context), threading the active doc path in.
