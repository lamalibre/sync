# Projects API

> CRUD operations for sync projects, manual sync triggers, and project status monitoring.

## Create Project

### `POST /api/sync/projects`

Create a new sync project.

**Request:**

```json
{
  "name": "training-data",
  "localPath": "/home/user/data/training",
  "remotePath": "projects/training",
  "direction": "bidirectional",
  "watch": true,
  "trigger": "watch+schedule",
  "schedule": "0 */6 * * *",
  "excludes": [".DS_Store", "*.tmp", "__pycache__"],
  "includes": [],
  "encrypted": true,
  "encryptionPassword": "strong-passphrase",
  "conflictStrategy": "newest-wins",
  "watchDebounceMs": 5000,
  "bandwidthLimit": "10M"
}
```

**Required fields:** `name`, `localPath`

**Response (201):**

```json
{
  "ok": true,
  "project": {
    "id": "training-data",
    "name": "training-data",
    "localPath": "/home/user/data/training",
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

**Response (200):**

```json
{
  "projects": [
    {
      "id": "training-data",
      "name": "training-data",
      "localPath": "/home/user/data/training",
      "remotePath": "projects/training",
      "direction": "bidirectional",
      "status": "synced",
      "lastSync": "2026-03-24T10:30:00.000Z",
      "encrypted": true,
      "watch": true,
      "trigger": "watch+schedule",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

Encryption passwords are redacted in the response.

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

Delete a project definition. Does not delete local or remote files by default.

**Query parameters:**
- `deleteRemote=true` — also delete remote files in the cloud bucket

**Response (200):**

```json
{
  "ok": true
}
```

**Errors:**
- `404` — Project not found

## Trigger Sync

### `POST /api/sync/projects/:projectId/sync`

Start a manual sync operation.

**Response (200):**

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "started"
}
```

**Errors:**
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
- `404` — Project not found
- `400` — Project is already archived
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

The restore endpoint also supports optional single-file restore via a `filePath` body parameter.

**Errors:**
- `400` — Project is not archived
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
