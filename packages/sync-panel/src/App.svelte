<script lang="ts">
  import { untrack } from 'svelte';
  import type { SyncClient } from './lib/client.js';
  import { setSyncClient } from './context/client.svelte.js';
  import Dashboard from './pages/Dashboard.svelte';
  import ProjectDetail from './pages/ProjectDetail.svelte';
  import StorageSetup from './pages/StorageSetup.svelte';
  import Agents from './pages/Agents.svelte';
  import Preview from './pages/Preview.svelte';
  import Trash from './pages/Trash.svelte';
  import Settings from './pages/Settings.svelte';
  import { ArrowLeft } from 'lucide-svelte';

  interface Props {
    client: SyncClient;
    currentPage: string;
  }

  let { client, currentPage }: Props = $props();

  // Provide the client to all child components via context.
  // setContext must run during init. The client instance doesn't change
  // after mount — untrack silences state_referenced_locally.
  setSyncClient(untrack(() => client));

  // Internal navigation state for drill-down pages (e.g., Dashboard → ProjectDetail)
  let internalPage: { type: 'project'; projectId: string } | null = $state(null);

  // Reset internal navigation when the host changes the page
  $effect(() => {
    // Access currentPage to create dependency
    void currentPage;
    internalPage = null;
  });

  function navigateToProject(projectId: string): void {
    internalPage = { type: 'project', projectId };
  }

  function navigateBackToDashboard(): void {
    internalPage = null;
  }
</script>

<div class="font-mono text-text-primary">
  {#if internalPage?.type === 'project' && currentPage === 'dashboard'}
    <div class="p-6">
      <button
        class="mb-4 flex items-center gap-1 text-sm text-text-secondary transition-colors hover:text-accent"
        onclick={navigateBackToDashboard}
      >
        <ArrowLeft class="h-4 w-4" />
        Back to Dashboard
      </button>
      <ProjectDetail
        projectId={internalPage.projectId}
        onNavigateBack={navigateBackToDashboard}
      />
    </div>
  {:else if currentPage === 'dashboard'}
    <Dashboard onSelectProject={navigateToProject} />
  {:else if currentPage === 'storage'}
    <StorageSetup />
  {:else if currentPage === 'agents'}
    <Agents />
  {:else if currentPage === 'preview'}
    <Preview />
  {:else if currentPage === 'trash'}
    <Trash />
  {:else if currentPage === 'settings'}
    <Settings />
  {:else}
    <Dashboard onSelectProject={navigateToProject} />
  {/if}
</div>
