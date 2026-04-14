<script lang="ts">
  import {
    IconLayoutRaw,
    IconLayoutSplit,
    IconLayoutPreview,
    IconSidebarToggle,
    IconChevronDown,
    IconDotUnsaved,
    IconSearch,
    IconPlus,
    IconX,
    IconCheck,
  } from "$lib/icons";

  let sidebarShown = $state(true);
</script>

<svelte:head>
  <title>Skrive · Icon Gallery</title>
</svelte:head>

<div class="gallery">
  <header class="header">
    <div class="meta-row">
      <span class="meta meta-accent">SKRIVE / DESIGN SYSTEM</span>
      <span class="meta">24 × 24 · 1.5PX · CURRENTCOLOR</span>
    </div>
    <h1>Icon Gallery.</h1>
    <p>Every mark in the set, drawn by hand, at both sizes. Click the sidebar toggle to feel it animate.</p>
  </header>

  <section class="section">
    <div class="section-head">
      <span class="section-mark">§ Row I</span>
      <h2>Phase 2.1 — Layout &amp; shell</h2>
      <span class="section-rule"></span>
    </div>
    <div class="grid">
      <div class="cell">
        <div class="display">
          <IconLayoutRaw />
        </div>
        <div class="scale">
          <IconLayoutRaw size={16} />
        </div>
        <div class="label">
          <span class="slug">layout-raw</span>
          <span class="desc">Writing-only mode</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconLayoutSplit />
        </div>
        <div class="scale">
          <IconLayoutSplit size={16} />
        </div>
        <div class="label">
          <span class="slug">layout-split</span>
          <span class="desc">Editor + preview</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconLayoutPreview />
        </div>
        <div class="scale">
          <IconLayoutPreview size={16} />
        </div>
        <div class="label">
          <span class="slug">layout-preview</span>
          <span class="desc">Reading mode</span>
        </div>
      </div>

      <div class="cell">
        <button
          class="display interactive"
          type="button"
          onclick={() => (sidebarShown = !sidebarShown)}
          aria-label="Toggle sidebar state"
        >
          <IconSidebarToggle shown={sidebarShown} />
        </button>
        <div class="scale">
          <IconSidebarToggle size={16} shown={sidebarShown} />
        </div>
        <div class="label">
          <span class="slug">sidebar-toggle</span>
          <span class="desc">{sidebarShown ? "shown — click to hide" : "hidden — click to show"}</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconChevronDown />
        </div>
        <div class="scale">
          <IconChevronDown size={16} />
        </div>
        <div class="label">
          <span class="slug">chevron-down <span class="angle">40°</span></span>
          <span class="desc">Disclosure indicator</span>
        </div>
      </div>

      <div class="cell">
        <div class="display brass">
          <IconDotUnsaved />
        </div>
        <div class="scale brass">
          <IconDotUnsaved size={16} />
        </div>
        <div class="label">
          <span class="slug">dot-unsaved <span class="angle">brass</span></span>
          <span class="desc">Save indicator</span>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <span class="section-mark">§ Row II</span>
      <h2>Universal Utility</h2>
      <span class="section-rule"></span>
    </div>
    <div class="grid">
      <div class="cell">
        <div class="display">
          <IconSearch />
        </div>
        <div class="scale">
          <IconSearch size={16} />
        </div>
        <div class="label">
          <span class="slug">search <span class="angle">45°</span></span>
          <span class="desc">Lens and handle</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconPlus />
        </div>
        <div class="scale">
          <IconPlus size={16} />
        </div>
        <div class="label">
          <span class="slug">plus</span>
          <span class="desc">New file, add anything</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconX />
        </div>
        <div class="scale">
          <IconX size={16} />
        </div>
        <div class="label">
          <span class="slug">x <span class="angle">45°</span></span>
          <span class="desc">Dismiss, close, clear</span>
        </div>
      </div>

      <div class="cell">
        <div class="display">
          <IconCheck />
        </div>
        <div class="scale">
          <IconCheck size={16} />
        </div>
        <div class="label">
          <span class="slug">check <span class="angle">~ 40°</span></span>
          <span class="desc">Confirmation, saved</span>
        </div>
      </div>
    </div>
  </section>

  <footer class="footer">
    <span class="meta">— END OF GALLERY —</span>
    <span class="meta">SKRIVE · ICONS · V0.1</span>
  </footer>
</div>

<style>
  .gallery {
    /* Warm palette, scoped to this route until we commit to it app-wide. */
    --cream: #f4efe6;
    --espresso: #1c1916;
    --muted: #6b6660;
    --subtle: #a8a29a;
    --rule: rgba(28, 25, 22, 0.12);
    --cell-bg: rgba(28, 25, 22, 0.012);
    --brass: #8b6a3d;

    background: var(--cream);
    color: var(--espresso);
    min-height: 100vh;
    padding: 88px 96px 96px;
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      "Inter",
      system-ui,
      sans-serif;
  }

  .header {
    padding-bottom: 44px;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 64px;
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 28px;
  }

  .meta {
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .meta-accent {
    color: var(--brass);
    letter-spacing: 0.14em;
    font-weight: 500;
  }

  h1 {
    font-family: "Palatino", "Palatino Linotype", Georgia, serif;
    font-weight: 400;
    font-size: 96px;
    line-height: 88px;
    letter-spacing: -0.02em;
    margin: 0 0 20px;
    color: var(--espresso);
  }

  .header p {
    font-family: "Palatino", "Palatino Linotype", Georgia, serif;
    font-style: italic;
    font-size: 18px;
    line-height: 26px;
    color: var(--muted);
    margin: 0;
    max-width: 560px;
  }

  .section {
    margin-bottom: 72px;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    gap: 24px;
    margin-bottom: 28px;
  }

  .section-mark {
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    font-weight: 500;
    color: var(--brass);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .section-head h2 {
    font-family: "Palatino", "Palatino Linotype", Georgia, serif;
    font-weight: 400;
    font-size: 28px;
    line-height: 32px;
    margin: 0;
    color: var(--espresso);
  }

  .section-rule {
    flex: 1;
    height: 1px;
    background: var(--rule);
  }

  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    border-top: 1px solid var(--rule);
    border-left: 1px solid var(--rule);
  }

  .cell {
    flex: 0 0 calc(33.333% + 0.5px);
    box-sizing: border-box;
    padding: 36px 28px;
    border-right: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }

  .display {
    width: 176px;
    height: 176px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--cell-bg);
    border: 1px solid var(--rule);
    color: var(--espresso);
  }

  .display :global(svg) {
    width: 112px;
    height: 112px;
  }

  .display.brass {
    color: var(--brass);
  }

  .interactive {
    background: var(--cell-bg);
    cursor: pointer;
    padding: 0;
    font: inherit;
    transition: background 120ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .interactive:hover {
    background: rgba(28, 25, 22, 0.04);
  }

  .interactive:focus-visible {
    outline: 2px solid var(--brass);
    outline-offset: 2px;
  }

  .scale {
    color: var(--espresso);
    display: flex;
    align-items: center;
    justify-content: center;
    height: 16px;
  }

  .scale.brass {
    color: var(--brass);
  }

  .label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    text-align: center;
  }

  .slug {
    font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 500;
    color: var(--espresso);
  }

  .angle {
    font-size: 10px;
    color: var(--brass);
    letter-spacing: 0.08em;
    margin-left: 6px;
  }

  .desc {
    font-family: "Palatino", "Palatino Linotype", Georgia, serif;
    font-style: italic;
    font-size: 13px;
    color: var(--muted);
  }

  .footer {
    display: flex;
    justify-content: space-between;
    padding-top: 40px;
    border-top: 1px solid var(--rule);
  }

  .footer .meta {
    color: var(--subtle);
  }

  @media (max-width: 1100px) {
    .cell {
      flex-basis: calc(50% + 0.5px);
    }
  }

  @media (max-width: 720px) {
    .gallery {
      padding: 48px 24px;
    }
    h1 {
      font-size: 56px;
      line-height: 56px;
    }
    .cell {
      flex-basis: 100%;
    }
  }
</style>
