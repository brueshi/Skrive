<script lang="ts">
  interface Props {
    size?: 16 | 24;
    class?: string;
  }
  let { size = 24, class: className = "" }: Props = $props();
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
    <path d="M2 5 L8 4 L14 5 L14 13 L8 14 L2 13 Z" />
    <path d="M8 4 L8 14" />
    <path d="M3.75 8 L6.5 8" stroke-width="0.875" />
    <path d="M3.75 10.25 L6 10.25" stroke-width="0.875" />
    <path d="M9.5 8 L12.25 8" stroke-width="0.875" />
    <path d="M9.5 10.25 L12 10.25" stroke-width="0.875" />
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
    <path d="M3 7 L12 5 L21 7 L21 19 L12 21 L3 19 Z" />
    <path d="M12 5 L12 21" />
    <circle cx="5.75" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
    <path d="M7 10.5 L10 10.5" stroke-width="1.25" />
    <circle cx="5.75" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    <path d="M7 13.5 L10 13.5" stroke-width="1.25" />
    <circle cx="14" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
    <path d="M15.25 10.5 L18.5 10.5" stroke-width="1.25" />
    <circle cx="14" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    <path d="M15.25 13.5 L18.5 13.5" stroke-width="1.25" />
  </svg>
{/if}
