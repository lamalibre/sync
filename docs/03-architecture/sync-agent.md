# Sync Agent

> The Sync Agent is a Node.js daemon that polls the server for configuration, executes rclone operations, watches files for changes, schedules syncs via cron, and reports results — all with per-project isolation.

## In Plain English

The agent is the worker. It runs on the machine with the files and does the actual syncing. Every 30 seconds it asks the server: "what are my projects and credentials?" If something changed — a new project, a different schedule, a triggered sync — the agent adapts and executes.

The agent never stores project definitions or credentials permanently in plaintext. It receives them from the server on each poll, uses them to generate a temporary rclone config, and caches them encrypted for offline resilience.

The agent's own settings (`agent-settings.json`) are also protected: the API key and agent token fields are encrypted at rest using AES-256-GCM with the agent's master key. On read, they are transparently decrypted. Plaintext values from earlier versions are detected and handled for backward compatibility.

## Daemon Lifecycle

```
1. Start
   └── Load agent-settings.json (server URL, API key, agent ID)
   └── Register with server: POST /api/sync/agents
   └── Load cached config (if server unreachable, use cache)

2. Poll loop (every 30 seconds)
   └── GET /api/sync/agent-config
   └── Decrypt storage credentials
   └── Diff against previous config
   └── Reconcile: add/update/remove projects

3. Reconciliation
   ├── New project:
   │   └── Generate rclone.conf section
   │   └── Start file watcher (if watch trigger)
   │   └── Set up cron job (if schedule trigger)
   │
   ├── Updated project:
   │   └── Regenerate rclone.conf section
   │   └── Update watcher/cron settings
   │
   └── Deleted project:
       └── Stop file watcher
       └── Remove cron job
       └── Clean up state

4. Heartbeat (every 15 seconds)
   └── POST /api/sync/agents/:id/heartbeat
   └── Headers: X-Agent-Token (per-agent auth)
   └── Body: activeSyncs[], diskUsage

5. Shutdown
   └── Stop all watchers
   └── Cancel all cron jobs
   └── Abort any running rclone processes (via AbortController)
```

## Ignore Pattern Resolution

Before each sync operation (and before creating file watchers), the agent resolves ignore patterns from five sources into a single unified set:

1. **Built-in defaults** — `node_modules/**`, `.git/**`, `__pycache__/**`, `target/**`, `.DS_Store`, `*.tmp`, `*.log`, etc.
2. **`.gitignore`** files — root + nested, each scoped to their directory
3. **`.dockerignore`** — root only
4. **`.syncignore`** — custom per-project file using gitignore syntax
5. **API excludes** — `project.excludes` from server config

The resolved patterns are written to `~/.sync-agent/exclude-filters/<projectId>.exclude` (atomically, mode `0600`) and passed to rclone via `--exclude-from`. The same patterns are converted to RegExps for chokidar's file watcher.

Resolution is dynamic — editing `.gitignore` or `.syncignore` takes effect on the next sync without restarting the agent. The exclude file is only rewritten when content actually changes (SHA-256 comparison).

The directory walk for nested `.gitignore` discovery skips directories matched by built-in excludes (`node_modules`, `.git`, `target`, etc.) to avoid descending into heavy directories.

## rclone Operations

### Sync (Push/Pull)

```
execa('rclone', [
  'sync',
  source,               // local or remote
  destination,          // remote or local
  '--progress',
  '--stats-one-line',
  '--stats', '2s',
  '--transfers', '4',
  '--checkers', '8',
  '--retries', '3',
  '--low-level-retries', '10',
  ...includeFlags,            // --include patterns + trailing --exclude '*'
  '--exclude-from', excludeFilterPath,
  ...bandwidthFlags,
  ...backupDirFlags,          // --backup-dir for soft delete
], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG passed via env, not CLI
  extendEnv: false,
})
```

**Push:** `source = localPath`, `destination = sync-remote:bucket/remotePath`
**Pull:** `source = sync-remote:bucket/remotePath`, `destination = localPath`

### Bisync (Bidirectional)

```
execa('rclone', [
  'bisync',
  localPath,
  `sync-remote:${bucket}/${remotePath}`,
  '--verbose',
  '--retries', '3',
  '--low-level-retries', '10',
  ...includeFlags,
  '--exclude-from', excludeFilterPath,
  ...bandwidthFlags,
  ...conflictFlags,           // --conflict-resolve / --conflict-loser
  ...bisyncBackupDirFlags,    // --backup-dir1 / --backup-dir2 for soft delete
  '--resync',                 // only on first run
], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG passed via env, not CLI
  extendEnv: false,
})
```

The agent tracks whether each project has been synced before. First run includes `--resync` to establish baseline.

### Archive (rclone move)

```
execa('rclone', [
  'move',
  localPath,
  `sync-remote:${bucket}/${remotePath}`,
  '--progress',
  '--stats-one-line',
  '--stats', '2s',
  '--transfers', '4',
  '--checkers', '8',
  '--retries', '3',
  '--low-level-retries', '10',
  '--delete-empty-src-dirs',
  ...includeFlags,
  '--exclude-from', excludeFilterPath,
  '--exclude', '.sync-stub.json',
  ...bandwidthFlags,
  ...backupDirFlags,               // --backup-dir for soft delete
], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG passed via env, not CLI
  extendEnv: false,
})
```

After move completes, the agent creates `.sync-stub.json` with archive metadata.

### Restore (rclone copy)

```
execa('rclone', [
  'copy',
  `sync-remote:${bucket}/${remotePath}`,
  localPath,
  '--progress',
  '--stats-one-line',
  '--stats', '2s',
  '--transfers', '4',
  '--checkers', '8',
  '--retries', '3',
  '--low-level-retries', '10',
  ...bandwidthFlags,
], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG passed via env, not CLI
  extendEnv: false,
})
```

After copy completes, the agent removes `.sync-stub.json`.

## File Watching

chokidar watches project directories for changes:

- Events: `add`, `change`, `unlink`
- `followSymlinks: false` — security: don't follow symlinks
- `usePolling: false` — use native OS events (FSEvents on macOS, inotify on Linux)
- `ignoreInitial: true` — don't fire for existing files on startup
- `awaitWriteFinish.stabilityThreshold: 500` — wait 500ms for writes to complete
- Ignore patterns from the full ignore resolver (built-in + `.gitignore` + `.dockerignore` + `.syncignore` + API excludes) converted to RegExps for chokidar

### Debounce Logic

Changes are collected over a debounce window (default 5 seconds, configurable via `watchDebounceMs`):

1. File change detected → start timer
2. Another change detected → reset timer
3. Timer expires → collect all accumulated changes → trigger sync
4. If sync already in progress → queue changes for next sync

This prevents rapid-fire syncs from burst file operations (e.g., extracting a zip, git checkout).

## Scheduling

node-cron manages periodic syncs:

- Standard 5-field cron syntax (minute hour day month weekday)
- Minimum 5-minute throttle between triggered syncs
- Cron jobs are created/updated/removed on config reconciliation
- Each project has its own independent cron job

## Progress Parsing

The agent parses rclone's stderr output in real-time:

```
Transferred:    52.3 MiB / 100 MiB, 52%, 10.5 MiB/s, ETA 5s
Transferred:        21 / 42, 50%
```

Extracted fields:
- `bytesTransferred`, `totalBytes`, `percentage`
- `speed` (bytes/s)
- `eta` (seconds)
- `filesTransferred`, `filesTotal`

Progress is included in heartbeats so the server can expose real-time operation status.

## Config Caching

The agent caches its config locally in `cached-config.json`:
- Encrypted with AES-256-GCM using the agent's own master key
- Updated on every successful poll
- Used as fallback if the server is unreachable
- Contains full provider config and project list (including credentials)

This ensures the agent can continue operating during server downtime.

## rclone.conf Generation

On each poll, the agent regenerates `rclone.conf`:

1. Read provider config from server response
2. Call `buildRcloneIni()` from sync-shared
3. For encrypted projects: call `rclone obscure` (password via stdin)
4. Generate crypt remote sections (one per unique encryption password)
5. Write to `~/.sync-agent/rclone.conf` with mode 0600

The config is regenerated idempotently — the output is the same if nothing changed.

## Source Files

| File | Role |
| --- | --- |
| `src/agent.ts` | Main daemon (37KB): poll loop, config diff, reconciliation |
| `src/index.ts` | Entry point |
| `src/lib/rclone-runner.ts` | rclone operation execution (sync, bisync, move, copy) |
| `src/lib/rclone-config.ts` | rclone.conf generation from provider config |
| `src/lib/file-watcher.ts` | chokidar file watching with debounce |
| `src/lib/scheduler.ts` | node-cron scheduling |
| `src/lib/archive.ts` | Archive scan and stub generation |
| `src/lib/stub.ts` | Stub file read/write |
| `src/lib/bisync-state.ts` | Bisync baseline tracking |
| `src/lib/dry-run-parser.ts` | rclone `--dry-run` output parsing for sync previews |
| `src/lib/pending-sync.ts` | Re-exports pending sync preview utilities from sync-shared |
| `src/lib/progress-parser.ts` | rclone stderr progress parsing |
| `src/lib/server-client.ts` | HTTP client for server API |
| `src/lib/config.ts` | Agent settings management (encrypted API key and agent token at rest) |
| `src/lib/plugin-mode.ts` | Portlama plugin mode support |
| `src/lib/types.ts` | Agent-specific type definitions |

### Shared (sync-shared)

| File | Role |
| --- | --- |
| `src/ignore-resolver.ts` | Layered ignore resolution: built-in + `.gitignore` + `.dockerignore` + `.syncignore` + API excludes |
| `src/ignore-file-writer.ts` | Atomic write of rclone `--exclude-from` filter files |
| `src/rclone-config.ts` | rclone.conf generation from provider config |
| `src/atomic-write.ts` | Atomic file writes (temp → fsync → rename) |
| `src/approved-paths.ts` | Agent path approval and validation |
| `src/pending-sync.ts` | Sync preview/confirm state management |
| `src/types.ts` | Shared domain types (re-exported by all packages) |

## Related Documentation

- [Sync Server](sync-server.md) — the coordination server
- [Sync Engine](../01-concepts/sync-engine.md) — rclone operations in detail
- [State Management](state-management.md) — file formats and concurrency
- [Config Files](../05-reference/config-files.md) — file locations and permissions
