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
    <circle cx="8" cy="10" r="2.5" />
    <path d="M8 10 L8 8.25" stroke-width="0.875" />
    <path d="M8 10 L9.5 10" stroke-width="0.875" />
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
    <circle cx="12" cy="15" r="4" />
    <path d="M12 15 L12 12.5" stroke-width="1.25" />
    <path d="M12 15 L14.5 15" stroke-width="1.25" />
  </svg>
{/if}
