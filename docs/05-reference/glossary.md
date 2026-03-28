# Glossary

> Definitions of terms used throughout the Sync documentation.

| Term | Definition |
| --- | --- |
| **Access mode** | Controls what sync direction an agent is allowed to execute for a project: `full` (all directions), `push-only`, `pull-only`, or `protected` (no sync). Set via `sync agent-approve --access-mode`. |
| **Agent** | A daemon (`sync-agent`) running on the machine with files to sync. Polls the server for config, executes rclone operations, watches files, and reports results. |
| **Agent token** | A per-agent authentication token generated on registration, returned once, stored as SHA-256 hash on the server. Required via `X-Agent-Token` header on all agent mutation endpoints. Encrypted at rest on the agent. |
| **Archive** | Moving files from local disk to cloud storage via `rclone move`, replacing them with a metadata stub. Frees local disk space while keeping files retrievable. |
| **Atomic write** | File write pattern (temp → fsync → rename) that prevents partial reads. Used for all JSON state files. |
| **Bandwidth limit** | A per-project limit on rclone transfer speed. Format: `10M` (10 MB/s), `500k` (500 KB/s), or time-based (`08:00,10M 18:00,50M`). Passed as `--bwlimit`. |
| **Bidirectional sync** | Two-way sync via `rclone bisync` where changes on either local or cloud side are propagated. Requires conflict resolution strategy. |
| **Bisync baseline** | The initial state established by `rclone bisync --resync` on first run. Subsequent runs compare against this baseline to detect changes. |
| **chokidar** | Node.js file watching library used to detect local file changes. Uses native OS events (FSEvents on macOS, inotify on Linux). |
| **Config bundle** | An encrypted package from Portlama containing server URL, credentials, and project definitions. Used for agent enrollment in plugin mode. |
| **Confirm mode** | Controls whether sync operations require preview approval: `auto` (execute immediately), `confirm-destructive` (require approval when deletes exceed threshold), `confirm-always` (require approval for all syncs). Set via `sync agent-approve --confirm-mode`. |
| **Conflict** | When the same file changes on both local and cloud between syncs. Detected by `rclone bisync`. Resolved by the project's conflict strategy. |
| **Conflict strategy** | How to resolve bidirectional sync conflicts: `newest-wins` (most recent mtime), `local-wins`, `remote-wins`, or `manual` (keep both in-place with numeric suffixes). |
| **Cron expression** | A 5-field time specification for scheduled syncs: minute hour day month weekday. Example: `0 */6 * * *` = every 6 hours. |
| **Debounce** | Collecting file change events over a time window (default 5 seconds) before triggering a sync. Prevents rapid-fire syncs from burst operations. |
| **Delta sync** | Transferring only changed bytes rather than entire files. Handled by rclone using checksums and modification times. |
| **Exclude pattern** | A glob pattern for files to skip during sync. Examples: `.DS_Store`, `*.tmp`, `node_modules/`. Passed to rclone as `--exclude` flags. |
| **execa** | Node.js library for running external processes with array arguments. Prevents command injection by avoiding shell interpolation. |
| **Heartbeat** | A periodic signal (every 15 seconds) from the agent to the server, reporting active syncs and disk usage. Used to determine online/offline status. |
| **Master key** | A random 32-byte hex string used to derive encryption keys via scrypt. Generated once on first run, stored at `master.key` with mode 0600. |
| **mTLS** | Mutual TLS — both client and server present certificates during the TLS handshake. Used for agent authentication in plugin mode. |
| **node-cron** | Lightweight cron scheduler for Node.js. Used to run periodic syncs at specified times. |
| **Plugin mode** | Deployment where Sync runs as a Fastify plugin inside Portlama, using Portlama's certificates and agent registry. |
| **Polling** | The agent's loop of checking the server every 30 seconds for config changes. Enables config-driven behavior without WebSocket complexity. |
| **Project** | A mapping between a local directory and a cloud storage path, with sync direction, schedule, encryption, and other settings. |
| **Provider** | A cloud storage service (Spaces, S3, GCS, Azure, B2, custom S3-compatible, local). Configured once on the server. |
| **Push sync** | One-way sync where local is the source of truth. Cloud mirrors local; cloud-only files are deleted. |
| **Pull sync** | One-way sync where cloud is the source of truth. Local mirrors cloud; local-only files are deleted. |
| **Path approval** | A mapping in `approved-paths.json` that authorizes the agent to sync a specific project to a local directory, with access mode and confirm mode settings. Set via `sync agent-approve`. |
| **rclone** | External binary for syncing files with 40+ cloud providers. Sync's sole file transfer engine. |
| **rclone crypt** | rclone's client-side encryption using NaCl SecretBox (XSalsa20 + Poly1305) for content and EME for filenames. |
| **Restore** | Downloading archived files from cloud storage via `rclone copy` and removing the metadata stub. The cloud copy is preserved. |
| **Soft delete** | Marking a project as deleted (`deletedAt` timestamp) without removing it from storage. The project is hidden from normal queries but can be restored. Hard delete permanently removes it. |
| **Soft delete config** | Per-project or global configuration controlling soft delete behavior: `enabled` (boolean), `retentionDays` (1-3650, default 90), and `cleanupSchedule` (cron expression, default `0 3 * * *`). |
| **Standalone mode** | Deployment where Sync runs its own server with its own API key and encryption. Does not require Portlama. |
| **Stub** | A small JSON file (`.sync-stub.json`) left in a local directory after archiving. Contains metadata about the archived files (count, size, cloud location). |
| **Sync trash** | Backup directory (`.sync-trash/`) where files overwritten or deleted during sync are kept. Uses rclone's `--backup-dir` flag. Organized by project and timestamp. Automatically cleaned up based on retention policy (default 90 days). |
| **Trash restore** | Copying files from a timestamped trash directory back to the project's local path. Initiated via `POST /api/sync/projects/:id/restore-trash` or the `trash-restore` CLI command. |
| **Setup token** | A one-time token generated on server first start, logged to console. Required via `X-Setup-Token` header for initial API key generation (`POST /api/sync/setup/api-key`). Verified with constant-time comparison. |
| **Sync preview** | A dry-run output (`rclone --dry-run`) showing planned changes before execution. Created when a project uses `confirm-destructive` or `confirm-always` confirm mode. Reviewed and approved/rejected via CLI (`sync preview`) or API (`/api/sync/previews`). |
| **Sync trigger** | What initiates a sync operation: `manual` (API/CLI), `watch` (file changes), `schedule` (cron), or `watch+schedule` (both). |

## Related Documentation

- [What is Sync?](../00-introduction/what-is-sync.md) — project overview
- [How It Works](../00-introduction/how-it-works.md) — architecture walkthrough
- [Sync Engine](../01-concepts/sync-engine.md) — rclone operations
- [Security Model](../01-concepts/security-model.md) — credential security
