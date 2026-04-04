<script lang="ts">
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
  }

  let { title, onclose, children }: Props = $props();

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onclose();
  }

  function handleBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
  role="presentation"
  onclick={handleBackdrop}
>
  <div
    class="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card shadow-2xl"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-4">
      <h2 class="text-sm font-semibold text-text-primary">{title}</h2>
      <button
        class="rounded-md p-1 text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary"
        onclick={onclose}
      >
        <X class="h-4 w-4" />
      </button>
    </div>
    <div class="p-5">
      {@render children()}
    </div>
  </div>
</div>
