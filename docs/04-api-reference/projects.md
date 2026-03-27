# Projects API

> CRUD operations for sync projects, manual sync triggers, and project status monitoring.

## Create Project

### `POST /api/sync/projects`

Create a new sync project.

**Request:**

```json
{
  "name": "training-data",
  "remotePath": "projects/training",
  "direction": "bidirectional",
  "watch": true,
  "trigger": "watch+schedule",
  "schedule": "0 */6 * * *",
  "excludes": ["*.bak", "scratch/"],
  "includes": [],
  "encrypted": true,
  "encryptionPassword": "strong-passphrase",
  "conflictStrategy": "newest-wins",
  "watchDebounceMs": 5000,
  "bandwidthLimit": "10M"
}
```

**Required fields:** `name`

> **Note:** `localPath` is not set on the server. The local path is configured on each agent via `sync agent-approve`, which stores it in the agent's `approved-paths.json`. This ensures local filesystem paths never cross the network.

**Response (201):**

```json
{
  "ok": true,
  "project": {
    "id": "training-data",
    "name": "training-data",
    "remotePath": "projects/training",
    "direction": "bidirectional",
    "status": "local-only",
    "createdAt": "2026-03-24T10:00:00.000Z"
  },
  "warnings": ["Encryption is enabled for this project. WARNING: Password loss = data loss. There is no key recovery mechanism. Store your encryption password securely."]
}
```

**Errors:**
- `400` — Validation failed (invalid path, bad cron, etc.)
- `409` — Project with this name already exists

## List Projects

### `GET /api/sync/projects`

**Query parameters:**
- `includeDeleted=true` — include soft-deleted projects in the response (default: `false`)

**Response (200):**

```json
{
  "projects": [
    {
      "id": "training-data",
      "name": "training-data",
      "remotePath": "projects/training",
      "direction": "bidirectional",
      "status": "synced",
      "lastSync": "2026-03-24T10:30:00.000Z",
      "encrypted": true,
      "watch": true,
      "trigger": "watch+schedule",
      "schedule": "0 */6 * * *",
      "deletedAt": null
    }
  ]
}
```

Encryption passwords are redacted in the response. By default, soft-deleted projects are excluded from the list.

## Get Project

### `GET /api/sync/projects/:projectId`

**Response (200):**

```json
{
  "project": { ... }
}
```

Same project fields as in the list response, wrapped in a `project` key.

**Errors:**
- `404` — Project not found

## Update Project

### `PATCH /api/sync/projects/:projectId`

Only provided fields are updated.

**Request:**

```json
{
  "schedule": "0 */12 * * *",
  "bandwidthLimit": "50M"
}
```

**Response (200):**

```json
{
  "ok": true,
  "project": { ... }
}
```

**Errors:**
- `400` — Validation failed
- `404` — Project not found

## Delete Project

### `DELETE /api/sync/projects/:projectId`

Soft-delete a project by default. The project is marked with a `deletedAt` timestamp and excluded from normal queries, but remains recoverable via the restore endpoint.

**Query parameters:**
- `permanent=true` — permanently remove the project (hard delete, cannot be undone)

**Response (200):**

```json
{
  "ok": true
}
```

**Errors:**
- `404` — Project not found
- `409` — An active sync or archive operation is in progress for this project

## Restore Deleted Project

### `POST /api/sync/projects/:projectId/undelete`

Restore a soft-deleted project. Sets `deletedAt` back to `null` and status to `local-only`.

**Response (200):**

```json
{
  "ok": true,
  "project": { ... }
}
```

**Errors:**
- `404` — Project not found
- `409` — Project is not deleted

## Restore Files from Trash

### `POST /api/sync/projects/:projectId/restore-trash`

Restore files from a timestamped trash directory back to the project's local path.

**Request body (optional):**

```json
{
  "timestamp": "2026-03-25T00-00-00-000Z"
}
```

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-25T00-00-00-000Z"
}
```

**Errors:**
- `400` — Storage not configured
- `404` — Project not found
- `409` — Operation already in progress

## Trigger Sync

### `POST /api/sync/projects/:projectId/sync`

Start a manual sync operation.

**Request body (optional):**

```json
{
  "direction": "push"
}
```

When provided, `direction` overrides the project's configured direction for this operation only. Must be one of `push`, `pull`, or `bidirectional`.

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "started"
}
```

**Errors:**
- `400` — Project is deleted (restore it first)
- `400` — Storage not configured
- `404` — Project not found
- `409` — Sync already in progress for this project

## Trigger Archive

### `POST /api/sync/projects/:projectId/archive`

Start an archive operation (move files to cloud, create stub).

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "archiving"
}
```

**Errors:**
- `400` — Project is deleted or already archived
- `400` — Storage not configured
- `404` — Project not found
- `409` — Another operation is in progress

## Trigger Restore

### `POST /api/sync/projects/:projectId/restore`

Start a restore operation (download files from cloud, remove stub).

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "restoring"
}
```

The restore endpoint also supports optional single-file restore via a `filePath` body parameter. The `filePath` must be a relative path and is validated: no null bytes, no `..` segments, no glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`, `\`), no leading `/`, and max 4096 characters.

**Errors:**
- `400` — Project is not archived
- `400` — Project is deleted
- `400` — Storage not configured
- `404` — Project not found
- `409` — Another operation is in progress

## Purge Trash

### `POST /api/sync/projects/:projectId/purge-trash`

Request cleanup of backup files created by `--backup-dir` during sync operations.

**Request body (optional):**

```json
{
  "olderThanDays": 7
}
```

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "olderThanDays": 7
}
```

**Errors:**
- `400` — Invalid `olderThanDays` value (must be a positive integer)
- `404` — Project not found

## List Trash

### `GET /api/sync/projects/:projectId/trash`

Get trash metadata for a project.

**Response (200):**

```json
{
  "projectId": "training-data",
  "entries": []
}
```

**Errors:**
- `404` — Project not found

## Project Status

### `GET /api/sync/projects/:projectId/status`

Get current project status, including active operation progress.

**Response (200) — idle:**

```json
{
  "projectId": "training-data",
  "status": "synced",
  "lastSync": "2026-03-24T10:30:00.000Z",
  "activeOperation": null
}
```

**Response (200) — syncing:**

```json
{
  "projectId": "training-data",
  "status": "syncing",
  "activeOperation": {
    "operationId": "550e8400-e29b-41d4-a716-446655440000",
    "type": "sync",
    "startedAt": "2026-03-24T10:30:00.000Z",
    "transferred": 52428800,
    "totalSize": 104857600,
    "speed": 10485760,
    "eta": 5,
    "filesTransferred": 21,
    "filesTotal": 42
  }
}
```

## Sync History

### `GET /api/sync/history`

List sync operation history.

**Query parameters:**
- `projectId` — filter by project (optional)
- `limit` — number of entries, 1-500 (default 50)

**Response (200):**

```json
{
  "operations": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "projectId": "training-data",
      "type": "sync",
      "direction": "bidirectional",
      "trigger": "watch",
      "status": "completed",
      "startedAt": "2026-03-24T10:30:00.000Z",
      "completedAt": "2026-03-24T10:30:45.000Z",
      "duration": 45,
      "bytesTransferred": 104857600,
      "filesTransferred": 42,
      "errors": 0,
      "errorMessage": null
    }
  ]
}
```

## Global Status

### `GET /api/sync/status`

Aggregate status across all projects.

**Response (200):**

```json
{
  "storageConfigured": true,
  "provider": "spaces",
  "projects": 3,
  "activeOperations": 1,
  "totalLocalSize": 0,
  "totalRemoteSize": 0,
  "totalArchived": 52428800000,
  "savedLocally": 52428799688
}
```

## Related Documentation

- [Storage & Archive API](storage-archive.md) — storage config, archive, and savings endpoints
- [API Overview](overview.md) — authentication and error format
- [Managing Projects](../02-guides/managing-projects.md) — project management guide
