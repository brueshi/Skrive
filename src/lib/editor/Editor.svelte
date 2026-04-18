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
  } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { GFM } from "@lezer/markdown";
  import { skriveTheme } from "./skrive-theme";
  import { inlinePreview } from "./decorations";
  import { setPersonalDictionary } from "./decorations/spellcheck";
  import { preferences } from "$lib/stores/preferences.svelte";

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

    return () => {
      view?.destroy();
      view = null;
    };
  });

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
</script>

<div class="editor-host" bind:this={container}></div>

<style>
  .editor-host {
    height: 100%;
    width: 100%;
    overflow: hidden;
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
