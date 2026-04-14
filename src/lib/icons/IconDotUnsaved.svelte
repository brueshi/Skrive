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
    fill="currentColor"
    class={className}
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="2.25" />
  </svg>
{:else}
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    class={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3" />
  </svg>
{/if}
