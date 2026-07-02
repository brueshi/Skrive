# Shell verification checklist

The Chromium harness (`bun run test:latency`) is structurally blind to a whole
class of editor bugs: WKWebView clipboard-flavor differences, selection lifetime
across menu interactions, and IME composition. Three of the four bugs that
motivated the SKR-153 audit were Chromium-invisible. Until that class is
automated, **this manual pass in the real shell is the honest gate** (finding
F36).

Run it:

- **at every Wave boundary** (standing rule in the dual-mode build sequence), and
- **before tagging any release.**

The shell is the truth. Launch it with `bun run start`; a `surface.ts` /
clipboard change does not HMR, so clear `app/node_modules/.vite` and restart
when the build must change. `window.__skriveCaretDebug = true` turns on caret
instrumentation. Copy the block below into the PR or release notes and check the
boxes as you go — an unchecked box is an unverified claim, not a pass.

---

## 1. Nothing is lost (autosave / drain)

The debounce → idle-callback drain (SKR-154). Type a few characters, then
immediately — inside ~1s, before the writer-pause save lands — trigger each exit
and confirm the last keystrokes survive on reopen from disk.

- [ ] Type, then `⌘S` immediately → reopen file: last characters present.
- [ ] Type in tab A, click tab B within ~400ms, switch back to A: A's tail survives.
- [ ] Type, then close the tab (`⌘W`) immediately → reopen from disk: tail persisted.
- [ ] Type, then `⌘Q` immediately → relaunch: edit was saved.
- [ ] Type, toggle to raw source view and back: no lost characters either direction.

## 2. Clipboard flavors and dual-write (WKWebView)

WKWebView exposes and accepts a different set of clipboard flavors than
Chromium. Verify against the real system clipboard, not the harness.

**Paste in** — paste into a paragraph and confirm marks/structure survive:

- [ ] Google Docs selection (bold + italic + a link + a list).
- [ ] Microsoft Word selection (bold + italic + a heading).
- [ ] Apple Notes selection.
- [ ] A rich web page (mixed formatting).
- [ ] Notion and Obsidian selections.
- [ ] Plain text (`⌘⇧V` literal paste) lands verbatim, no Markdown interpretation.
- [ ] Paste into a **code block**: newlines and markup land verbatim (no collapse).

**Copy / cut out** — select a rich range spanning two blocks, copy, and paste
into a plain-text target (e.g. a terminal) and a rich target (e.g. Notes):

- [ ] Copy writes both a plain-text and an HTML flavor (rich target keeps formatting).
- [ ] Cut removes the selection and the clipboard matches what copy would have written.
- [ ] The copied slice does not leak an unselected block's type onto the first/last line.

## 3. Selection restore after every menu

Commands must act on the selection that was live when the menu opened, never the
DOM selection at click time (the saved-selection pattern). After each action the
caret/selection must land where the writer expects.

- [ ] Selection bubble: **bold**, **italic**, **inline code**, **strikethrough** — each
      applies to the originally-selected range and leaves it selected.
- [ ] Link editor: add a link, then edit it, then remove it — selection restored each time.
- [ ] EditorBar formatting toolbar: same marks via the top band, selection preserved.
- [ ] Slash menu: convert a block (heading, quote, list, code, divider, table) —
      caret lands inside the converted block.
- [ ] Open a menu, dismiss with `Escape`: selection is exactly as before opening.
- [ ] Apply a mark, then immediately type: the typed text continues from the caret,
      not from a stale position.

## 4. IME composition per block type

Composition must persist wherever typing does. Compose CJK (or any IME) text,
commit it, `⌘S`, and reopen — the composed text must be on disk in every block
type below (F82 covered code blocks and table cells specifically).

- [ ] Paragraph.
- [ ] Heading.
- [ ] Blockquote.
- [ ] Bullet / ordered list item.
- [ ] Code block.
- [ ] Table cell.
- [ ] Compose mid-word inside existing text (composition boundary correctness).

## 5. Caret and break behavior

The WKWebView caret-commit path differs from Chromium (`sel.collapse`, not bare
`addRange`; click-toggles bound to `click`, not `pointerup`).

- [ ] Click precisely between two characters: caret lands there, no jump.
- [ ] Caret around a hard break (`Shift+Enter`) / inline image: arrows and Backspace
      behave at the boundary; the atom is deletable and not duplicated on split.
- [ ] Sidebar collapse toggle and other motionless clicks register (no dropped `pointerup`).

---

*Provenance: SKR-193 (gate appendix, finding F36). The paste class this guards
against produced SKR-148 / 150 / 151 / 152; the drain class produced SKR-154;
IME-per-block-type is F82. When any of these is automated in a shell-capable
harness, retire the corresponding section here rather than letting it rot.*
