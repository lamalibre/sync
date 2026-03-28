# CLI Usage

> The Sync CLI provides interactive commands for managing sync projects, triggering operations, and viewing status — with non-interactive flags for CI/scripting.

## In Plain English

The CLI is your day-to-day interface to Sync. Instead of writing curl commands against the REST API, you use short commands like `sync status`, `sync trigger`, and `sync archive`. The CLI talks to the same API — it is a convenience layer, not a separate system.

## Configuration

The CLI reads its config from `~/.sync-cli/config.json`:

```json
{
  "serverUrl": "http://localhost:9393",
  "apiKeyEncrypted": "<encrypted>"
}
```

Set up the config:

```bash
sync config --server http://localhost:9393 --api-key <your-api-key>
```

Or run `sync config` interactively to enter the values.

## Commands

### sync status

Show all projects with their sync status:

```bash
sync status
```

Output:

```
  Project            Status     Last Sync              Local Size    Remote Size
  ─────────────────  ─────────  ─────────────────────  ──────────    ───────────
  training-data      synced     2026-03-24 10:30 AM    1.2 GB        1.2 GB
  documents          syncing    (in progress)          340 MB        320 MB
  backups            archived   2026-03-20 02:30 PM    312 B (stub)  50 GB
```

Flags:
- `--json` — output as JSON
- `--server <url>` — override server URL
- `--api-key <key>` — override API key

### sync trigger

Trigger a manual sync (`sync sync` also works as an alias):

```bash
sync trigger
```

Prompts you to select a project. Or specify directly:

```bash
sync trigger --project training-data --yes
```

Flags:
- `--project <name>` — project to sync
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync archive

Archive a project (move files to cloud, free local disk):

```bash
sync archive
```

Or:

```bash
sync archive --project training-data --yes
```

Flags:
- `--project <name>` — project to archive
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync restore

Restore an archived project (download files from cloud):

```bash
sync restore
```

Or:

```bash
sync restore --project training-data --yes
```

Flags:
- `--project <name>` — project to restore
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync projects

List all projects with details:

```bash
sync projects
```

Interactive: select a project to see full details. Or:

```bash
sync projects --detail training-data
```

Flags:
- `--detail <name>` — show details for specific project
- `--json` — output as JSON

### sync config

Show current CLI configuration and server storage status:

```bash
sync config
```

Flags:
- `--json` — output as JSON

> **Note:** The `--server` and `--api-key` flags are global flags available on all commands. They override the server URL and API key for that single invocation only — they do not persist to disk.

### sync project-create

Create a new sync project interactively or via flags:

```bash
sync project-create
```

Or non-interactively:

```bash
sync project-create --name training-data --direction bidirectional --trigger watch+schedule
```

Flags:
- `--name <name>` -- project name (used as ID)
- `--remote-path <path>` -- remote path prefix in bucket
- `--direction <dir>` -- `push`, `pull`, or `bidirectional`
- `--trigger <trigger>` -- `manual`, `watch`, `schedule`, or `watch+schedule`
- `--conflict-strategy <strategy>` -- `newest-wins`, `local-wins`, `remote-wins`, or `manual`
- `--encrypt` -- enable client-side encryption
- `--encrypt-password <pass>` -- encryption password (min 12 chars)
- `--excludes <patterns>` -- comma-separated exclude patterns
- `--bandwidth-limit <limit>` -- rclone bandwidth limit (e.g., `10M`)
- `--watch-debounce <ms>` -- file watch debounce in milliseconds
- `--json` -- output as JSON

### sync project-edit

Edit an existing project interactively or via flags:

```bash
sync project-edit my-project
```

Or non-interactively:

```bash
sync project-edit my-project --direction push --bandwidth-limit 50M --yes
```

Flags:
- `--project <name>` -- project to edit
- `--name <name>` -- new project name
- `--remote-path <path>` -- new remote path prefix
- `--direction <dir>` -- `push`, `pull`, or `bidirectional`
- `--trigger <trigger>` -- `manual`, `watch`, `schedule`, or `watch+schedule`
- `--conflict-strategy <strategy>` -- `newest-wins`, `local-wins`, `remote-wins`, or `manual`
- `--encrypt` -- enable client-side encryption
- `--encrypt-password <pass>` -- encryption password (min 12 chars)
- `--excludes <patterns>` -- comma-separated exclude patterns
- `--bandwidth-limit <limit>` -- rclone bandwidth limit (e.g., `10M`)
- `--watch-debounce <ms>` -- file watch debounce in milliseconds
- `--yes` -- skip confirmation prompt
- `--json` -- output as JSON

### sync project-delete

Delete a project (soft delete by default, recoverable):

```bash
sync project-delete my-project
```

Hard delete (permanent, cannot be undone):

```bash
sync project-delete my-project --permanent --yes
```

Flags:
- `--project <name>` — project to delete
- `--permanent` — permanently delete (cannot be undone)
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync project-restore

Restore a soft-deleted project:

```bash
sync project-restore my-project
```

Interactive: lists only deleted projects to choose from.

Flags:
- `--project <name>` — project to restore
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync trash-list

List trash entries (backup files from sync operations):

```bash
sync trash-list my-project
```

Flags:
- `--project <name>` — project to inspect
- `--json` — output as JSON

### sync trash-purge

Purge trash for a project:

```bash
sync trash-purge my-project --older-than 7d --yes
```

Flags:
- `--project <name>` — project to purge trash for
- `--older-than <Nd>` — only purge trash older than N days (e.g., `7d`, `30d`)
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync trash-restore

Restore files from a project's sync trash (backup files created by `--backup-dir`):

```bash
sync trash-restore my-project
```

Restore a specific timestamp version:

```bash
sync trash-restore my-project 2026-03-24T10-30-00-000Z
```

Flags:
- `--project <name>` — project to restore trash for
- `--yes` — skip confirmation prompt
- `--json` — output as JSON

### sync agent-approve

Approve or manage agent path allowlist. Controls which local paths agents are allowed to sync, and with what access mode:

```bash
sync agent-approve --list
```

List approved and unmapped projects. Or approve a specific project:

```bash
sync agent-approve my-project --path /Users/me/projects/my-project
```

Set access mode and confirm mode:

```bash
sync agent-approve my-project --path /Users/me/projects/my-project --access-mode push-only --confirm-mode confirm-destructive
```

Reject (remove) an existing approval:

```bash
sync agent-approve my-project --reject --yes
```

Flags:
- `--list` -- show approved and unmapped projects
- `--reject` -- remove an existing approval
- `--path <dir>` -- local directory path (non-interactive)
- `--access-mode <mode>` -- `full`, `push-only`, `pull-only`, or `protected`
- `--confirm-mode <mode>` -- `auto`, `confirm-destructive`, or `confirm-always`
- `--delete-threshold <n>` -- max deletions before requiring confirmation (default: 10)
- `--agent-dir <path>` -- override agent directory (default: `~/.sync-agent`)
- `--project <name>` -- project to approve
- `--yes` -- skip confirmation prompt
- `--json` -- output as JSON

### sync preview

Review pending sync changes before execution. When a project uses `confirm-destructive` or `confirm-always` confirm mode, sync operations produce a dry-run preview that must be approved or rejected:

```bash
sync preview
```

List pending previews. Or inspect a specific project:

```bash
sync preview my-project
```

Approve or reject a pending sync:

```bash
sync preview my-project --approve --yes
sync preview my-project --reject --yes
```

Flags:
- `--approve` -- approve a pending sync
- `--reject` -- reject a pending sync
- `--project <name>` -- project to preview
- `--agent-dir <path>` -- override agent directory (default: `~/.sync-agent`)
- `--yes` -- skip confirmation prompt
- `--json` -- output as JSON

> **Note:** `sync preview` reads from local `~/.sync-agent/` files directly and must be run on the machine where the agent is installed. The server API (`/api/sync/previews`) serves the same data for the desktop UI.

### sync agents

List registered agents and their status:

```bash
sync agents
```

Displays agent name, hostname, OS, status (online/offline), last heartbeat, assigned projects, and disk usage.

Flags:
- `--json` -- output as JSON

### sync storage

Show or manage storage provider configuration:

```bash
sync storage
```

Subcommands:
- `sync storage` -- show current storage configuration
- `sync storage configure` -- interactively configure a storage provider
- `sync storage test` -- test storage connectivity
- `sync storage create-bucket` -- create the configured bucket

Flags:
- `--provider <type>` -- provider type (for non-interactive configure)
- `--endpoint <url>` -- provider endpoint
- `--bucket <name>` -- bucket name
- `--region <region>` -- region (for S3/custom)
- `--access-key <key>` -- access key
- `--secret-key <key>` -- secret key
- `--encrypt` -- enable storage-level encryption
- `--encrypt-password <pass>` -- encryption password
- `--yes` -- skip confirmation prompt
- `--json` -- output as JSON

### sync history

Show sync operation history:

```bash
sync history
```

Or filter by project:

```bash
sync history my-project
```

Flags:
- `--project <name>` -- filter by project
- `--limit <n>` -- number of entries to show
- `--json` -- output as JSON

### sync health

Check server health status:

```bash
sync health
```

Displays server uptime, status, and timestamp.

Flags:
- `--json` -- output as JSON

### sync uninstall

Remove the agent service and config:

```bash
sync uninstall
```

Flags:
- `--yes` — skip confirmation prompt

### sync help

Show help text:

```bash
sync help
```

## Non-Interactive Mode

All commands support non-interactive usage via flags. This is useful for CI/CD pipelines and scripts:

```bash
# Trigger sync without prompts
sync trigger --project documents --yes --json

# Check status in a script
sync status --json | jq '.[] | select(.status == "error")'

# Archive in CI
sync archive --project old-data --yes --server http://sync.internal:9393 --api-key $SYNC_API_KEY
```

## API Key Storage

The CLI encrypts your API key locally:
- Encrypted with AES-256-GCM using a local master key
- Master key stored at `~/.sync-cli/master.key` (mode 0600)
- The API key is never stored in plaintext

## Related Documentation

- [Managing Projects](managing-projects.md) — project management via API
- [Archiving Files](archiving-files.md) — archive/restore workflow
- [Quick Start](../00-introduction/quickstart.md) — first sync setup
- [API Overview](../04-api-reference/overview.md) — full REST API reference
