<script lang="ts">
  interface Props {
    size?: 16 | 24;
    open?: boolean;
    class?: string;
  }
  let { size = 24, open = false, class: className = "" }: Props = $props();

  // Pocket lines normalized to 3 points so CSS `d` transition interpolates smoothly.
  let path16 = $derived(open ? "M 2 8 L 8 8 L 14 5.5" : "M 2 7.5 L 8 7.5 L 14 7.5");
  let path24 = $derived(open ? "M 3 12 L 16 12 L 21 8" : "M 3 11 L 16 11 L 21 11");
</script>

{#if size === 16}
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={className}
    aria-hidden="true"
  >
    <path d="M2 3.5 L7 3.5 L8.75 5.5 L14 5.5 L14 13.5 L2 13.5 Z" />
    <path class="pocket-line" d={path16} style:d={`path("${path16}")`} />
  </svg>
{:else}
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={className}
    aria-hidden="true"
  >
    <path d="M3 5 L10 5 L12.5 8 L21 8 L21 20 L3 20 Z" />
    <path class="pocket-line" d={path24} style:d={`path("${path24}")`} />
  </svg>
{/if}

<style>
  .pocket-line {
    transition: d var(--skrive-duration-switch, 180ms)
      var(--skrive-ease-mechanical, cubic-bezier(0.4, 0, 0.2, 1));
  }

  @media (prefers-reduced-motion: reduce) {
    .pocket-line {
      transition: none;
    }
  }
</style>
