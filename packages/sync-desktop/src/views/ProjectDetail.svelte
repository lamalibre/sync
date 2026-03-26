<script lang="ts">
  import {
    getProject,
    getProjectStatus,
    getHistory,
    triggerSync,
    triggerArchive,
    triggerRestore,
    deleteProject,
  } from "../lib/api.js";
  import type {
    Project,
    ProjectStatusResponse,
    SyncOperation,
  } from "../lib/types.js";
  import ProjectFormModal from "../components/ProjectFormModal.svelte";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import {
    RefreshCw,
    Play,
    Archive,
    ArchiveRestore,
    AlertCircle,
    Loader2,
    Clock,
    CheckCircle2,
    XCircle,
    Pencil,
    Trash2,
  } from "lucide-svelte";

  interface Props {
    projectId: string;
    onNavigateBack: () => void;
  }

  let { projectId, onNavigateBack }: Props = $props();

  let project: Project | null = $state(null);
  let projectStatus: ProjectStatusResponse | null = $state(null);
  let history: SyncOperation[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let actionError: string | null = $state(null);
  let actionInProgress = $state(false);
  let showEditModal = $state(false);
  let showDeleteConfirm = $state(false);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [projectRes, statusRes, historyRes] = await Promise.all([
        getProject(projectId),
        getProjectStatus(projectId),
        getHistory(projectId, 20),
      ]);
      project = projectRes.project;
      projectStatus = statusRes;
      history = historyRes.operations;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load project";
    } finally {
      loading = false;
    }
  }

  async function handleSync(): Promise<void> {
    actionInProgress = true;
    actionError = null;
    try {
      await triggerSync(projectId);
      await refresh();
    } catch (err: unknown) {
      actionError = err instanceof Error ? err.message : "Sync failed";
    } finally {
      actionInProgress = false;
    }
  }

  async function handleArchive(): Promise<void> {
    actionInProgress = true;
    actionError = null;
    try {
      await triggerArchive(projectId);
      await refresh();
    } catch (err: unknown) {
      actionError = err instanceof Error ? err.message : "Archive failed";
    } finally {
      actionInProgress = false;
    }
  }

  async function handleRestore(): Promise<void> {
    actionInProgress = true;
    actionError = null;
    try {
      await triggerRestore(projectId);
      await refresh();
    } catch (err: unknown) {
      actionError = err instanceof Error ? err.message : "Restore failed";
    } finally {
      actionInProgress = false;
    }
  }

  async function handleDelete(): Promise<void> {
    actionInProgress = true;
    actionError = null;
    try {
      await deleteProject(projectId);
      onNavigateBack();
    } catch (err: unknown) {
      actionError = err instanceof Error ? err.message : "Delete failed";
    } finally {
      actionInProgress = false;
    }
  }

  function handleProjectUpdated(updated: Project): void {
    project = updated;
    showEditModal = false;
  }

  // Adaptive polling: 5s when active operation, 30s otherwise
  let hasActiveOp = $derived.by(() => {
    const ps = projectStatus;
    return ps !== null && ps.activeOperation !== null;
  });

  $effect(() => {
    // Re-run when projectId changes
    void projectId;
    refresh();
    const interval = setInterval(
      () => { refresh(); },
      hasActiveOp ? 5_000 : 30_000,
    );
    return () => clearInterval(interval);
  });

  function formatDate(iso: string | null): string {
    if (!iso) return "-";
    return new Date(iso).toLocaleString();
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return "-";
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  function operationStatusIcon(
    status: string,
  ): typeof CheckCircle2 | typeof Loader2 | typeof XCircle | typeof Clock {
    switch (status) {
      case "completed":
        return CheckCircle2;
      case "running":
        return Loader2;
      case "error":
        return XCircle;
      default:
        return Clock;
    }
  }

  function operationStatusColor(status: string): string {
    switch (status) {
      case "completed":
        return "text-success";
      case "running":
        return "text-accent";
      case "error":
        return "text-error";
      default:
        return "text-text-secondary";
    }
  }
</script>

{#if loading && !project}
  <div class="flex items-center justify-center py-12">
    <Loader2 class="h-6 w-6 animate-spin text-accent" />
  </div>
{:else if error}
  <div
    class="flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
  >
    <AlertCircle class="h-5 w-5 shrink-0 text-error" />
    <p class="text-sm text-error">{error}</p>
  </div>
{:else if project}
  <!-- Header -->
  <div class="mb-6 flex items-start justify-between">
    <div>
      <h1 class="text-lg font-semibold text-text-primary">{project.name}</h1>
      <p class="mt-1 text-xs text-text-secondary">{project.remotePath}</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        class="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-accent"
        onclick={() => (showEditModal = true)}
      >
        <Pencil class="h-3.5 w-3.5" />
        Edit
      </button>
      <button
        class="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-error"
        onclick={() => (showDeleteConfirm = true)}
      >
        <Trash2 class="h-3.5 w-3.5" />
        Delete
      </button>
      <button
        class="flex items-center gap-2 rounded-md bg-card px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-accent"
        onclick={refresh}
        disabled={loading}
      >
        <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
        Refresh
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

  <!-- Project info + actions -->
  <div class="mb-6 grid grid-cols-2 gap-4">
    <!-- Info card -->
    <div class="rounded-lg border border-border bg-card p-4">
      <h2 class="mb-3 text-sm font-medium text-text-secondary">Details</h2>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between">
          <dt class="text-text-secondary">Status</dt>
          <dd class="font-medium text-text-primary">
            {projectStatus?.status ?? project.status}
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-secondary">Direction</dt>
          <dd class="text-text-primary">{project.direction}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-secondary">Trigger</dt>
          <dd class="text-text-primary">{project.trigger}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-secondary">Conflict strategy</dt>
          <dd class="text-text-primary">{project.conflictStrategy}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-secondary">Encrypted</dt>
          <dd class="text-text-primary">{project.encrypted ? "Yes" : "No"}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-text-secondary">Last sync</dt>
          <dd class="text-text-primary">{formatDate(project.lastSync)}</dd>
        </div>
      </dl>
    </div>

    <!-- Actions card -->
    <div class="rounded-lg border border-border bg-card p-4">
      <h2 class="mb-3 text-sm font-medium text-text-secondary">Actions</h2>

      {#if projectStatus?.activeOperation}
        <div class="mb-4 rounded-md border border-accent/30 bg-accent/10 p-3">
          <div class="flex items-center gap-2">
            <Loader2 class="h-4 w-4 animate-spin text-accent" />
            <span class="text-sm font-medium text-accent">
              {projectStatus.activeOperation.type} in progress
            </span>
          </div>
          {#if projectStatus.activeOperation.filesTotal > 0}
            <div class="mt-2">
              <div class="mb-1 flex justify-between text-xs text-text-secondary">
                <span>
                  {projectStatus.activeOperation.filesTransferred} / {projectStatus.activeOperation.filesTotal} files
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-surface">
                <div
                  class="h-full rounded-full bg-accent transition-all"
                  style="width: {projectStatus.activeOperation.filesTotal > 0
                    ? (projectStatus.activeOperation.filesTransferred /
                        projectStatus.activeOperation.filesTotal) *
                      100
                    : 0}%"
                ></div>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <div class="flex flex-col gap-2">
        <button
          class="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim disabled:opacity-50"
          onclick={handleSync}
          disabled={actionInProgress || !!projectStatus?.activeOperation}
        >
          <Play class="h-4 w-4" />
          Sync Now
        </button>

        <div class="flex gap-2">
          <button
            class="flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-card-hover px-3 py-2 text-sm text-text-primary transition-colors hover:border-warning/40 hover:text-warning disabled:opacity-50"
            onclick={handleArchive}
            disabled={actionInProgress ||
              !!projectStatus?.activeOperation ||
              project.status === "archived"}
          >
            <Archive class="h-3.5 w-3.5" />
            Archive
          </button>
          <button
            class="flex flex-1 items-center justify-center gap-2 rounded-md border border-border bg-card-hover px-3 py-2 text-sm text-text-primary transition-colors hover:border-success/40 hover:text-success disabled:opacity-50"
            onclick={handleRestore}
            disabled={actionInProgress || !!projectStatus?.activeOperation}
          >
            <ArchiveRestore class="h-3.5 w-3.5" />
            Restore
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Sync history -->
  <div class="rounded-lg border border-border bg-card p-4">
    <h2 class="mb-3 text-sm font-medium text-text-secondary">
      Recent Operations
    </h2>

    {#if history.length === 0}
      <p class="py-4 text-center text-sm text-text-secondary">
        No operations recorded yet.
      </p>
    {:else}
      <div class="space-y-2">
        {#each history as op}
          {@const StatusIcon = operationStatusIcon(op.status)}
          <div
            class="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2"
          >
            <div class="flex items-center gap-3">
              <StatusIcon
                class="h-4 w-4 {operationStatusColor(op.status)} {op.status === 'running' ? 'animate-spin' : ''}"
              />
              <div>
                <span class="text-sm text-text-primary">
                  {op.type}
                  <span class="text-text-secondary">({op.trigger})</span>
                </span>
              </div>
            </div>
            <div class="flex items-center gap-4 text-xs text-text-secondary">
              <span>{formatDuration(op.duration)}</span>
              <span>{formatDate(op.startedAt)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if showEditModal && project}
  <ProjectFormModal
    {project}
    onsave={handleProjectUpdated}
    oncancel={() => (showEditModal = false)}
  />
{/if}

{#if showDeleteConfirm && project}
  <ConfirmModal
    title="Delete Project"
    message="Are you sure you want to delete '{project.name}'? This will remove the project configuration but will not delete any files."
    confirmLabel="Delete Project"
    onconfirm={handleDelete}
    oncancel={() => (showDeleteConfirm = false)}
  />
{/if}
