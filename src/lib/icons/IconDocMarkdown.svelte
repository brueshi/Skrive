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
    <path d="M7 9 L7 12.5" stroke-width="0.875" />
    <path d="M9 9 L9 12.5" stroke-width="0.875" />
    <path d="M5.75 9.75 L10.25 9.75" stroke-width="0.875" />
    <path d="M5.75 11.5 L10.25 11.5" stroke-width="0.875" />
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
    <path d="M10.5 13.5 L10.5 18.75" stroke-width="1.25" />
    <path d="M13.5 13.5 L13.5 18.75" stroke-width="1.25" />
    <path d="M8.625 14.625 L15.375 14.625" stroke-width="1.25" />
    <path d="M8.625 17.25 L15.375 17.25" stroke-width="1.25" />
  </svg>
{/if}
