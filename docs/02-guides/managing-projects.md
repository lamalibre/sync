# Managing Projects

> Create, configure, and manage sync projects — define which folders sync where, how often, and with what conflict strategy, encryption, and bandwidth settings.

## In Plain English

A project is a mapping: "sync this local folder to that cloud path." Each project has its own schedule, its own direction (push/pull/bidirectional), its own exclude patterns, and its own encryption settings. Projects are isolated — a stuck sync on one project does not affect others.

## Creating a Project

### Basic Project

```bash
curl -X POST http://localhost:9393/api/sync/projects \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "documents",
    "localPath": "/home/user/Documents",
    "direction": "bidirectional",
    "watch": true,
    "trigger": "watch"
  }'
```

This creates a project that watches `/home/user/Documents` and syncs bidirectionally whenever files change.

### Full-Featured Project

```bash
curl -X POST http://localhost:9393/api/sync/projects \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "training-data",
    "localPath": "/home/user/data/training",
    "remotePath": "projects/training",
    "direction": "bidirectional",
    "watch": true,
    "trigger": "watch+schedule",
    "schedule": "0 */6 * * *",
    "excludes": [".DS_Store", "*.tmp", "__pycache__", "node_modules/", ".git/"],
    "encrypted": true,
    "encryptionPassword": "strong-passphrase-here",
    "conflictStrategy": "newest-wins",
    "watchDebounceMs": 5000,
    "bandwidthLimit": "10M"
  }'
```

### Project Fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | Yes | — | Project name (used as ID and default remote path) |
| `localPath` | Yes | — | Absolute path to local directory |
| `remotePath` | No | `projects/<id>` | Path within the cloud bucket |
| `direction` | No | `push` | `push`, `pull`, or `bidirectional` |
| `watch` | No | `false` | Enable file watching (chokidar) |
| `trigger` | No | `manual` | `manual`, `watch`, `schedule`, or `watch+schedule` |
| `schedule` | No | `null` | Cron expression (e.g., `0 */6 * * *`) |
| `excludes` | No | `[".git", ".DS_Store", "*.tmp"]` | Glob patterns to skip |
| `includes` | No | `[]` | Glob patterns to include (overrides excludes) |
| `encrypted` | No | `false` | Enable client-side encryption |
| `encryptionPassword` | No | — | Per-project encryption password (min 8 chars) |
| `conflictStrategy` | No | `newest-wins` | `newest-wins`, `local-wins`, `remote-wins`, `manual` |
| `watchDebounceMs` | No | `5000` | Milliseconds to wait after last file change |
| `bandwidthLimit` | No | — | rclone bandwidth limit (e.g., `10M`, `500k`) |

## Updating a Project

```bash
curl -X PATCH http://localhost:9393/api/sync/projects/training-data \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": "0 */12 * * *",
    "bandwidthLimit": "50M"
  }'
```

Only the fields you provide are updated. The agent picks up changes on its next poll (within 30 seconds).

## Deleting a Project

```bash
curl -X DELETE http://localhost:9393/api/sync/projects/training-data \
  -H "Authorization: Bearer <api-key>"
```

By default, this does not delete local or remote files. To also delete the remote copy:

```bash
curl -X DELETE "http://localhost:9393/api/sync/projects/training-data?deleteRemote=true" \
  -H "Authorization: Bearer <api-key>"
```

## Listing Projects

```bash
curl http://localhost:9393/api/sync/projects \
  -H "Authorization: Bearer <api-key>"
```

## Triggering a Manual Sync

```bash
curl -X POST http://localhost:9393/api/sync/projects/training-data/sync \
  -H "Authorization: Bearer <api-key>"
```

Returns 409 if a sync is already in progress for this project.

## Checking Project Status

```bash
curl http://localhost:9393/api/sync/projects/training-data/status \
  -H "Authorization: Bearer <api-key>"
```

### Project Statuses

| Status | Meaning |
| --- | --- |
| `synced` | Last sync completed successfully |
| `syncing` | Sync in progress |
| `local-only` | New project, not yet synced |
| `cloud-only` | Files exist only in the cloud |
| `archived` | Files moved to cloud, local stub remains |
| `error` | Last sync failed |

## Common Scheduling Patterns

| Pattern | Cron | Description |
| --- | --- | --- |
| Every hour | `0 * * * *` | Top of each hour |
| Every 6 hours | `0 */6 * * *` | 00:00, 06:00, 12:00, 18:00 |
| Daily at 9 AM | `0 9 * * *` | Once per day |
| Weekdays at 9 AM | `0 9 * * 1-5` | Monday through Friday |
| Monthly | `0 0 1 * *` | First day of each month |

## Related Documentation

- [Sync Engine](../01-concepts/sync-engine.md) — sync directions, triggers, conflict strategies
- [Archiving Files](archiving-files.md) — archive and restore workflow
- [CLI Usage](cli-usage.md) — managing projects via CLI
- [Projects API](../04-api-reference/projects.md) — full API reference
