<script lang="ts">
  import { getAgents, deleteAgent } from "../lib/api.js";
  import type { Agent } from "../lib/types.js";
  import ConfirmModal from "../components/ConfirmModal.svelte";
  import {
    AlertCircle,
    Loader2,
    RefreshCw,
    Monitor,
    Trash2,
    HardDrive,
  } from "lucide-svelte";

  let agents: Agent[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let deleteTarget: Agent | null = $state(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await getAgents();
      agents = res.agents;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load agents";
    } finally {
      loading = false;
    }
  }

  async function handleDeleteAgent(): Promise<void> {
    if (!deleteTarget) return;
    await deleteAgent(deleteTarget.id);
    deleteTarget = null;
    await refresh();
  }

  // 15s auto-polling
  $effect(() => {
    refresh();
    const interval = setInterval(() => { refresh(); }, 15_000);
    return () => clearInterval(interval);
  });

  function formatRelativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function diskUsagePercent(agent: Agent): number {
    if (!agent.diskUsage || agent.diskUsage.totalBytes === 0) return 0;
    return (agent.diskUsage.usedBytes / agent.diskUsage.totalBytes) * 100;
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
      <code class="mt-3 inline-block rounded-md bg-card px-3 py-1.5 text-xs text-accent">
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
                <h3 class="text-sm font-medium text-text-primary">{agent.name}</h3>
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
              <dd class="text-text-primary">{agent.os}{agent.osVersion ? ` ${agent.osVersion}` : ""}</dd>
            </div>
            <div>
              <dt class="text-text-secondary">Last heartbeat</dt>
              <dd class="text-text-primary">{formatRelativeTime(agent.lastHeartbeat)}</dd>
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
