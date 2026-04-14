<script lang="ts">
  // Read-only markdown preview pane. Renders via the marked pipeline and
  // styles the output to match the editor's typographic scale so a user
  // flipping between raw, split, and preview modes sees the same line lengths
  // and text weights across all three.
  //
  // The rendered HTML is inserted via `{@html}`. We consider file content
  // trusted input (see markdown.ts for the justification). If that ever
  // changes, sanitize in the pipeline, not here.

  import { renderMarkdown } from "./markdown";

  type Props = {
    body: string;
  };

  let { body }: Props = $props();

  let html = $derived(renderMarkdown(body));
</script>

<div class="preview" role="document">
  <div class="preview-inner">
    {@html html}
  </div>
</div>

<style>
  .preview {
    height: 100%;
    width: 100%;
    overflow-y: auto;
    background: var(--skrive-bg);
    color: var(--skrive-fg);
  }

  .preview-inner {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2.5rem 2rem 6rem;
    font-family:
      "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia,
      serif;
    font-size: 1rem;
    line-height: 1.65;
  }

  .preview-inner :global(h1),
  .preview-inner :global(h2),
  .preview-inner :global(h3),
  .preview-inner :global(h4),
  .preview-inner :global(h5),
  .preview-inner :global(h6) {
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.25;
    margin: 1.75em 0 0.5em;
    color: var(--skrive-fg);
  }

  .preview-inner :global(h1) {
    font-size: 1.85rem;
    margin-top: 0;
  }
  .preview-inner :global(h2) {
    font-size: 1.45rem;
  }
  .preview-inner :global(h3) {
    font-size: 1.2rem;
  }
  .preview-inner :global(h4),
  .preview-inner :global(h5),
  .preview-inner :global(h6) {
    font-size: 1.05rem;
  }

  .preview-inner :global(p) {
    margin: 0 0 1em;
  }

  .preview-inner :global(a) {
    color: var(--skrive-link);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .preview-inner :global(strong) {
    font-weight: 600;
  }

  .preview-inner :global(em) {
    font-style: italic;
  }

  .preview-inner :global(ul),
  .preview-inner :global(ol) {
    margin: 0 0 1em;
    padding-left: 1.5em;
  }

  .preview-inner :global(li) {
    margin-bottom: 0.25em;
  }

  .preview-inner :global(blockquote) {
    margin: 1em 0;
    padding: 0.25em 0 0.25em 1em;
    border-left: 2px solid var(--skrive-rule);
    color: var(--skrive-muted);
  }

  .preview-inner :global(hr) {
    border: 0;
    border-top: 1px solid var(--skrive-rule);
    margin: 2em 0;
  }

  .preview-inner :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--skrive-rule);
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }

  .preview-inner :global(pre) {
    background: var(--skrive-rule);
    padding: 1em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1em 0;
    line-height: 1.5;
  }

  .preview-inner :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 0.85rem;
  }

  .preview-inner :global(img) {
    max-width: 100%;
    height: auto;
  }

  .preview-inner :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.95em;
  }

  .preview-inner :global(th),
  .preview-inner :global(td) {
    border-bottom: 1px solid var(--skrive-rule);
    padding: 0.5em 0.75em;
    text-align: left;
  }

  .preview-inner :global(th) {
    font-weight: 600;
  }
</style>
