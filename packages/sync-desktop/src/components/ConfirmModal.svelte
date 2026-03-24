<script lang="ts">
  import Modal from "./Modal.svelte";
  import { AlertCircle, Loader2 } from "lucide-svelte";

  interface Props {
    title: string;
    message: string;
    confirmLabel?: string;
    onconfirm: () => void | Promise<void>;
    oncancel: () => void;
  }

  let { title, message, confirmLabel = "Delete", onconfirm, oncancel }: Props = $props();

  let loading = $state(false);
  let error: string | null = $state(null);

  async function handleConfirm(): Promise<void> {
    loading = true;
    error = null;
    try {
      await onconfirm();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Operation failed";
      loading = false;
    }
  }
</script>

<Modal title={title} onclose={oncancel}>
  <div class="space-y-4">
    <p class="text-sm text-text-secondary">{message}</p>

    {#if error}
      <div class="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
        <AlertCircle class="h-4 w-4 shrink-0 text-error" />
        <p class="text-sm text-error">{error}</p>
      </div>
    {/if}

    <div class="flex justify-end gap-3">
      <button
        class="rounded-md border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary"
        onclick={oncancel}
        disabled={loading}
      >
        Cancel
      </button>
      <button
        class="flex items-center gap-2 rounded-md bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-error/80 disabled:opacity-50"
        onclick={handleConfirm}
        disabled={loading}
      >
        {#if loading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {/if}
        {confirmLabel}
      </button>
    </div>
  </div>
</Modal>
