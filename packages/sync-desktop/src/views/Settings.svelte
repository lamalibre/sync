<script lang="ts">
  import {
    getServerUrl,
    setServerUrl,
    getApiKey,
    setApiKey,
    getHealth,
  } from "../lib/api.js";
  import {
    Settings as SettingsIcon,
    CheckCircle2,
    XCircle,
    Loader2,
    Server,
    Key,
  } from "lucide-svelte";

  let serverUrl = $state(getServerUrl());
  let apiKey = $state(getApiKey());
  let saved = $state(false);
  let testing = $state(false);
  let connectionStatus: "connected" | "error" | null = $state(null);
  let connectionMessage = $state("");

  function handleSave(): void {
    setServerUrl(serverUrl.trim());
    setApiKey(apiKey.trim());
    saved = true;
    connectionStatus = null;
    setTimeout(() => {
      saved = false;
    }, 2000);
  }

  async function handleTestConnection(): Promise<void> {
    testing = true;
    connectionStatus = null;
    // Save current values before testing
    setServerUrl(serverUrl.trim());
    setApiKey(apiKey.trim());

    try {
      const health = await getHealth();
      if (health.ok) {
        connectionStatus = "connected";
        connectionMessage = `Connected. Uptime: ${Math.floor(health.uptime)}s`;
      } else {
        connectionStatus = "error";
        connectionMessage = "Server responded but reported unhealthy status";
      }
    } catch (err: unknown) {
      connectionStatus = "error";
      connectionMessage =
        err instanceof Error ? err.message : "Failed to connect";
    } finally {
      testing = false;
    }
  }
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-lg font-semibold text-text-primary">Settings</h1>
    <p class="mt-1 text-sm text-text-secondary">
      Configure the connection to your sync server.
    </p>
  </div>

  <div class="max-w-xl space-y-6">
    <!-- Server connection -->
    <div class="rounded-lg border border-border bg-card p-5">
      <div class="flex items-center gap-3">
        <SettingsIcon class="h-5 w-5 text-accent" />
        <h2 class="text-sm font-medium text-text-primary">
          Server Connection
        </h2>
      </div>

      <div class="mt-4 space-y-4">
        <!-- Server URL -->
        <div>
          <label
            for="server-url"
            class="mb-1.5 flex items-center gap-2 text-sm text-text-secondary"
          >
            <Server class="h-3.5 w-3.5" />
            Server URL
          </label>
          <input
            id="server-url"
            type="url"
            bind:value={serverUrl}
            placeholder="http://localhost:9393"
            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 outline-none transition-colors focus:border-accent"
          />
        </div>

        <!-- API Key -->
        <div>
          <label
            for="api-key"
            class="mb-1.5 flex items-center gap-2 text-sm text-text-secondary"
          >
            <Key class="h-3.5 w-3.5" />
            API Key
          </label>
          <input
            id="api-key"
            type="password"
            bind:value={apiKey}
            placeholder="Leave empty if auth is disabled"
            class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 outline-none transition-colors focus:border-accent"
          />
          <p class="mt-1 text-xs text-text-secondary">
            Required in production mode. Not needed during development.
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="mt-5 flex items-center gap-3">
        <button
          class="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim"
          onclick={handleSave}
        >
          Save
        </button>
        <button
          class="flex items-center gap-2 rounded-md border border-border bg-card-hover px-4 py-2 text-sm text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
          onclick={handleTestConnection}
          disabled={testing}
        >
          {#if testing}
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            Testing...
          {:else}
            Test Connection
          {/if}
        </button>

        {#if saved}
          <span class="flex items-center gap-1 text-sm text-success">
            <CheckCircle2 class="h-3.5 w-3.5" />
            Saved
          </span>
        {/if}
      </div>

      {#if connectionStatus}
        <div
          class="mt-3 rounded-md px-3 py-2 text-sm {connectionStatus === 'connected'
            ? 'border border-success/30 bg-success/10 text-success'
            : 'border border-error/30 bg-error/10 text-error'}"
        >
          <div class="flex items-center gap-2">
            {#if connectionStatus === "connected"}
              <CheckCircle2 class="h-4 w-4" />
            {:else}
              <XCircle class="h-4 w-4" />
            {/if}
            {connectionMessage}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
