<script lang="ts">
  import { getSyncClient } from "../context/client.svelte.js";
  import type { StorageResponse, ProviderType, StorageConfigInput } from "../lib/types.js";
  import {
    Database,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
    FlaskConical,
    Pencil,
  } from "lucide-svelte";

  const client = getSyncClient();

  let storage: StorageResponse | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let testing = $state(false);
  let testResult: { ok: boolean; message: string } | null = $state(null);
  let showConfigForm = $state(false);

  // Form state
  let provider: Exclude<ProviderType, "local"> = $state("s3");
  let endpoint = $state("");
  let bucket = $state("");
  let accessKey = $state("");
  let secretKey = $state("");
  let region = $state("");
  let encryption = $state(false);
  let encryptionPassword = $state("");
  let saving = $state(false);
  let saveError: string | null = $state(null);

  // Bucket creation
  let creatingBucket = $state(false);
  let bucketResult: { ok: boolean; message: string } | null = $state(null);

  const providerHints: Record<string, string> = {
    spaces: "https://<region>.digitaloceanspaces.com",
    s3: "https://s3.<region>.amazonaws.com",
    gcs: "https://storage.googleapis.com",
    azure: "https://<account>.blob.core.windows.net",
    b2: "https://s3.us-west-004.backblazeb2.com",
    custom: "https://your-s3-compatible-endpoint.com",
  };

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      storage = await client.getStorage();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load storage config";
    } finally {
      loading = false;
    }
  }

  async function handleTest(): Promise<void> {
    testing = true;
    testResult = null;
    try {
      const result = await client.testStorage();
      testResult = {
        ok: result.ok,
        message: result.ok
          ? `Connection successful (${result.latency}ms)`
          : (result.error ?? "Connection failed"),
      };
    } catch (err: unknown) {
      testResult = {
        ok: false,
        message: err instanceof Error ? err.message : "Test failed",
      };
    } finally {
      testing = false;
    }
  }

  async function handleSaveConfig(): Promise<void> {
    saving = true;
    saveError = null;
    try {
      const input: StorageConfigInput = {
        provider,
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        accessKey: accessKey.trim(),
        secretKey: secretKey.trim(),
        region: region.trim() || undefined,
        encryption,
        encryptionPassword: encryption ? encryptionPassword : undefined,
      };
      await client.configureStorage(input);
      showConfigForm = false;
      accessKey = "";
      secretKey = "";
      encryptionPassword = "";
      await refresh();
    } catch (err: unknown) {
      saveError = err instanceof Error ? err.message : "Failed to save configuration";
    } finally {
      saving = false;
    }
  }

  async function handleCreateBucket(): Promise<void> {
    creatingBucket = true;
    bucketResult = null;
    try {
      const result = await client.createBucket();
      bucketResult = {
        ok: true,
        message: `Bucket "${result.bucket}" ${result.created ? "created" : "already exists"}`,
      };
    } catch (err: unknown) {
      bucketResult = {
        ok: false,
        message: err instanceof Error ? err.message : "Failed to create bucket",
      };
    } finally {
      creatingBucket = false;
    }
  }

  $effect(() => {
    refresh();
  });
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-lg font-semibold text-text-primary">Storage</h1>
    <p class="mt-1 text-sm text-text-secondary">
      Configure and test your cloud storage provider.
    </p>
  </div>

  {#if error}
    <div
      class="mb-6 flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3"
    >
      <AlertCircle class="h-5 w-5 shrink-0 text-error" />
      <p class="text-sm text-error">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-12">
      <Loader2 class="h-6 w-6 animate-spin text-accent" />
    </div>
  {:else if storage}
    <div class="max-w-xl space-y-6">
      <!-- Current status -->
      <div class="rounded-lg border border-border bg-card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <Database class="h-5 w-5 text-accent" />
            <h2 class="text-sm font-medium text-text-primary">Current Configuration</h2>
          </div>
          {#if storage.configured}
            <button
              class="flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-accent"
              onclick={() => (showConfigForm = !showConfigForm)}
            >
              <Pencil class="h-3 w-3" />
              {showConfigForm ? "Cancel" : "Update"}
            </button>
          {/if}
        </div>

        <dl class="mt-4 space-y-3 text-sm">
          <div class="flex justify-between">
            <dt class="text-text-secondary">Configured</dt>
            <dd class="font-medium">
              {#if storage.configured}
                <span class="flex items-center gap-1 text-success">
                  <CheckCircle2 class="h-3.5 w-3.5" /> Yes
                </span>
              {:else}
                <span class="flex items-center gap-1 text-text-secondary">
                  <XCircle class="h-3.5 w-3.5" /> No
                </span>
              {/if}
            </dd>
          </div>
          {#if storage.configured}
            <div class="flex justify-between">
              <dt class="text-text-secondary">Provider</dt>
              <dd class="text-text-primary">{storage.provider}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-text-secondary">Last tested</dt>
              <dd class="text-text-primary">
                {storage.lastTested ? new Date(storage.lastTested).toLocaleString() : "Never"}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-text-secondary">Test result</dt>
              <dd>
                {#if storage.testResult === "ok"}
                  <span class="text-success">Passed</span>
                {:else if storage.testResult === "error"}
                  <span class="text-error">Failed</span>
                {:else}
                  <span class="text-text-secondary">-</span>
                {/if}
              </dd>
            </div>
          {/if}
        </dl>
      </div>

      <!-- Configuration form -->
      {#if showConfigForm || !storage.configured}
        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="mb-4 text-sm font-medium text-text-primary">
            {storage.configured ? "Update Configuration" : "Configure Storage"}
          </h2>

          {#if saveError}
            <div class="mb-4 flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
              <AlertCircle class="h-4 w-4 shrink-0 text-error" />
              <p class="text-sm text-error">{saveError}</p>
            </div>
          {/if}

          <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); handleSaveConfig(); }}>
            <div>
              <label for="st-provider" class="mb-1 block text-xs text-text-secondary">Provider</label>
              <select id="st-provider" bind:value={provider} class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none">
                <option value="s3">Amazon S3</option>
                <option value="spaces">DigitalOcean Spaces</option>
                <option value="gcs">Google Cloud Storage</option>
                <option value="azure">Azure Blob Storage</option>
                <option value="b2">Backblaze B2</option>
                <option value="custom">Custom S3-compatible</option>
              </select>
            </div>
            <div>
              <label for="st-endpoint" class="mb-1 block text-xs text-text-secondary">Endpoint</label>
              <input id="st-endpoint" type="url" bind:value={endpoint} required class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none" placeholder={providerHints[provider] ?? "https://..."} />
            </div>
            <div>
              <label for="st-bucket" class="mb-1 block text-xs text-text-secondary">Bucket</label>
              <input id="st-bucket" type="text" bind:value={bucket} required class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none" placeholder="my-sync-bucket" />
            </div>
            <div>
              <label for="st-region" class="mb-1 block text-xs text-text-secondary">Region (optional)</label>
              <input id="st-region" type="text" bind:value={region} class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none" placeholder="us-east-1" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="st-access" class="mb-1 block text-xs text-text-secondary">Access Key</label>
                <input id="st-access" type="text" bind:value={accessKey} required class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none" />
              </div>
              <div>
                <label for="st-secret" class="mb-1 block text-xs text-text-secondary">Secret Key</label>
                <input id="st-secret" type="password" bind:value={secretKey} required class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none" />
              </div>
            </div>
            <div class="flex items-center gap-3">
              <input id="st-encryption" type="checkbox" bind:checked={encryption} class="accent-accent" />
              <label for="st-encryption" class="text-sm text-text-primary">Encrypt at rest</label>
            </div>
            {#if encryption}
              <div>
                <label for="st-enc-pass" class="mb-1 block text-xs text-text-secondary">Encryption Password</label>
                <input id="st-enc-pass" type="password" bind:value={encryptionPassword} required class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none" placeholder="Min 12 characters" minlength="12" />
              </div>
            {/if}
            <div class="flex gap-3 pt-2">
              <button type="submit" class="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim disabled:opacity-50" disabled={saving}>
                {#if saving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
                Save Configuration
              </button>
              {#if storage.configured}
                <button type="button" class="rounded-md border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-card-hover" onclick={() => (showConfigForm = false)}>Cancel</button>
              {/if}
            </div>
          </form>
        </div>
      {/if}

      <!-- Test connection + Create bucket -->
      {#if storage.configured && !showConfigForm}
        <div class="rounded-lg border border-border bg-card p-5">
          <div class="flex items-center gap-3">
            <FlaskConical class="h-5 w-5 text-accent" />
            <h2 class="text-sm font-medium text-text-primary">Test Connection</h2>
          </div>
          <p class="mt-2 text-sm text-text-secondary">Verify that the server can reach your cloud storage provider.</p>
          <div class="mt-4 flex gap-3">
            <button class="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim disabled:opacity-50" onclick={handleTest} disabled={testing}>
              {#if testing}<Loader2 class="h-4 w-4 animate-spin" />Testing...{:else}Test Connection{/if}
            </button>
            <button class="flex items-center gap-2 rounded-md border border-border bg-card-hover px-4 py-2 text-sm text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50" onclick={handleCreateBucket} disabled={creatingBucket}>
              {#if creatingBucket}<Loader2 class="h-4 w-4 animate-spin" />{/if}
              Create Bucket
            </button>
          </div>
          {#if testResult}
            <div class="mt-3 rounded-md px-3 py-2 text-sm {testResult.ok ? 'border border-success/30 bg-success/10 text-success' : 'border border-error/30 bg-error/10 text-error'}">{testResult.message}</div>
          {/if}
          {#if bucketResult}
            <div class="mt-3 rounded-md px-3 py-2 text-sm {bucketResult.ok ? 'border border-success/30 bg-success/10 text-success' : 'border border-error/30 bg-error/10 text-error'}">{bucketResult.message}</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
