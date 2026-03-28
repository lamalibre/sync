<script lang="ts">
  import {
    getProjects,
    getTrash,
    restoreTrash,
    purgeTrash,
  } from "../lib/api.js";
  import type { Project, TrashEntry } from "../lib/types.js";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import {
    RefreshCw,
    AlertCircle,
    Loader2,
    Trash2,
    ArchiveRestore,
    ChevronDown,
  } from "lucide-svelte";

  let projects: Project[] = $state([]);
  let selectedProjectId: string | null = $state(null);
  let trashEntries: TrashEntry[] = $state([]);
  let loading = $state(true);
  let trashLoading = $state(false);
  let error: string | null = $state(null);
  let actionError: string | null = $state(null);
  let actionInProgress = $state(false);
  let showProjectDropdown = $state(false);

  let restoreTarget: TrashEntry | null = $state(null);
  let showPurgeConfirm = $state(false);
  let purgeOlderThanDays = $state("");

  let selectedProject = $derived(
    projects.find((p) => p.id === selectedProjectId) ?? null,
  );

  async function loadProjects(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await getProjects();
      projects = res.projects;
      if (projects.length > 0 && !selectedProjectId) {
        // Safe: length checked above (projects.length > 0)
        selectedProjectId = projects[0]!.id;
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load projects";
    } finally {
      loading = false;
    }
  }

  async function loadTrash(): Promise<void> {
    if (!selectedProjectId) return;
    trashLoading = true;
    actionError = null;
    try {
      const res = await getTrash(selectedProjectId);
      trashEntries = res.entries;
    } catch (err: unknown) {
      actionError = err instanceof Error ? err.message : "Failed to load trash";
    } finally {
      trashLoading = false;
    }
  }

  async function handleRestore(): Promise<void> {
    if (!selectedProjectId || !restoreTarget) return;
    actionInProgress = true;
    actionError = null;
    try {
      await restoreTrash(selectedProjectId, restoreTarget.timestamp);
      restoreTarget = null;
      await loadTrash();
    } catch (err: unknown) {
      actionError =
        err instanceof Error ? err.message : "Failed to restore from trash";
    } finally {
      actionInProgress = false;
    }
  }

  async function handlePurge(): Promise<void> {
    if (!selectedProjectId) return;
    actionInProgress = true;
    actionError = null;
    try {
      let days: number | undefined;
      if (purgeOlderThanDays.trim()) {
        days = parseInt(purgeOlderThanDays.trim(), 10);
        if (isNaN(days)) {
          actionError = "Invalid number of days. Please enter a valid integer.";
          actionInProgress = false;
          return;
        }
      }
      await purgeTrash(selectedProjectId, days);
      showPurgeConfirm = false;
      purgeOlderThanDays = "";
      await loadTrash();
    } catch (err: unknown) {
      actionError =
        err instanceof Error ? err.message : "Failed to purge trash";
    } finally {
      actionInProgress = false;
    }
  }

  function selectProject(projectId: string): void {
    selectedProjectId = projectId;
    showProjectDropdown = false;
  }

  // Load projects on mount, load trash when project changes
  $effect(() => {
    void loadProjects();
  });

  $effect(() => {
    if (selectedProjectId) {
      void loadTrash();
    }
  });

  function formatTimestamp(ts: string): string {
    // Trash timestamps may be in the format 2026-03-25T14-30-00-000Z
    const normalized = ts
      .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
    return new Date(normalized).toLocaleString();
  }
</script>

<div class="p-6">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold text-text-primary">Trash</h1>
      <p class="mt-1 text-sm text-text-secondary">
        Manage deleted files per project.
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if selectedProjectId && trashEntries.length > 0}
        <button
          class="flex items-center gap-2 rounded-md border border-error/40 bg-card px-3 py-1.5 text-sm text-error transition-colors hover:bg-error/10"
          onclick={() => (showPurgeConfirm = true)}
          disabled={actionInProgress}
        >
          <Trash2 class="h-3.5 w-3.5" />
          Purge
        </button>
      {/if}
      <button
        class="flex items-center gap-2 rounded-md bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-accent"
        onclick={() => {
          void loadProjects();
          if (selectedProjectId) void loadTrash();
        }}
        disabled={loading || trashLoading}
      >
        <RefreshCw
          class="h-3.5 w-3.5 {loading || trashLoading ? 'animate-spin' : ''}"
        />
        Refresh
      </button>
    </div>
  </div>

  {#if error}
    <div
      class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
    >
      <AlertCircle class="h-5 w-5 shrink-0 text-error" />
      <p class="text-sm text-error">{error}</p>
    </div>
  {/if}

  {#if loading && projects.length === 0}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
    </div>
  {:else if projects.length === 0}
    <div
      class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12"
    >
      <Trash2 class="mb-3 h-10 w-10 text-text-secondary" />
      <p class="text-sm text-text-secondary">No projects available</p>
    </div>
  {:else}
    <!-- Project selector -->
    <div class="relative mb-6">
      <button
        class="flex w-full max-w-xs items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent/40"
        onclick={() => (showProjectDropdown = !showProjectDropdown)}
      >
        <span>{selectedProject?.name ?? "Select project"}</span>
        <ChevronDown class="h-4 w-4 text-text-secondary" />
      </button>

      {#if showProjectDropdown}
        <div
          class="absolute z-10 mt-1 w-full max-w-xs rounded-md border border-border bg-card shadow-lg"
        >
          {#each projects as project}
            <button
              class="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-card-hover
                {project.id === selectedProjectId
                ? 'text-accent'
                : 'text-text-primary'}"
              onclick={() => selectProject(project.id)}
            >
              {project.name}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if actionError}
      <div
        class="mb-4 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
      >
        <AlertCircle class="h-5 w-5 shrink-0 text-error" />
        <p class="text-sm text-error">{actionError}</p>
      </div>
    {/if}

    <!-- Trash entries -->
    {#if trashLoading}
      <div class="flex items-center justify-center py-12">
        <Loader2 class="h-6 w-6 animate-spin text-accent" />
      </div>
    {:else if trashEntries.length === 0}
      <div
        class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12"
      >
        <Trash2 class="mb-3 h-10 w-10 text-text-secondary" />
        <p class="text-sm text-text-secondary">No trash entries</p>
        <p class="mt-1 text-xs text-text-secondary">
          Deleted files from soft-delete operations will appear here.
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each trashEntries as entry}
          <div
            class="flex items-center justify-between rounded-lg border border-border bg-card p-4"
          >
            <div class="flex items-center gap-3">
              <Trash2 class="h-5 w-5 text-text-secondary" />
              <div>
                <p class="text-sm text-text-primary">
                  {formatTimestamp(entry.timestamp)}
                </p>
                <p class="text-xs text-text-secondary">
                  {entry.fileCount} file{entry.fileCount === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <button
              class="flex items-center gap-2 rounded-md border border-border bg-card-hover px-3 py-1.5 text-sm text-text-primary transition-colors hover:border-success/40 hover:text-success disabled:opacity-50"
              onclick={() => (restoreTarget = entry)}
              disabled={actionInProgress}
            >
              <ArchiveRestore class="h-3.5 w-3.5" />
              Restore
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if restoreTarget}
  <ConfirmModal
    title="Restore from Trash"
    message="Are you sure you want to restore files from the trash point at {formatTimestamp(restoreTarget.timestamp)}? This will copy the deleted files back to their original locations."
    confirmLabel="Restore"
    onconfirm={handleRestore}
    oncancel={() => (restoreTarget = null)}
  />
{/if}

{#if showPurgeConfirm}
  <ConfirmModal
    title="Purge Trash"
    message="This will permanently remove trash entries{purgeOlderThanDays.trim() ? ` older than ${purgeOlderThanDays.trim()} days` : ''}. This cannot be undone."
    confirmLabel="Purge"
    onconfirm={handlePurge}
    oncancel={() => {
      showPurgeConfirm = false;
      purgeOlderThanDays = "";
    }}
  />
{/if}
