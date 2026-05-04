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
    <path d="M3.5 2 L9 2 L13 6 L13 14 L3.5 14 Z" />
    <path d="M9 2 L9 6 L13 6" />
    <path d="M5.5 7.5 L11 7.5 L11 9 L5.5 9 Z" fill="currentColor" stroke="none" />
    <path d="M5.5 10.75 L10.5 10.75" stroke-width="0.875" />
    <path d="M5.5 12.25 L9 12.25" stroke-width="0.875" />
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
    <path d="M5 3 L13 3 L19 8 L19 21 L5 21 Z" />
    <path d="M13 3 L13 8 L19 8" />
    <path d="M8 10.75 L16 10.75 L16 13.25 L8 13.25 Z" fill="currentColor" stroke="none" />
    <path d="M8 16 L16 16" stroke-width="1.25" />
    <path d="M8 18.5 L13.5 18.5" stroke-width="1.25" />
  </svg>
{/if}
