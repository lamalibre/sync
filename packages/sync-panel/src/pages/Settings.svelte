<script lang="ts">
  import { getSyncClient } from "../context/client.svelte.js";
  import type { StorageResponse } from "../lib/types.js";
  import {
    Settings as SettingsIcon,
    CheckCircle2,
    XCircle,
    Loader2,
    AlertCircle,
    Database,
  } from "lucide-svelte";

  const client = getSyncClient();

  let storage: StorageResponse | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let testing = $state(false);
  let testStatus: { ok: boolean; message: string } | null = $state(null);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      storage = await client.getStorage();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load settings";
    } finally {
      loading = false;
    }
  }

  async function handleTestConnection(): Promise<void> {
    testing = true;
    testStatus = null;
    try {
      const result = await client.testStorage();
      testStatus = {
        ok: result.ok,
        message: result.ok
          ? `Connected. Latency: ${result.latency}ms`
          : (result.error ?? "Connection failed"),
      };
    } catch (err: unknown) {
      testStatus = {
        ok: false,
        message: err instanceof Error ? err.message : "Test failed",
      };
    } finally {
      testing = false;
    }
  }

  $effect(() => { refresh(); });
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-lg font-semibold text-text-primary">Settings</h1>
    <p class="mt-1 text-sm text-text-secondary">Sync server configuration overview.</p>
  </div>

  {#if error}
    <div class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3">
      <AlertCircle class="h-5 w-5 shrink-0 text-error" />
      <p class="text-sm text-error">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
    </div>
  {:else}
    <div class="max-w-xl space-y-6">
      <!-- Storage status -->
      <div class="rounded-lg border border-border bg-card p-5">
        <div class="flex items-center gap-3">
          <Database class="h-5 w-5 text-accent" />
          <h2 class="text-sm font-medium text-text-primary">Storage</h2>
        </div>

        <dl class="mt-4 space-y-3 text-sm">
          <div class="flex justify-between">
            <dt class="text-text-secondary">Configured</dt>
            <dd class="font-medium">
              {#if storage?.configured}
                <span class="flex items-center gap-1 text-success"><CheckCircle2 class="h-3.5 w-3.5" /> Yes</span>
              {:else}
                <span class="flex items-center gap-1 text-text-secondary"><XCircle class="h-3.5 w-3.5" /> No</span>
              {/if}
            </dd>
          </div>
          {#if storage?.configured}
            <div class="flex justify-between">
              <dt class="text-text-secondary">Provider</dt>
              <dd class="text-text-primary">{storage.provider}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-text-secondary">Last tested</dt>
              <dd class="text-text-primary">{storage.lastTested ? new Date(storage.lastTested).toLocaleString() : "Never"}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-text-secondary">Test result</dt>
              <dd>
                {#if storage.testResult === "ok"}<span class="text-success">Passed</span>
                {:else if storage.testResult === "error"}<span class="text-error">Failed</span>
                {:else}<span class="text-text-secondary">-</span>{/if}
              </dd>
            </div>
          {/if}
        </dl>

        {#if storage?.configured}
          <div class="mt-4">
            <button
              class="flex items-center gap-2 rounded-md border border-border bg-card-hover px-4 py-2 text-sm text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
              onclick={handleTestConnection}
              disabled={testing}
            >
              {#if testing}
                <Loader2 class="h-3.5 w-3.5 animate-spin" />Testing...
              {:else}
                Test Connection
              {/if}
            </button>
          </div>
        {/if}

        {#if testStatus}
          <div class="mt-3 rounded-md px-3 py-2 text-sm {testStatus.ok ? 'border border-success/30 bg-success/10 text-success' : 'border border-error/30 bg-error/10 text-error'}">
            <div class="flex items-center gap-2">
              {#if testStatus.ok}<CheckCircle2 class="h-4 w-4" />{:else}<XCircle class="h-4 w-4" />{/if}
              {testStatus.message}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
