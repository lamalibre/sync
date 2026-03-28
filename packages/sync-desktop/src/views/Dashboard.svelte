<script lang="ts">
  import {
    getStatus,
    getProjects,
    getProjects_includeDeleted,
    restoreProject,
  } from "../lib/api.js";
  import type { GlobalStatus, Project } from "../lib/types.js";
  import { formatRelativeTime, formatBytes } from "../lib/format.js";
  import ProjectFormModal from "../components/ProjectFormModal.svelte";
  import {
    RefreshCw,
    FolderSync,
    Cloud,
    AlertCircle,
    Archive,
    CheckCircle2,
    Loader2,
    Plus,
    Undo2,
    Trash2,
  } from "lucide-svelte";

  interface Props {
    onSelectProject: (projectId: string) => void;
  }

  let { onSelectProject }: Props = $props();

  let status: GlobalStatus | null = $state(null);
  let projects: Project[] = $state([]);
  let deletedProjects: Project[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let showCreateModal = $state(false);
  let showDeleted = $state(false);
  let restoreInProgress: string | null = $state(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [statusRes, projectsRes, allProjectsRes] = await Promise.all([
        getStatus(),
        getProjects(),
        getProjects_includeDeleted(),
      ]);
      status = statusRes;
      projects = projectsRes.projects;
      deletedProjects = allProjectsRes.projects.filter(
        (p) => p.deletedAt !== null,
      );
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to connect to server";
    } finally {
      loading = false;
    }
  }

  async function handleRestoreProject(projectId: string): Promise<void> {
    restoreInProgress = projectId;
    try {
      await restoreProject(projectId);
      await refresh();
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to restore project";
    } finally {
      restoreInProgress = null;
    }
  }

  // Adaptive polling: 5s when syncing, 30s otherwise
  let hasSyncing = $derived(projects.some((p) => p.status === "syncing"));

  $effect(() => {
    void refresh();
    const interval = setInterval(
      () => { void refresh(); },
      hasSyncing ? 5_000 : 30_000,
    );
    return () => clearInterval(interval);
  });

  function handleProjectCreated(project: Project): void {
    showCreateModal = false;
    onSelectProject(project.id);
  }

  function statusBadgeClass(s: string): string {
    switch (s) {
      case "synced":
        return "bg-success/15 text-success";
      case "syncing":
        return "bg-accent/15 text-accent";
      case "error":
        return "bg-error/15 text-error";
      case "archived":
        return "bg-warning/15 text-warning";
      default:
        return "bg-text-secondary/15 text-text-secondary";
    }
  }

</script>

<div class="p-6">
  <div class="mb-6 flex items-center justify-between">
    <h1 class="text-lg font-semibold text-text-primary">Dashboard</h1>
    <div class="flex items-center gap-2">
      <button
        class="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface transition-colors hover:bg-accent-dim"
        onclick={() => (showCreateModal = true)}
      >
        <Plus class="h-3.5 w-3.5" />
        New Project
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

  {#if error}
    <div
      class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
    >
      <AlertCircle class="h-5 w-5 shrink-0 text-error" />
      <div>
        <p class="text-sm font-medium text-error">Connection Error</p>
        <p class="text-xs text-error/70">{error}</p>
      </div>
    </div>
  {/if}

  <!-- Status cards -->
  {#if status}
    <div class="mb-8 grid grid-cols-4 gap-4">
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Projects</p>
        <p class="mt-1 text-2xl font-bold text-text-primary">
          {status.projects}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Active Ops</p>
        <p class="mt-1 text-2xl font-bold text-accent">
          {status.activeOperations}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Archived</p>
        <p class="mt-1 text-2xl font-bold text-warning">
          {formatBytes(status.totalArchived)}
        </p>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs text-text-secondary">Space Saved</p>
        <p class="mt-1 text-2xl font-bold text-success">
          {formatBytes(status.savedLocally)}
        </p>
      </div>
    </div>
  {/if}

  <!-- Project list -->
  <h2 class="mb-3 text-sm font-medium text-text-secondary">Projects</h2>

  {#if loading && projects.length === 0}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
    </div>
  {:else if projects.length === 0}
    <div
      class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12"
    >
      <FolderSync class="mb-3 h-10 w-10 text-text-secondary" />
      <p class="text-sm text-text-secondary">No projects yet</p>
      <button
        class="mt-3 flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim"
        onclick={() => (showCreateModal = true)}
      >
        <Plus class="h-4 w-4" />
        Create your first project
      </button>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
      {#each projects as project}
        <button
          class="flex flex-col rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-accent/40 hover:bg-card-hover"
          onclick={() => onSelectProject(project.id)}
        >
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-medium text-text-primary">
              {project.name}
            </h3>
            <span
              class="rounded-full px-2 py-0.5 text-xs font-medium {statusBadgeClass(project.status)}"
            >
              {project.status}
            </span>
          </div>

          <p class="mb-3 truncate text-xs text-text-secondary">
            {project.remotePath}
          </p>

          <div class="mt-auto flex items-center gap-4 text-xs text-text-secondary">
            <span class="flex items-center gap-1">
              {#if project.status === "syncing"}
                <Loader2 class="h-3 w-3 animate-spin text-accent" />
              {:else if project.status === "synced"}
                <CheckCircle2 class="h-3 w-3 text-success" />
              {:else if project.status === "archived"}
                <Archive class="h-3 w-3 text-warning" />
              {:else if project.status === "error"}
                <AlertCircle class="h-3 w-3 text-error" />
              {:else}
                <Cloud class="h-3 w-3" />
              {/if}
              {project.direction}
            </span>
            <span>Last sync: {formatRelativeTime(project.lastSync)}</span>
          </div>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Deleted projects -->
  {#if deletedProjects.length > 0}
    <div class="mt-8">
      <button
        class="mb-3 flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        onclick={() => (showDeleted = !showDeleted)}
      >
        <Trash2 class="h-4 w-4" />
        Deleted Projects ({deletedProjects.length})
        <span class="text-xs">
          {showDeleted ? "Hide" : "Show"}
        </span>
      </button>

      {#if showDeleted}
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {#each deletedProjects as project}
            <div
              class="flex flex-col rounded-lg border border-border bg-card p-4 opacity-60"
            >
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-sm font-medium text-text-primary">
                  {project.name}
                </h3>
                <span
                  class="rounded-full bg-error/15 px-2 py-0.5 text-xs font-medium text-error"
                >
                  deleted
                </span>
              </div>

              <p class="mb-3 truncate text-xs text-text-secondary">
                {project.remotePath}
              </p>

              <div class="mt-auto flex items-center justify-between">
                <span class="text-xs text-text-secondary">
                  Deleted: {formatRelativeTime(project.deletedAt)}
                </span>
                <button
                  class="flex items-center gap-1.5 rounded-md border border-success/40 px-2.5 py-1 text-xs font-medium text-success transition-colors hover:bg-success/10 disabled:opacity-50"
                  onclick={() => handleRestoreProject(project.id)}
                  disabled={restoreInProgress === project.id}
                >
                  {#if restoreInProgress === project.id}
                    <Loader2 class="h-3 w-3 animate-spin" />
                  {:else}
                    <Undo2 class="h-3 w-3" />
                  {/if}
                  Restore
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if showCreateModal}
  <ProjectFormModal
    onsave={handleProjectCreated}
    oncancel={() => (showCreateModal = false)}
  />
{/if}
