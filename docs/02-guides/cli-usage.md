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
