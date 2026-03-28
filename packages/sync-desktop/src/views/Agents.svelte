<script lang="ts">
  import {
    getAgents,
    deleteAgent,
    getProjects,
    getApprovals,
    revokeApproval,
  } from "../lib/api.js";
  import type { Agent, Project, ApprovedPathEntry } from "../lib/types.js";
  import { formatRelativeTime, formatBytes } from "../lib/format.js";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import ApprovalFormModal from "../components/ApprovalFormModal.svelte";
  import {
    AlertCircle,
    Loader2,
    RefreshCw,
    Monitor,
    Trash2,
    HardDrive,
    Plus,
    ShieldCheck,
    FolderOpen,
    Pencil,
  } from "lucide-svelte";

  let agents: Agent[] = $state([]);
  let projects: Project[] = $state([]);
  let approvedPaths: ApprovedPathEntry[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let deleteTarget: Agent | null = $state(null);
  let revokeTarget: ApprovedPathEntry | null = $state(null);
  let showApprovalForm = $state(false);
  let editApproval: ApprovedPathEntry | undefined = $state(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [agentsRes, projectsRes, approvalsRes] = await Promise.all([
        getAgents(),
        getProjects(),
        getApprovals(),
      ]);
      agents = agentsRes.agents;
      projects = projectsRes.projects;
      approvedPaths = approvalsRes.entries;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load agents";
    } finally {
      loading = false;
    }
  }

  async function handleDeleteAgent(): Promise<void> {
    if (!deleteTarget) return;
    try {
      await deleteAgent(deleteTarget.id);
      deleteTarget = null;
      await refresh();
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to delete agent";
      deleteTarget = null;
    }
  }

  async function handleRevokeApproval(): Promise<void> {
    if (!revokeTarget) return;
    try {
      await revokeApproval(revokeTarget.projectId);
      revokeTarget = null;
      await refresh();
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to revoke approval";
      revokeTarget = null;
    }
  }

  async function handleApprovalSaved(): Promise<void> {
    showApprovalForm = false;
    editApproval = undefined;
    try {
      await refresh();
    } catch (err: unknown) {
      error =
        err instanceof Error ? err.message : "Failed to refresh after saving approval";
    }
  }

  function openEditApproval(entry: ApprovedPathEntry): void {
    editApproval = entry;
    showApprovalForm = true;
  }

  function openNewApproval(): void {
    editApproval = undefined;
    showApprovalForm = true;
  }

  // 15s auto-polling
  $effect(() => {
    void refresh();
    const interval = setInterval(
      () => {
        void refresh();
      },
      15_000,
    );
    return () => clearInterval(interval);
  });

  function diskUsagePercent(agent: Agent): number {
    if (!agent.diskUsage || agent.diskUsage.totalBytes === 0) return 0;
    return (agent.diskUsage.usedBytes / agent.diskUsage.totalBytes) * 100;
  }

  function accessModeBadgeClass(mode: string): string {
    switch (mode) {
      case "full":
        return "bg-success/15 text-success";
      case "push-only":
        return "bg-accent/15 text-accent";
      case "pull-only":
        return "bg-warning/15 text-warning";
      case "protected":
        return "bg-error/15 text-error";
      default:
        return "bg-text-secondary/15 text-text-secondary";
    }
  }
</script>

<div class="p-6">
  <div class="mb-6 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold text-text-primary">Agents</h1>
      <p class="mt-1 text-sm text-text-secondary">
        Connected sync agents and their status.
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

  {#if loading && agents.length === 0}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
    </div>
  {:else if agents.length === 0}
    <div
      class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12"
    >
      <Monitor class="mb-3 h-10 w-10 text-text-secondary" />
      <p class="text-sm text-text-secondary">No agents registered</p>
      <p class="mt-1 text-xs text-text-secondary">
        Install and start an agent to begin syncing.
      </p>
      <code
        class="mt-3 inline-block rounded-md bg-card px-3 py-1.5 text-xs text-accent"
      >
        npx @lamalibre/create-sync
      </code>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {#each agents as agent}
        <div class="rounded-lg border border-border bg-card p-4">
          <!-- Header -->
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div
                class="h-2.5 w-2.5 rounded-full {agent.status === 'online'
                  ? 'bg-success shadow-[0_0_6px] shadow-success/50'
                  : 'bg-text-secondary'}"
              ></div>
              <div>
                <h3 class="text-sm font-medium text-text-primary">
                  {agent.name}
                </h3>
                <p class="text-xs text-text-secondary">{agent.hostname}</p>
              </div>
            </div>
            <button
              class="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-card-hover hover:text-error"
              onclick={() => (deleteTarget = agent)}
              title="Remove agent"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- Info grid -->
          <dl class="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <div>
              <dt class="text-text-secondary">OS</dt>
              <dd class="text-text-primary">
                {agent.os}{agent.osVersion ? ` ${agent.osVersion}` : ""}
              </dd>
            </div>
            <div>
              <dt class="text-text-secondary">Last heartbeat</dt>
              <dd class="text-text-primary">
                {formatRelativeTime(agent.lastHeartbeat)}
              </dd>
            </div>
            <div>
              <dt class="text-text-secondary">Version</dt>
              <dd class="text-text-primary">{agent.agentVersion ?? "-"}</dd>
            </div>
            <div>
              <dt class="text-text-secondary">Active syncs</dt>
              <dd class="text-text-primary">{agent.activeSyncs.length}</dd>
            </div>
            <div>
              <dt class="text-text-secondary">Projects</dt>
              <dd class="text-text-primary">{agent.projectIds.length}</dd>
            </div>
            <div>
              <dt class="text-text-secondary">Node</dt>
              <dd class="text-text-primary">{agent.nodeVersion}</dd>
            </div>
          </dl>

          <!-- Disk usage -->
          {#if agent.diskUsage}
            <div class="rounded-md border border-border bg-surface p-2.5">
              <div class="mb-1.5 flex items-center justify-between text-xs">
                <span class="flex items-center gap-1 text-text-secondary">
                  <HardDrive class="h-3 w-3" />
                  Disk
                </span>
                <span class="text-text-primary">
                  {formatBytes(agent.diskUsage.usedBytes)} / {formatBytes(agent.diskUsage.totalBytes)}
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-card">
                <div
                  class="h-full rounded-full transition-all {diskUsagePercent(agent) > 90
                    ? 'bg-error'
                    : diskUsagePercent(agent) > 70
                      ? 'bg-warning'
                      : 'bg-accent'}"
                  style="width: {diskUsagePercent(agent)}%"
                ></div>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Path Approvals Section -->
  <div class="mt-8">
    <div class="mb-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <ShieldCheck class="h-5 w-5 text-accent" />
        <h2 class="text-sm font-semibold text-text-primary">
          Path Approvals
        </h2>
        <span class="text-xs text-text-secondary">
          ({approvedPaths.length})
        </span>
      </div>
      <button
        class="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface transition-colors hover:bg-accent-dim"
        onclick={openNewApproval}
      >
        <Plus class="h-3.5 w-3.5" />
        Approve Path
      </button>
    </div>

    {#if approvedPaths.length === 0}
      <div
        class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-8"
      >
        <FolderOpen class="mb-3 h-8 w-8 text-text-secondary" />
        <p class="text-sm text-text-secondary">No path approvals yet</p>
        <p class="mt-1 text-xs text-text-secondary">
          Approve local paths to allow agents to sync projects.
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each approvedPaths as entry}
          <div
            class="rounded-lg border border-border bg-card p-4"
          >
            <div class="flex items-center justify-between">
              <div class="min-w-0 flex-1">
                <div class="mb-1 flex items-center gap-2">
                  <h3 class="text-sm font-medium text-text-primary">
                    {entry.projectName}
                  </h3>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-medium {accessModeBadgeClass(entry.accessMode ?? 'full')}"
                  >
                    {entry.accessMode ?? "full"}
                  </span>
                </div>
                <p
                  class="truncate font-mono text-xs text-text-secondary"
                  title={entry.projectId}
                >
                  {entry.projectId}
                </p>
                <div class="mt-1.5 flex items-center gap-4 text-xs text-text-secondary">
                  <span>Confirm: {entry.confirmMode ?? "auto"}</span>
                  <span>Delete threshold: {entry.deleteThreshold ?? 10}</span>
                  <span>Approved: {formatRelativeTime(entry.approvedAt)}</span>
                </div>
              </div>
              <div class="ml-3 flex items-center gap-1">
                <button
                  class="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-card-hover hover:text-accent"
                  onclick={() => openEditApproval(entry)}
                  title="Edit approval"
                >
                  <Pencil class="h-3.5 w-3.5" />
                </button>
                <button
                  class="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-card-hover hover:text-error"
                  onclick={() => (revokeTarget = entry)}
                  title="Revoke approval"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if deleteTarget}
  <ConfirmModal
    title="Remove Agent"
    message="Are you sure you want to remove agent '{deleteTarget.name}'? The agent will need to re-register to reconnect."
    confirmLabel="Remove Agent"
    onconfirm={handleDeleteAgent}
    oncancel={() => (deleteTarget = null)}
  />
{/if}

{#if revokeTarget}
  <ConfirmModal
    title="Revoke Path Approval"
    message="Are you sure you want to revoke the path approval for '{revokeTarget.projectName}'? The agent will no longer be able to sync this project."
    confirmLabel="Revoke"
    onconfirm={handleRevokeApproval}
    oncancel={() => (revokeTarget = null)}
  />
{/if}

{#if showApprovalForm}
  <ApprovalFormModal
    {projects}
    existing={editApproval}
    onsave={handleApprovalSaved}
    oncancel={() => {
      showApprovalForm = false;
      editApproval = undefined;
    }}
  />
{/if}
