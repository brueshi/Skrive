<script lang="ts">
  // Phase 2.2 decorations spike — throwaway mount point.
  //
  // This page owns its own bare CodeMirror 6 instance so the spike can be
  // evaluated without touching src/lib/editor/Editor.svelte. The real editor
  // keeps its existing extension set; if this spike graduates, the plugins
  // in src/lib/editor/spike/decorations.ts will be rewritten against the
  // markdown syntax tree and moved into src/lib/editor/decorations/.
  //
  // The sample document below is hand-tuned to exercise every question the
  // spike is trying to answer:
  //   - a paragraph with inline bold, to test the fold + restore
  //   - a bold span next to inline code that contains stars, to surface
  //     the regex scanner's known limitations (expected to misbehave)
  //   - an inline image with a data URL so no network fetch is involved
  //   - a block image on its own line
  //   - a heading line with bold, to check interaction with CM6's existing
  //     markdown styling
  //
  // To evaluate: run `npm run tauri dev`, navigate to /spike/decorations,
  // and compare the three behaviors against `docs/spike-2.2-report.md`.

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
  import { spikeDecorations } from "$lib/editor/spike/decorations";

  // A small 2x2 red dot PNG as a data URL. Works offline and makes it
  // obvious at a glance whether the image widget rendered at all.
  const RED_DOT =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==";

  const INITIAL_DOC = `# Spike sample

This paragraph has **one bold span** inside a longer line of text so you can see the fold take effect when you move the cursor to a different line.

Here are two bolds: **first** and then **second**, side by side.

This line has an inline image ![red dot](${RED_DOT}) right here in the middle of the text.

A standalone image on its own line:

![red dot](${RED_DOT})

A heading with bold: ## Section **two**

An inline code span that contains stars: \`a**b**c\` — the spike regex will probably fold this incorrectly. That's expected.

Put your cursor on this line to see nothing change. Put it on any line with ** markers and watch the markers reappear.
`;

  let container: HTMLDivElement;
  let view: EditorView | null = null;

  onMount(() => {
    const initialDoc = untrack(() => INITIAL_DOC);

    view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          ...spikeDecorations(),
        ],
      }),
      parent: container,
    });

    return () => {
      view?.destroy();
      view = null;
    };
  });
</script>

<svelte:head>
  <title>Decorations spike</title>
</svelte:head>

<main>
  <header class="spike-header">
    <h1>Phase 2.2 decorations spike</h1>
    <p>
      Move the cursor between lines to see the <code>**bold**</code> fold toggle
      and the <code>![alt](src)</code> image widget replace its syntax. This
      route and its code under <code>src/lib/editor/spike/</code> are throwaway
      — see <code>docs/spike-2.2-report.md</code>.
    </p>
  </header>

  <div class="editor-host" bind:this={container}></div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
  }

  .spike-header {
    padding: 1.5rem 2rem 1rem;
    border-bottom: 1px solid var(--skrive-rule);
    flex-shrink: 0;
  }

  .spike-header h1 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .spike-header p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--skrive-muted);
    line-height: 1.5;
    max-width: 48rem;
  }

  .spike-header code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    padding: 0.05em 0.3em;
    background: var(--skrive-rule);
    border-radius: 2px;
  }

  .editor-host {
    flex: 1;
    min-height: 0;
    padding: 1.5rem 2rem;
    font-family:
      "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    font-size: 1rem;
    line-height: 1.65;
    overflow: auto;
  }

  :global(.editor-host .cm-editor) {
    height: auto;
    background: transparent;
  }

  :global(.editor-host .cm-content) {
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
  }

  /* Spike decoration styles. `.cm-spike-bold` is applied to the inner text
     of a folded bold span; the leading and trailing `**` are replace
     decorations with no DOM of their own, so no style is needed for them. */
  :global(.cm-spike-bold) {
    font-weight: 700;
  }

  :global(.cm-spike-image) {
    display: inline-flex;
    align-items: center;
  }
</style>
