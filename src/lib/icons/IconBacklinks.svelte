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
    <path d="M9 3 L12 3 L13.5 4.5 L13.5 13 L9 13 Z" />
    <path d="M12 3 L12 4.5 L13.5 4.5" />
    <path d="M2 6 L7.75 6" />
    <path d="M6.5 4.75 L7.75 6 L6.5 7.25" />
    <path d="M2 10 L7.75 10" />
    <path d="M6.5 8.75 L7.75 10 L6.5 11.25" />
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
    <path d="M14 4 L18 4 L20 6 L20 20 L14 20 Z" />
    <path d="M18 4 L18 6 L20 6" />
    <path d="M3 9 L12 9" />
    <path d="M10 7 L12 9 L10 11" />
    <path d="M3 15 L12 15" />
    <path d="M10 13 L12 15 L10 17" />
  </svg>
{/if}
