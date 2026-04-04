<script lang="ts">
  import {
    SyncApp,
    type SyncClient,
  } from "@lamalibre/sync-panel";
  import DesktopSettings from "./views/Settings.svelte";
  import {
    LayoutDashboard,
    HardDrive,
    Settings as SettingsIcon,
    Database,
    ArrowLeft,
    Monitor,
    Eye,
    Trash2,
    Loader2,
  } from "lucide-svelte";
  import {
    runDetection,
    getDetectionPhase,
  } from "./lib/detection.svelte.js";
  import { createDesktopSyncClient } from "./lib/desktop-client.js";

  type View =
    | { name: "dashboard" }
    | { name: "project"; projectId: string }
    | { name: "storage" }
    | { name: "agents" }
    | { name: "preview" }
    | { name: "trash" }
    | { name: "settings" };

  let currentView: View = $state({ name: "dashboard" });

  // Run server detection once on startup
  let detectionPhase = $derived(getDetectionPhase());

  $effect(() => {
    runDetection();
  });

  // Create the desktop SyncClient for the shared panel components
  const client: SyncClient = createDesktopSyncClient();

  function navigate(view: View): void {
    currentView = view;
  }

  function navigateToDashboard(): void {
    currentView = { name: "dashboard" };
  }

  const navItems = [
    { name: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
    { name: "preview" as const, label: "Preview", icon: Eye },
    { name: "storage" as const, label: "Storage", icon: Database },
    { name: "agents" as const, label: "Agents", icon: Monitor },
    { name: "trash" as const, label: "Trash", icon: Trash2 },
    { name: "settings" as const, label: "Settings", icon: SettingsIcon },
  ];

  let activeNavName = $derived.by(() => {
    const viewName: View["name"] = currentView.name;
    return viewName === "project" ? "dashboard" : viewName;
  });

  // Map view names to sync-panel page IDs
  let currentPageId = $derived.by(() => {
    const name = currentView.name;
    if (name === "project") return "dashboard";
    return name;
  });
</script>

{#if detectionPhase === 'detecting'}
  <div class="flex h-full items-center justify-center bg-surface">
    <div class="flex flex-col items-center gap-3">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
      <p class="text-sm text-text-secondary">Detecting sync server...</p>
    </div>
  </div>
{:else}
<div class="flex h-full">
  <!-- Sidebar -->
  <nav class="flex w-56 flex-col border-r border-border bg-card">
    <div class="flex items-center gap-2 border-b border-border px-4 py-4">
      <HardDrive class="h-5 w-5 text-accent" />
      <span class="text-sm font-semibold tracking-wide text-accent">Sync</span>
    </div>

    <div class="flex flex-1 flex-col gap-1 p-2">
      {#each navItems as item}
        <button
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors
            {activeNavName === item.name
            ? 'bg-card-hover text-accent'
            : 'text-text-secondary hover:bg-card-hover hover:text-text-primary'}"
          onclick={() => navigate({ name: item.name })}
        >
          <item.icon class="h-4 w-4" />
          {item.label}
        </button>
      {/each}
    </div>

    <div class="border-t border-border px-4 py-3">
      <p class="text-xs text-text-secondary">v{__APP_VERSION__}</p>
    </div>
  </nav>

  <!-- Main content -->
  <main class="flex-1 overflow-y-auto bg-surface">
    {#if currentView.name === "settings"}
      <!-- Desktop-specific settings page (connection config) -->
      <DesktopSettings />
    {:else}
      <!-- Shared sync-panel pages -->
      <SyncApp {client} currentPage={currentPageId} />
    {/if}
  </main>
</div>
{/if}
