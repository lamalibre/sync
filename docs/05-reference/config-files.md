# Config Files

> Quick reference for all files created and managed by Sync, their locations, permissions, and purposes.

## Server Files (`~/.sync/`)

| File | Mode | Purpose |
| --- | --- | --- |
| `sync-config.json` | `0600` | Storage config: provider, credentials (encrypted), test results, API key hash |
| `projects.json` | `0600` | Project definitions: paths, direction, schedule, excludes, encryption |
| `sync-history.json` | `0600` | Sync operation log (last 100 per project) |
| `archive-savings.json` | `0600` | Per-project archive disk savings |
| `agents.json` | `0600` | Agent registry: IDs, heartbeats, project assignments, disk usage, agent token hashes |
| `master.key` | `0600` | Encryption master key (32-byte hex, generated once) |

Directory mode: `0700`

## Agent Files (`~/.sync-agent/`)

| File | Mode | Purpose |
| --- | --- | --- |
| `agent-settings.json` | `0600` | Config: server URL, API key (encrypted), agent ID, agent token (encrypted), poll interval |
| `cached-config.json` | `0600` | Encrypted cache of server config (offline fallback) |
| `rclone.conf` | `0600` | Generated rclone config (provider credentials, crypt overlays) |
| `master.key` | `0600` | Agent encryption key (32-byte hex, generated once) |
| `sync-state.json` | `0600` | Per-project sync tracking (last sync time, bisync baseline) |
| `approved-paths.json` | `0600` | Project-to-local-path mapping (set via `sync agent-approve`) |
| `pending-syncs/` | `0700` | Dry-run preview files for sync confirm mode (auto-expires after 1 hour) |
| `exclude-filters/` | `0700` | Per-project rclone `--exclude-from` files (auto-generated from ignore resolver) |
| `exclude-filters/<id>.exclude` | `0600` | Merged exclude patterns for a project (built-in + `.gitignore` + `.dockerignore` + `.syncignore` + API excludes) |

Directory mode: `0700`

## CLI Files (`~/.sync-cli/`)

| File | Mode | Purpose |
| --- | --- | --- |
| `config.json` | `0600` | CLI config: server URL, encrypted API key |
| `master.key` | `0600` | CLI encryption key (for API key encryption) |

## System Service Files

### macOS (launchd)

| File | Purpose |
| --- | --- |
| `~/Library/LaunchAgents/com.lamalibre.sync-server.plist` | Server daemon |
| `~/Library/LaunchAgents/com.lamalibre.sync-agent.plist` | Agent daemon |

### Linux (systemd)

| File | Purpose |
| --- | --- |
| `~/.config/systemd/user/sync-server.service` | Server daemon |
| `~/.config/systemd/user/sync-agent.service` | Agent daemon |

## Write Patterns

All JSON state files use **atomic writes**: write to a random temp file (`.tmp-<hex>`), fsync, then rename into place. This ensures that a crash mid-write never corrupts the file.

## Related Documentation

- [State Management](../03-architecture/state-management.md) — file formats and concurrency details
- [Security Model](../01-concepts/security-model.md) — file permission rationale
- [Sync Server](../03-architecture/sync-server.md) — server-side files
- [Sync Agent](../03-architecture/sync-agent.md) — agent-side files
