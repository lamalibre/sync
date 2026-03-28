<script lang="ts">
  import {
    getPreviews,
    getPreview,
    approvePreview,
    rejectPreview,
  } from "../lib/api.js";
  import type { PendingSyncPreview } from "../lib/types.js";
  import { formatRelativeTime } from "../lib/format.js";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import {
    RefreshCw,
    AlertCircle,
    Loader2,
    Eye,
    Check,
    X,
    ArrowLeft,
    FilePlus,
    FileX,
    Clock,
  } from "lucide-svelte";

  let previews: PendingSyncPreview[] = $state([]);
  let selectedPreview: PendingSyncPreview | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionError: string | null = $state(null);
  let actionInProgress = $state(false);
  let approveTarget: PendingSyncPreview | null = $state(null);
  let rejectTarget: PendingSyncPreview | null = $state(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await getPreviews();
      previews = res.previews;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load previews";
    } finally {
      loading = false;
    }
  }

  async function loadDetail(projectId: string): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await getPreview(projectId);
      selectedPreview = res.preview;
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to load preview detail";
    } finally {
      loading = false;
    }
  }

  async function handleApprove(): Promise<void> {
    if (!approveTarget) return;
    actionInProgress = true;
    actionError = null;
    try {
      await approvePreview(approveTarget.projectId);
      approveTarget = null;
      selectedPreview = null;
      await refresh();
    } catch (err: unknown) {
      actionError =
        err instanceof Error ? err.message : "Failed to approve preview";
    } finally {
      actionInProgress = false;
    }
  }

  async function handleReject(): Promise<void> {
    if (!rejectTarget) return;
    actionInProgress = true;
    actionError = null;
    try {
      await rejectPreview(rejectTarget.projectId);
      rejectTarget = null;
      selectedPreview = null;
      await refresh();
    } catch (err: unknown) {
      actionError =
        err instanceof Error ? err.message : "Failed to reject preview";
    } finally {
      actionInProgress = false;
    }
  }

  // Auto-refresh every 10 seconds
  $effect(() => {
    void refresh();
    const interval = setInterval(
      () => {
        void refresh();
      },
      10_000,
    );
    return () => clearInterval(interval);
  });

  function formatTimeRemaining(expiresAt: string): string {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes}m remaining`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  }
</script>

<div class="p-6">
  {#if selectedPreview}
    <!-- Detail view -->
    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <button
          class="flex items-center gap-1 text-sm text-text-secondary transition-colors hover:text-accent"
          onclick={() => (selectedPreview = null)}
        >
          <ArrowLeft class="h-4 w-4" />
          Back
        </button>
        <h1 class="text-lg font-semibold text-text-primary">
          {selectedPreview.projectName}
        </h1>
        <span
          class="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
        >
          {selectedPreview.direction}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-2 rounded-md bg-success px-3 py-1.5 text-sm font-medium text-surface transition-colors hover:bg-success/80 disabled:opacity-50"
          onclick={() => (approveTarget = selectedPreview)}
          disabled={actionInProgress}
        >
          <Check class="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          class="flex items-center gap-2 rounded-md bg-error px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-error/80 disabled:opacity-50"
          onclick={() => (rejectTarget = selectedPreview)}
          disabled={actionInProgress}
        >
          <X class="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>

    {#if actionError}
      <div
        class="mb-4 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
      >
        <AlertCircle class="h-5 w-5 shrink-0 text-error" />
        <p class="text-sm text-error">{actionError}</p>
      </div>
    {/if}

    <!-- Summary -->
    <div class="mb-6 grid grid-cols-4 gap-4">
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">To Copy</p>
        <p class="mt-1 text-2xl font-bold text-success">
          {selectedPreview.copyCount}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">To Delete</p>
        <p class="mt-1 text-2xl font-bold text-error">
          {selectedPreview.deleteCount}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Created</p>
        <p class="mt-1 text-sm font-medium text-text-primary">
          {formatRelativeTime(selectedPreview.createdAt)}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Expires</p>
        <p class="mt-1 text-sm font-medium text-warning">
          {formatTimeRemaining(selectedPreview.expiresAt)}
        </p>
      </div>
    </div>

    <!-- Changes list -->
    <div class="rounded-lg border border-border bg-card p-4">
      <h2 class="mb-3 text-sm font-medium text-text-secondary">
        Changes ({selectedPreview.changes.length})
      </h2>

      {#if selectedPreview.changes.length === 0}
        <p class="py-4 text-center text-sm text-text-secondary">
          No file changes in this preview.
        </p>
      {:else}
        <div class="max-h-96 space-y-1 overflow-y-auto">
          {#each selectedPreview.changes as change}
            <div
              class="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-xs"
            >
              {#if change.action === "copy"}
                <FilePlus class="h-3.5 w-3.5 shrink-0 text-success" />
                <span class="text-success">+</span>
              {:else}
                <FileX class="h-3.5 w-3.5 shrink-0 text-error" />
                <span class="text-error">-</span>
              {/if}
              <span class="truncate text-text-primary">{change.path}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <!-- List view -->
    <div class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-lg font-semibold text-text-primary">
          Sync Previews
        </h1>
        <p class="mt-1 text-sm text-text-secondary">
          Pending dry-run results awaiting approval.
        </p>
      </div>
      <button
        class="flex items-center gap-2 rounded-md bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-accent"
        onclick={refresh}
        disabled={loading}
      >
        <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
        Refresh
      </button>
    </div>

    {#if error}
      <div
        class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
      >
        <AlertCircle class="h-5 w-5 shrink-0 text-error" />
        <p class="text-sm text-error">{error}</p>
      </div>
    {/if}

    {#if loading && previews.length === 0}
      <div class="flex items-center justify-center py-12">
        <Loader2 class="h-6 w-6 animate-spin text-accent" />
      </div>
    {:else if previews.length === 0}
      <div
        class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12"
      >
        <Eye class="mb-3 h-10 w-10 text-text-secondary" />
        <p class="text-sm text-text-secondary">No pending sync previews</p>
        <p class="mt-1 text-xs text-text-secondary">
          Previews appear when a sync requires confirmation before executing.
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each previews as preview}
          <div
            role="button"
            tabindex="0"
            class="flex w-full cursor-pointer items-center justify-between rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-accent/40 hover:bg-card-hover"
            onclick={() => loadDetail(preview.projectId)}
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                loadDetail(preview.projectId);
              }
            }}
          >
            <div class="flex items-center gap-4">
              <Eye class="h-5 w-5 shrink-0 text-accent" />
              <div>
                <h3 class="text-sm font-medium text-text-primary">
                  {preview.projectName}
                </h3>
                <div class="mt-1 flex items-center gap-3 text-xs text-text-secondary">
                  <span>{preview.direction}</span>
                  <span class="text-success">+{preview.copyCount} copy</span>
                  <span class="text-error">-{preview.deleteCount} delete</span>
                  <span
                    class="flex items-center gap-1"
                  >
                    <Clock class="h-3 w-3" />
                    {formatRelativeTime(preview.createdAt)}
                  </span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <span class="text-xs text-warning">
                {formatTimeRemaining(preview.expiresAt)}
              </span>
              <button
                class="rounded-md bg-success/15 p-1.5 text-success transition-colors hover:bg-success/25"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  approveTarget = preview;
                }}
                title="Approve"
              >
                <Check class="h-3.5 w-3.5" />
              </button>
              <button
                class="rounded-md bg-error/15 p-1.5 text-error transition-colors hover:bg-error/25"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation();
                  rejectTarget = preview;
                }}
                title="Reject"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if approveTarget}
  <ConfirmModal
    title="Approve Sync"
    message="Are you sure you want to approve and execute this sync for '{approveTarget.projectName}'? This will transfer {approveTarget.copyCount} file(s) and delete {approveTarget.deleteCount} file(s)."
    confirmLabel="Approve & Execute"
    onconfirm={handleApprove}
    oncancel={() => (approveTarget = null)}
  />
{/if}

{#if rejectTarget}
  <ConfirmModal
    title="Reject Sync"
    message="Are you sure you want to reject this sync preview for '{rejectTarget.projectName}'? The preview will be discarded."
    confirmLabel="Reject"
    onconfirm={handleReject}
    oncancel={() => (rejectTarget = null)}
  />
{/if}
