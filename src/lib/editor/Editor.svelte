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

  import { onMount, untrack } from "svelte";
  import { EditorState } from "@codemirror/state";
  import {
    EditorView,
    keymap,
    highlightActiveLine,
    drawSelection,
  } from "@codemirror/view";
  import {
    history,
    defaultKeymap,
    historyKeymap,
  } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { GFM } from "@lezer/markdown";
  import { skriveTheme } from "./skrive-theme";
  import { inlinePreview } from "./decorations";

  type Props = {
    value?: string;
    onChange?: (next: string) => void;
  };

  let { value = $bindable(""), onChange }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | null = null;

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
          keymap.of([...defaultKeymap, ...historyKeymap]),
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
