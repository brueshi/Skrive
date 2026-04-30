<script lang="ts">
  // CodeMirror 6 editor wrapped as a controlled Svelte 5 component.
  //
  // Contract:
  //   - The `value` prop is the source of truth for document content.
  //   - All edits flow through CodeMirror's transaction system. There are no
  //     imperative mutations from the parent or from this component.
  //   - When the user edits in the view, the listener writes back to `value`
  //     and calls `onChange`. When the parent assigns a new `value` (e.g. on
  //     file load), a separate effect dispatches a single replace transaction.
  //
  // The "controlled" part is enforced by always going through `view.dispatch`
  // for any document change — even programmatic ones from the parent — so we
  // never have two sources of truth fighting each other.

  import { onMount, tick, untrack } from "svelte";
  import { EditorState } from "@codemirror/state";
  import type { Command } from "@codemirror/view";
  import {
    EditorView,
    keymap,
    highlightActiveLine,
    drawSelection,
  } from "@codemirror/view";
  import type { PendingSelection } from "$lib/types";
  import {
    history,
    defaultKeymap,
    historyKeymap,
    indentMore,
    indentLess,
  } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { GFM } from "@lezer/markdown";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { skriveTheme } from "./skrive-theme";
  import { inlinePreview, setImageContext } from "./decorations";
  import { setPersonalDictionary } from "./decorations/spellcheck";
  import { preferences } from "$lib/stores/preferences.svelte";
  import { project } from "$lib/stores/project.svelte";
  import { notify } from "$lib/stores/notifications.svelte";
  import { projectRelToSourceRel } from "$lib/imageSrc";

  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i;
  const ATTACHMENTS_SUBDIR = "attachments";

  let dragOver = $state(false);

  type Props = {
    value?: string;
    onChange?: (next: string) => void;
    /**
     * One-shot selection request: when `nonce` changes, move the
     * cursor (and optionally select a span) to the given line/column.
     * The parent never needs to clear it — a fresh nonce replays the
     * effect.
     */
    selection?: PendingSelection | null;
  };

  let {
    value = $bindable(""),
    onChange,
    selection = null,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = null;

  // ⌘' adds the word at the cursor to the personal dictionary. Lives
  // here (rather than in +page.svelte's global keydown handler) because
  // CodeMirror gives us `state.wordAt(pos)` which knows about word
  // boundaries, and the keymap fires *before* the document keydown so
  // it preempts any browser default.
  const addWordAtCursorCommand: Command = (v) => {
    const range = v.state.wordAt(v.state.selection.main.head);
    if (!range) return false;
    const word = v.state.doc.sliceString(range.from, range.to).trim();
    if (word.length === 0) return false;
    preferences.addPersonalWord(word);
    return true;
  };

  // Tab/Shift-Tab indent or outdent list items when the cursor (or every
  // line in the selection) sits on a markdown list line. Outside list
  // context the commands return false so default Tab handling runs —
  // important because writers occasionally indent prose, and indenting
  // prose by 4+ spaces would silently turn it into a CommonMark code
  // block. Gating on list context avoids that footgun.
  //
  // Pattern matches `- foo`, `* foo`, `+ foo`, `1. foo`, `1) foo`, and
  // any of the above with leading indent (already-nested items).
  const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

  const allSelectionLinesAreLists = (v: EditorView): boolean => {
    const { state } = v;
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toLine = state.doc.lineAt(range.to).number;
      for (let n = fromLine; n <= toLine; n++) {
        if (!LIST_LINE.test(state.doc.line(n).text)) return false;
      }
    }
    return true;
  };

  // Always returns true when the gesture lands on a list line — even if
  // indentLess can't outdent further (e.g. Shift-Tab on a top-level
  // bullet) — so focus doesn't escape the editor on a no-op outdent.
  const tabIndentListItem: Command = (v) => {
    if (!allSelectionLinesAreLists(v)) return false;
    indentMore(v);
    return true;
  };

  const shiftTabOutdentListItem: Command = (v) => {
    if (!allSelectionLinesAreLists(v)) return false;
    indentLess(v);
    return true;
  };

  onMount(() => {
    const initialDoc = untrack(() => value);

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const next = update.state.doc.toString();
      // Read `value` without subscribing — we only want to push, not react.
      untrack(() => {
        if (next !== value) {
          value = next;
          onChange?.(next);
        }
      });
    });

    view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown({ extensions: GFM }),
          ...inlinePreview(),
          // Hand spellcheck off to the OS / webview. WKWebView, WebView2,
          // and WebKitGTK all run a system-grade spellchecker on
          // contenteditable surfaces; CodeMirror's content surface is
          // exactly that. We get the user's preferred language, the OS
          // personal dictionary ("Learn Spelling"), and right-click
          // suggestions for free. Phase 2.4 Step 2 will layer
          // markdown-aware `spellcheck="false"` decorations on top so
          // the OS doesn't try to correct code spans, URLs, or YAML.
          EditorView.contentAttributes.of({ spellcheck: "true" }),
          keymap.of([
            { key: "Mod-'", run: addWordAtCursorCommand },
            { key: "Tab", run: tabIndentListItem },
            { key: "Shift-Tab", run: shiftTabOutdentListItem },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          skriveTheme,
          updateListener,
          EditorView.lineWrapping,
        ],
      }),
      parent: container,
    });

    // File-drop import. Tauri v2 intercepts file drops at the webview
    // level (default `dragDropEnabled: true`) and emits paths via the
    // drag-drop event, so the standard browser drop event never fires
    // for files. We don't position-scope: only the active tab's editor
    // is mounted (SplitView re-keys on tab switch), so a drop anywhere
    // on the window unambiguously targets the visible editor. Earlier
    // attempts to scope by bounding rect were brittle on HiDPI because
    // Tauri's `position` is reported in physical pixels.
    let unlistenDragDrop: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        switch (event.payload.type) {
          case "enter":
          case "over":
            dragOver = true;
            break;
          case "leave":
            dragOver = false;
            break;
          case "drop":
            dragOver = false;
            if (!view) return;
            void handleFileDrop(event.payload.paths);
            break;
        }
      })
      .then((unlisten) => {
        unlistenDragDrop = unlisten;
      });

    return () => {
      unlistenDragDrop?.();
      view?.destroy();
      view = null;
    };
  });

  async function handleFileDrop(paths: string[]) {
    if (!view) return;

    // Empty paths means Tauri received a drop but the source didn't
    // include any filesystem path — common when dragging from a
    // browser, Slack, Photos.app's preview pane, or a screenshot tool
    // before the file is saved. Surface this so the writer knows why
    // nothing happened, rather than silently failing.
    if (paths.length === 0) {
      notify.info(
        "That drag didn't include a file path. Save the image first, then drag it from Finder.",
      );
      return;
    }

    const imagePaths = paths.filter((p) => IMAGE_FILE_RE.test(p));
    if (imagePaths.length === 0) {
      notify.info("Drop an image file (png, jpg, gif, webp, svg, …).");
      return;
    }

    const insertions: string[] = [];
    let failures = 0;
    const activeFilePath = project.activeTab?.path ?? null;
    for (const srcPath of imagePaths) {
      try {
        const projectRel = await invoke<string>("copy_attachment", {
          srcPath,
          subdir: ATTACHMENTS_SUBDIR,
        });
        // Markdown image URLs are *source-file-relative*. From
        // `chapters/draft.md`, the project's `attachments/foo.png`
        // has to be written as `../attachments/foo.png` or no
        // markdown reader (Skrive included) can resolve it.
        const sourceRel = projectRelToSourceRel(projectRel, activeFilePath);
        const slash = sourceRel.lastIndexOf("/");
        const filename = slash >= 0 ? sourceRel.slice(slash + 1) : sourceRel;
        const dot = filename.lastIndexOf(".");
        const stem = dot > 0 ? filename.slice(0, dot) : filename;
        // CommonMark URLs can't contain unescaped spaces or other
        // special characters; an unescaped space in `![](path with
        // spaces.png)` makes the parser bail on the Image node entirely
        // — and a screenshot like "Screenshot 2026-04-29 at 6.25.png"
        // is exactly that case. encodeURI keeps `/` and standard URL
        // chars intact, encodes spaces and accented characters.
        const encodedUrl = encodeURI(sourceRel);
        insertions.push(`![${stem}](${encodedUrl})`);
      } catch (err) {
        failures += 1;
        notify.error(`Couldn't import ${srcPath}: ${String(err)}`);
      }
    }

    if (insertions.length === 0) {
      if (failures === 0) {
        notify.info("No image was imported.");
      }
      return;
    }
    view.focus();
    view.dispatch(view.state.replaceSelection(insertions.join("\n")));
  }

  // External writes to `value` (from parent state, e.g. opening a different
  // file) are reflected by dispatching a single replace transaction. We guard
  // against echoing edits we just emitted by comparing against the live doc.
  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  });

  // Apply a pending selection request from the parent (e.g. a search-
  // result jump). The nonce is what we track so repeated jumps to the
  // same line still fire. Wrapped in `tick()` because on first mount the
  // effect may run before `view` is set; yielding to the microtask queue
  // lets onMount complete first.
  function applyPendingSelection(sel: PendingSelection) {
    if (!view) return;
    const doc = view.state.doc;
    const line = Math.min(Math.max(sel.line, 1), doc.lines);
    const lineInfo = doc.line(line);
    const anchor = Math.min(lineInfo.from + sel.column, lineInfo.to);
    const head = Math.min(anchor + sel.length, lineInfo.to);
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    view.focus();
  }

  let lastAppliedNonce = -1;
  $effect(() => {
    const sel = selection;
    if (!sel) return;
    if (sel.nonce === lastAppliedNonce) return;
    (async () => {
      await tick();
      if (!view) return;
      const current = selection;
      if (!current || current.nonce === lastAppliedNonce) return;
      lastAppliedNonce = current.nonce;
      applyPendingSelection(current);
    })();
  });

  // Bridge the Svelte rune for the personal dictionary into the
  // CodeMirror state via a `setPersonalDictionary` StateEffect. The
  // spellcheck plugin's StateField listens for this effect and rebuilds
  // its decoration set whenever the list changes — adding or removing
  // a word in the dictionary panel updates the editor instantly across
  // all open files without us having to subscribe each plugin to the
  // store individually.
  $effect(() => {
    if (!view) return;
    const dict = preferences.personalDictionary;
    view.dispatch({ effects: setPersonalDictionary.of(dict) });
  });

  // Push project root + current file path into the image-decoration
  // state so `![alt](attachments/foo.png)` resolves to a webview-loadable
  // asset URL. Re-fires whenever the writer switches tabs or opens a
  // different project.
  $effect(() => {
    if (!view) return;
    const projectRoot = project.manifest?.root ?? "";
    const filePath = project.activeTab?.path ?? null;
    view.dispatch({
      effects: setImageContext.of({ projectRoot, filePath }),
    });
  });
</script>

<div class="editor-host" class:drag-over={dragOver} bind:this={container}></div>

<style>
  .editor-host {
    height: 100%;
    width: 100%;
    overflow: hidden;
    position: relative;
  }

  /* Drag-over visual: a dashed editorial inset and a barely-there
     background tint. Loud enough to confirm "yes, drop here works,"
     quiet enough not to feel like the app is shouting. The pseudo-
     element approach keeps the outline above CodeMirror content
     without nudging the layout. */
  .editor-host.drag-over::after {
    content: "";
    position: absolute;
    inset: 6px;
    border: 1.5px dashed var(--skrive-fg);
    border-radius: 4px;
    background: color-mix(in srgb, var(--skrive-fg) 4%, transparent);
    pointer-events: none;
    opacity: 0.6;
    z-index: 1;
  }

  :global(.cm-editor) {
    height: 100%;
  }

  /* Inline-preview decoration styles. Mark decorations in
     src/lib/editor/decorations/ apply these class names to the text
     *inside* hidden markup, so the visual emphasis survives even when
     the surrounding `**`, `*`, or `~~` are replaced to nothing.

     Scoped under `.cm-content` so specificity beats lang-markdown's
     built-in highlight classes — otherwise the stable-emphasis state
     field would keep losing to the parser's transient "not bold" view
     during active typing. */
  :global(.cm-content .cm-md-bold) {
    font-weight: 700;
  }
  :global(.cm-content .cm-md-italic) {
    font-style: italic;
  }
  :global(.cm-content .cm-md-strikethrough) {
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  /* Inline code: the grammar doesn't tag the content of an InlineCode
     span with `t.monospace` (only the `CodeMark` backticks are tagged),
     so we apply the monospace font here via decoration class. Subtle
     background tint distinguishes code from surrounding prose without
     fighting the editorial tone. */
  :global(.cm-content .cm-md-code) {
    font-family:
      ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas,
      monospace;
    font-size: 0.92em;
    background: var(--skrive-rule);
    border-radius: 2px;
    padding: 0 0.2em;
  }

  /* Inline image widget rendered in place of `![alt](src)` on non-cursor
     lines. Capped so a runaway asset can't hijack the line height; the
     aspect ratio is preserved by max-width + max-height working together.
     Users who want a bigger view can drop into preview mode. */
  :global(.cm-content .cm-md-image) {
    max-height: 3em;
    max-width: 20em;
    vertical-align: middle;
    border-radius: 3px;
    object-fit: contain;
  }
</style>
