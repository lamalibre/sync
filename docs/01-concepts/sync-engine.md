# Sync Engine

> Sync uses rclone as its sole sync engine — every file transfer, checksum comparison, and cloud API call goes through rclone, giving access to 40+ storage providers, delta sync, bidirectional sync, and client-side encryption without custom protocol code.

## In Plain English

Think of rclone as a universal translator between your files and the cloud. It speaks the language of every major cloud provider — S3, Google Cloud Storage, Azure Blob, Backblaze, DigitalOcean Spaces, and dozens more. When Sync needs to move files, it asks rclone to do the work. Sync never touches cloud APIs directly.

This is a deliberate design decision. File synchronization is full of edge cases — interrupted transfers, changed files, permission errors, network timeouts, different clock skews across machines. rclone has solved these problems over years of development with millions of users. Sync focuses on orchestration: when to sync, what to sync, how to report results.

## For Users

### Sync Directions

Sync supports three directions, each using a different rclone operation:

| Direction | rclone Command | What Happens |
| --- | --- | --- |
| **push** | `rclone sync local → remote` | Local is the source of truth. Cloud mirrors local. Cloud-only files are deleted. |
| **pull** | `rclone sync remote → local` | Cloud is the source of truth. Local mirrors cloud. Local-only files are deleted. |
| **bidirectional** | `rclone bisync` | Both sides are sources of truth. Changes on either side are propagated. Conflicts detected. |

**Push** is safest for backups — your local files are authoritative. **Pull** is useful when the cloud is the canonical source (shared data, CI artifacts). **Bidirectional** is for collaborative workflows where files may change on either side.

### Sync Triggers

Four ways to trigger a sync:

| Trigger | How It Works |
| --- | --- |
| **manual** | You click "sync" in the CLI or call the API. Runs once. |
| **watch** | chokidar watches the local directory. After 5 seconds of no changes (debounce), a sync runs automatically. |
| **schedule** | node-cron runs a sync at the specified cron time (e.g., `0 */6 * * *` = every 6 hours). |
| **watch+schedule** | Both watch and schedule are active. Watch catches live edits; schedule ensures a full sync runs periodically even if the watcher missed something. |

### Conflict Resolution (Bidirectional Only)

When the same file changes on both local and cloud between syncs, rclone bisync detects a conflict. Sync offers four strategies:

| Strategy | Behavior |
| --- | --- |
| **newest-wins** | Keeps the version with the most recent modification time. Default and safest. |
| **local-wins** | Local version always takes precedence. |
| **remote-wins** | Cloud version always takes precedence. |
| **manual** | Both versions are kept in-place with numeric suffixes (e.g., `file.txt` and `file.txt..path1`) for you to resolve manually. |

### Bandwidth Throttling

Limit how much bandwidth rclone uses per project:

- `"10M"` — 10 MB/s maximum
- `"500k"` — 500 KB/s maximum
- `"08:00,10M 18:00,50M"` — 10 MB/s during the day, 50 MB/s at night (supported by rclone but not currently accepted by the Sync API validation — use simple values like `10M`)
- Omit — unlimited (note: `"0"` is not accepted by the API validation; simply omit the field for unlimited bandwidth)

Passed to rclone as the `--bwlimit` flag.

### Ignore / Exclude System

Sync uses a **layered ignore system** that merges patterns from multiple sources. All layers are additive — each can only add exclusions, not remove them.

#### Resolution Order

| Layer | Source | Scope |
| --- | --- | --- |
| 1. **Built-in defaults** | Always applied | `node_modules`, `.git`, `__pycache__`, `.venv`, `target`, `build`, `.DS_Store`, `Thumbs.db`, `*.tmp`, `*.log`, editor dirs, etc. |
| 2. **`.gitignore`** | Parsed from the project's local directory | Root + nested (each scoped to its directory). Nested `.gitignore` files are discovered automatically. |
| 3. **`.dockerignore`** | Parsed from the project root | Root only |
| 4. **`.syncignore`** | Custom per-project file (gitignore syntax) | Root only |
| 5. **API excludes** | `project.excludes` from server config | Per-project, set via API or CLI |

#### `.syncignore`

Place a `.syncignore` file in your project root to define custom exclusions using gitignore syntax:

```gitignore
# Large datasets — sync manually
datasets/raw/

# Temporary build output
.cache/
*.wasm

# IDE workspace files
*.code-workspace
```

The file is resolved dynamically before each sync — edits take effect without restarting the agent.

#### API Excludes

Projects can also define exclude patterns via the API. These are merged on top of the other layers:

```json
{
  "excludes": ["*.bak", "scratch/"]
}
```

#### How Patterns Reach rclone

All resolved patterns are written to a per-project `--exclude-from` file (atomically, in the agent directory). rclone reads this file instead of receiving hundreds of individual `--exclude` arguments. This handles large pattern sets without hitting OS argument length limits.

Patterns follow rclone's filter syntax: glob-based, `**` for recursive directory match, leading `/` for anchored paths.

### Default rclone Settings

Push and pull sync operations use these defaults (bisync uses `--verbose` instead of `--progress`/`--stats-one-line`/`--transfers`/`--checkers`/`--stats`, but still uses `--retries` and `--low-level-retries`):

| Setting | Value | Purpose |
| --- | --- | --- |
| `--transfers` | 4 | Parallel file transfers |
| `--checkers` | 8 | Parallel checksum comparisons |
| `--stats` | 2s | Progress update interval |
| `--retries` | 3 | Retry failed transfers |
| `--low-level-retries` | 10 | Retry low-level network errors |

## For Developers

### rclone Invocation

All rclone calls go through execa with array arguments — never string interpolation:

```
execa('rclone', [
  'sync',
  localPath,
  `sync-remote:${bucket}/${remotePath}`,
  '--progress',
  '--stats-one-line',
  '--stats', '2s',
  '--transfers', '4',
  '--checkers', '8',
  '--retries', '3',
  '--low-level-retries', '10',
  ...includeFlags,
  '--exclude-from', excludeFilterPath,
  ...bandwidthFlags,
  ...backupDirFlags,
], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG passed via env, not CLI
  extendEnv: false,
})
```

This is a critical security requirement. Paths may contain spaces, quotes, and special characters. String interpolation would create command injection vulnerabilities.

### rclone.conf Generation

The agent generates `rclone.conf` from the provider config received from the server:

```ini
[sync-remote]
type = s3
provider = DigitalOcean
access_key_id = <key>
secret_access_key = <secret>
endpoint = ams3.digitaloceanspaces.com
acl = private

[sync-encrypted]
type = crypt
remote = sync-remote:bucket
password = <obscured>
filename_encryption = standard
directory_name_encryption = true
```

The config file is written with mode `0600` and recreated on every poll cycle (idempotent). Credentials come from the server's encrypted storage config, decrypted only in the agent process.

### Progress Parsing

The agent parses rclone's stderr output in real-time to extract:

- `bytesTransferred` — bytes moved so far
- `totalBytes` — estimated total
- `percentage` — completion percentage
- `speed` — transfer speed (e.g., "52.3 MiB/s")
- `eta` — estimated seconds remaining
- `filesTransferred` / `filesTotal` — file counts

Progress is reported via agent heartbeats so the server can expose real-time status.

### Bisync First Run

`rclone bisync` requires an initial `--resync` flag on first run to establish a baseline. The agent tracks whether each project has been synced before and adds `--resync` only on the first invocation. Subsequent runs use the normal bisync algorithm.

### File Watching (chokidar)

```
chokidar.watch(localPath, {
  followSymlinks: false,           // security: don't follow symlinks
  usePolling: false,               // use native OS events
  ignored: resolvedChokidarPatterns,  // from ignore resolver
  ignoreInitial: true,             // skip existing files on startup
  ignorePermissionErrors: true,
  awaitWriteFinish: {
    stabilityThreshold: 500,       // wait 500ms for writes to complete
    pollInterval: 100
  }
})
```

The ignore resolver converts all merged patterns (built-in + `.gitignore` + `.dockerignore` + `.syncignore` + API excludes) into chokidar-compatible RegExp patterns. This means the file watcher respects the same ignore rules as rclone — a file ignored for sync is also ignored by the watcher.

Events (`add`, `change`, `unlink`) are collected over the debounce window (default 5 seconds). The timer resets on each new event. After the window expires, the accumulated changes trigger a single sync.

### Scheduling (node-cron)

Standard 5-field cron syntax:

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

A minimum 5-minute throttle prevents hammer-looping if cron fires faster than a sync can complete.

## Quick Reference

| Item | Value |
| --- | --- |
| **Sync engine** | rclone (external binary) |
| **Directions** | push, pull, bidirectional |
| **Triggers** | manual, watch, schedule, watch+schedule |
| **Conflict strategies** | newest-wins, local-wins, remote-wins, manual |
| **Default transfers** | 4 parallel |
| **Default checkers** | 8 parallel |
| **Watch debounce** | 5 seconds (configurable via `watchDebounceMs`) |
| **Min schedule interval** | 5 minutes (throttle) |
| **Progress reporting** | Real-time from rclone stderr |

## Related Documentation

- [Archive & Restore](archive-restore.md) — the offload workflow using rclone move/copy
- [Storage Providers](storage-providers.md) — provider-specific config details
- [Encryption](encryption.md) — rclone crypt integration
- [Sync Agent](../03-architecture/sync-agent.md) — agent internals
