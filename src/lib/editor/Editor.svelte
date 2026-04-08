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
  import { skriveTheme } from "./skrive-theme";

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
          markdown(),
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
</style>
