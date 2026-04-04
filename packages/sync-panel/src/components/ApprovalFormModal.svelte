<script lang="ts">
  import Modal from "./Modal.svelte";
  import { getSyncClient } from "../context/client.svelte.js";
  import type {
    Project,
    ApprovedPathEntry,
    AccessMode,
    ConfirmMode,
  } from "../lib/types.js";
  import { AlertCircle, Loader2 } from "lucide-svelte";
  import { untrack } from "svelte";

  interface Props {
    projects: Project[];
    existing?: ApprovedPathEntry;
    onsave: () => void;
    oncancel: () => void;
  }

  let { projects, existing, onsave, oncancel }: Props = $props();

  const client = getSyncClient();

  const initial = untrack(() => existing);
  const isEdit = !!initial;

  let selectedProjectId = $state(initial?.projectId ?? "");
  let localPath = $state(initial?.localPath ?? "");
  let accessMode: AccessMode = $state(initial?.accessMode ?? "full");
  let confirmMode: ConfirmMode = $state(initial?.confirmMode ?? "auto");
  let deleteThreshold = $state(String(initial?.deleteThreshold ?? 10));

  let loading = $state(false);
  let error: string | null = $state(null);

  let selectedProject = $derived(
    projects.find((p) => p.id === selectedProjectId),
  );

  async function handleSubmit(): Promise<void> {
    if (!selectedProjectId || !localPath.trim()) return;

    loading = true;
    error = null;
    try {
      await client.addApproval({
        projectId: selectedProjectId,
        localPath: localPath.trim(),
        projectName: selectedProject?.name ?? selectedProjectId,
        accessMode,
        confirmMode,
        deleteThreshold: parseInt(deleteThreshold, 10) || 10,
      });
      onsave();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to save approval";
      loading = false;
    }
  }
</script>

<Modal title={isEdit ? "Edit Path Approval" : "Approve Path"} onclose={oncancel}>
  <form
    class="space-y-4"
    onsubmit={(e) => {
      e.preventDefault();
      void handleSubmit();
    }}
  >
    {#if error}
      <div
        class="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2"
      >
        <AlertCircle class="h-4 w-4 shrink-0 text-error" />
        <p class="text-sm text-error">{error}</p>
      </div>
    {/if}

    <!-- Project selector -->
    <div>
      <label for="af-project" class="mb-1 block text-xs text-text-secondary"
        >Project</label
      >
      <select
        id="af-project"
        bind:value={selectedProjectId}
        disabled={isEdit}
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
      >
        <option value="">Select a project...</option>
        {#each projects as project}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    </div>

    <!-- Local path -->
    <div>
      <label for="af-path" class="mb-1 block text-xs text-text-secondary"
        >Local Path</label
      >
      <input
        id="af-path"
        type="text"
        bind:value={localPath}
        required
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none"
        placeholder="/Users/you/projects/my-project"
      />
      <p class="mt-1 text-xs text-text-secondary">
        Absolute path to the local directory for this project.
      </p>
    </div>

    <!-- Access mode + Confirm mode row -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="af-access" class="mb-1 block text-xs text-text-secondary"
          >Access Mode</label
        >
        <select
          id="af-access"
          bind:value={accessMode}
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="full">Full</option>
          <option value="push-only">Push Only</option>
          <option value="pull-only">Pull Only</option>
          <option value="protected">Protected</option>
        </select>
      </div>
      <div>
        <label for="af-confirm" class="mb-1 block text-xs text-text-secondary"
          >Confirm Mode</label
        >
        <select
          id="af-confirm"
          bind:value={confirmMode}
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="auto">Auto</option>
          <option value="confirm-destructive">Confirm Destructive</option>
          <option value="confirm-always">Confirm Always</option>
        </select>
      </div>
    </div>

    <!-- Delete threshold -->
    <div>
      <label for="af-threshold" class="mb-1 block text-xs text-text-secondary"
        >Delete Threshold</label
      >
      <input
        id="af-threshold"
        type="number"
        bind:value={deleteThreshold}
        min="1"
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
      />
      <p class="mt-1 text-xs text-text-secondary">
        Require confirmation if more than this many files would be deleted.
      </p>
    </div>

    <!-- Actions -->
    <div class="flex justify-end gap-3 pt-2">
      <button
        type="button"
        class="rounded-md border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary"
        onclick={oncancel}
        disabled={loading}
      >
        Cancel
      </button>
      <button
        type="submit"
        class="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim disabled:opacity-50"
        disabled={loading || !selectedProjectId || !localPath.trim()}
      >
        {#if loading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {/if}
        {isEdit ? "Save Changes" : "Approve Path"}
      </button>
    </div>
  </form>
</Modal>
