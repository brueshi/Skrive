<script lang="ts">
  interface Props {
    size?: 16 | 24;
    shown?: boolean;
    class?: string;
  }
  let { size = 24, shown = true, class: className = "" }: Props = $props();
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
    <rect x="2" y="3" width="12" height="10" />
    <rect
      class="rail-fill"
      class:is-hidden={!shown}
      x="2"
      y="3"
      width="4"
      height="10"
      fill="currentColor"
      stroke="none"
    />
    <line x1="6" y1="3" x2="6" y2="13" />
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
    <rect x="3" y="4" width="18" height="16" />
    <rect
      class="rail-fill"
      class:is-hidden={!shown}
      x="3"
      y="4"
      width="6"
      height="16"
      fill="currentColor"
      stroke="none"
    />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
{/if}

<style>
  .rail-fill {
    transform-box: fill-box;
    transform-origin: left center;
    transition: transform var(--skrive-duration-switch, 120ms)
      var(--skrive-ease-mechanical, cubic-bezier(0.4, 0, 0.2, 1));
  }

  .rail-fill.is-hidden {
    transform: scaleX(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .rail-fill {
      transition: none;
    }
  }
</style>
