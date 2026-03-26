<script lang="ts">
  import Modal from "./Modal.svelte";
  import { createProject, updateProject } from "../lib/api.js";
  import type {
    Project,
    ProjectCreateInput,
    ProjectUpdateInput,
    SyncDirection,
    SyncTrigger,
    ConflictStrategy,
  } from "../lib/types.js";
  import { AlertCircle, Loader2, ChevronDown, ChevronUp } from "lucide-svelte";
  import { untrack } from "svelte";

  interface Props {
    project?: Project;
    onsave: (project: Project) => void;
    oncancel: () => void;
  }

  let { project, onsave, oncancel }: Props = $props();

  // Capture initial values outside the reactive graph — this modal is
  // mounted fresh each time, so we only need the initial prop value.
  const initial = untrack(() => project);
  const isEdit = !!initial;

  // Basic fields
  let name = $state(initial?.name ?? "");
  let remotePath = $state(initial?.remotePath ?? "");
  let direction: SyncDirection = $state(initial?.direction ?? "push");
  let trigger: SyncTrigger = $state(initial?.trigger ?? "manual");
  let conflictStrategy: ConflictStrategy = $state(initial?.conflictStrategy ?? "newest-wins");

  // Advanced fields
  let showAdvanced = $state(false);
  let encrypted = $state(initial?.encrypted ?? false);
  let encryptionPassword = $state("");
  let excludes = $state(initial?.excludes.join(", ") ?? ".git, .DS_Store, *.tmp");
  let bandwidthLimit = $state(initial?.bandwidthLimit ?? "");
  let watchDebounceMs = $state(String(initial?.watchDebounceMs ?? 5000));

  let loading = $state(false);
  let error: string | null = $state(null);

  async function handleSubmit(): Promise<void> {
    if (!name.trim()) return;

    loading = true;
    error = null;
    try {
      const excludeList = excludes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (isEdit && project) {
        const input: ProjectUpdateInput = {
          name: name.trim(),
          remotePath: remotePath.trim() || undefined,
          direction,
          trigger,
          conflictStrategy,
          encrypted,
          excludes: excludeList,
          bandwidthLimit: bandwidthLimit.trim() || undefined,
          watchDebounceMs: Number(watchDebounceMs) || 5000,
        };
        if (encrypted && encryptionPassword) {
          input.encryptionPassword = encryptionPassword;
        }
        const res = await updateProject(project.id, input);
        onsave(res.project);
      } else {
        const input: ProjectCreateInput = {
          name: name.trim(),
          remotePath: remotePath.trim() || undefined,
          direction,
          trigger,
          conflictStrategy,
          encrypted,
          excludes: excludeList,
          bandwidthLimit: bandwidthLimit.trim() || undefined,
          watchDebounceMs: Number(watchDebounceMs) || 5000,
        };
        if (encrypted && encryptionPassword) {
          input.encryptionPassword = encryptionPassword;
        }
        const res = await createProject(input);
        onsave(res.project);
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to save project";
      loading = false;
    }
  }
</script>

<Modal title={isEdit ? "Edit Project" : "New Project"} onclose={oncancel}>
  <form
    class="space-y-4"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    {#if error}
      <div class="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
        <AlertCircle class="h-4 w-4 shrink-0 text-error" />
        <p class="text-sm text-error">{error}</p>
      </div>
    {/if}

    <!-- Name -->
    <div>
      <label for="pf-name" class="mb-1 block text-xs text-text-secondary">Name</label>
      <input
        id="pf-name"
        type="text"
        bind:value={name}
        required
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none"
        placeholder="my-project"
      />
    </div>

    <!-- Remote Path -->
    <div>
      <label for="pf-remote" class="mb-1 block text-xs text-text-secondary">Remote Path</label>
      <input
        id="pf-remote"
        type="text"
        bind:value={remotePath}
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-accent focus:outline-none"
        placeholder="Optional — defaults to project name"
      />
    </div>

    <!-- Direction + Trigger row -->
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label for="pf-direction" class="mb-1 block text-xs text-text-secondary">Direction</label>
        <select
          id="pf-direction"
          bind:value={direction}
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="push">Push</option>
          <option value="pull">Pull</option>
          <option value="bidirectional">Bidirectional</option>
        </select>
      </div>
      <div>
        <label for="pf-trigger" class="mb-1 block text-xs text-text-secondary">Trigger</label>
        <select
          id="pf-trigger"
          bind:value={trigger}
          class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        >
          <option value="manual">Manual</option>
          <option value="watch">Watch</option>
          <option value="schedule">Schedule</option>
          <option value="watch+schedule">Watch + Schedule</option>
        </select>
      </div>
    </div>

    <!-- Conflict Strategy -->
    <div>
      <label for="pf-conflict" class="mb-1 block text-xs text-text-secondary">Conflict Strategy</label>
      <select
        id="pf-conflict"
        bind:value={conflictStrategy}
        class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
      >
        <option value="newest-wins">Newest Wins</option>
        <option value="local-wins">Local Wins</option>
        <option value="remote-wins">Remote Wins</option>
        <option value="manual">Manual</option>
      </select>
    </div>

    <!-- Advanced toggle -->
    <button
      type="button"
      class="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-accent"
      onclick={() => (showAdvanced = !showAdvanced)}
    >
      {#if showAdvanced}
        <ChevronUp class="h-3.5 w-3.5" />
      {:else}
        <ChevronDown class="h-3.5 w-3.5" />
      {/if}
      Advanced Settings
    </button>

    {#if showAdvanced}
      <div class="space-y-4 rounded-md border border-border bg-surface p-4">
        <!-- Encryption -->
        <div class="flex items-center gap-3">
          <input id="pf-encrypted" type="checkbox" bind:checked={encrypted} class="accent-accent" />
          <label for="pf-encrypted" class="text-sm text-text-primary">Encrypt at rest</label>
        </div>

        {#if encrypted}
          <div>
            <label for="pf-enc-pass" class="mb-1 block text-xs text-text-secondary">Encryption Password</label>
            <input
              id="pf-enc-pass"
              type="password"
              bind:value={encryptionPassword}
              class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
              placeholder="Min 12 characters"
              minlength="12"
            />
          </div>
        {/if}

        <!-- Excludes -->
        <div>
          <label for="pf-excludes" class="mb-1 block text-xs text-text-secondary">Excludes (comma-separated)</label>
          <input
            id="pf-excludes"
            type="text"
            bind:value={excludes}
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            placeholder=".git, .DS_Store, *.tmp"
          />
        </div>

        <!-- Bandwidth Limit -->
        <div>
          <label for="pf-bw" class="mb-1 block text-xs text-text-secondary">Bandwidth Limit</label>
          <input
            id="pf-bw"
            type="text"
            bind:value={bandwidthLimit}
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            placeholder="e.g. 1M, 500k (empty = unlimited)"
          />
        </div>

        <!-- Watch Debounce -->
        <div>
          <label for="pf-debounce" class="mb-1 block text-xs text-text-secondary">Watch Debounce (ms)</label>
          <input
            id="pf-debounce"
            type="number"
            bind:value={watchDebounceMs}
            min="500"
            max="60000"
            class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
      </div>
    {/if}

    <!-- Actions -->
    <div class="flex justify-end gap-3 pt-2">
      <button
        type="button"
        class="rounded-md border border-border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary"
        onclick={oncancel}
        disabled={loading}
      >
        Cancel
      </button>
      <button
        type="submit"
        class="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface transition-colors hover:bg-accent-dim disabled:opacity-50"
        disabled={loading || !name.trim()}
      >
        {#if loading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {/if}
        {isEdit ? "Save Changes" : "Create Project"}
      </button>
    </div>
  </form>
</Modal>
