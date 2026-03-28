# Storage & Archive API

> Storage provider configuration, connection testing, archive savings tracking, and agent configuration endpoints.

## Storage Configuration

### Get Storage Config

#### `GET /api/sync/storage`

Returns the current storage provider configuration. Credentials are redacted.

**Response (200):**

```json
{
  "configured": true,
  "provider": "spaces",
  "endpoint": "https://ams3.digitaloceanspaces.com",
  "bucket": "my-sync",
  "region": "ams3",
  "encryption": true,
  "lastTested": "2026-03-24T10:00:00.000Z",
  "testResult": "ok"
}
```

The `region` field is included in the response; its value is `null` when not configured. Credentials are omitted entirely (not shown, not even redacted).

**Response when not configured (200):**

```json
{
  "configured": false,
  "provider": null,
  "lastTested": null,
  "testResult": null
}
```

### Update Storage Config

#### `PATCH /api/sync/storage`

Update storage provider configuration. Credentials are encrypted at rest.

**Request:**

```json
{
  "provider": "spaces",
  "endpoint": "https://ams3.digitaloceanspaces.com",
  "bucket": "my-sync",
  "accessKey": "<access-key>",
  "secretKey": "<secret-key>",
  "encryption": false
}
```

**Response (200):**

```json
{
  "ok": true,
  "provider": "spaces"
}
```

### Test Storage Connection

#### `POST /api/sync/storage/test`

Verifies the configured storage provider is accessible. Runs `rclone lsd` to list the bucket.

**Response (200) — success:**

```json
{
  "ok": true,
  "latency": 245,
  "message": "Connection successful. Bucket is accessible."
}
```

**Response (502) — failure:**

```json
{
  "ok": false,
  "error": "bucket not found or access denied"
}
```

### Create Bucket

#### `POST /api/sync/storage/create-bucket`

Create the configured bucket if it does not exist. Runs `rclone mkdir`.

**Request (optional):**

```json
{
  "bucket": "custom-bucket-name"
}
```

When omitted, uses the bucket name from the storage configuration.

**Response (200):**

```json
{
  "ok": true,
  "bucket": "my-sync",
  "created": true
}
```

## Archive Savings

### Per-Project Savings

#### `GET /api/sync/projects/:projectId/savings`

Get archive savings for a specific project.

**Response (200):**

```json
{
  "projectId": "training-data",
  "archived": true,
  "archivedFileCount": 1247,
  "archivedTotalBytes": 52428800000,
  "stubSizeBytes": 312,
  "bytesSaved": 52428799688,
  "lastArchivedAt": "2026-03-20T14:30:00Z"
}
```

If the project has not been archived, returns `archived: false` with zero counts and `lastArchivedAt: null`.

### Per-Project Stub Info

#### `GET /api/sync/projects/:projectId/stubs`

Get archive stub metadata tracked on the server.

**Response (200):**

```json
{
  "stubs": [
    {
      "projectId": "training-data",
      "archivedAt": "2026-03-20T14:30:00Z",
      "archivedFileCount": 1247,
      "archivedTotalBytes": 52428800000,
      "stubSizeBytes": 312,
      "bytesSaved": 52428799688
    }
  ]
}
```

### Global Savings

#### `GET /api/sync/savings`

Aggregate archive savings across all projects.

**Response (200):**

```json
{
  "projects": 2,
  "totalArchivedFiles": 2500,
  "totalArchivedBytes": 107374182400,
  "totalBytesSaved": 107374181900,
  "perProject": [
    {
      "projectId": "training-data",
      "archivedFileCount": 1247,
      "archivedTotalBytes": 52428800000,
      "bytesSaved": 52428799688,
      "lastArchivedAt": "2026-03-20T14:30:00Z"
    },
    {
      "projectId": "old-backups",
      "archivedFileCount": 1253,
      "archivedTotalBytes": 54945382400,
      "bytesSaved": 54945382212,
      "lastArchivedAt": "2026-03-15T09:00:00Z"
    }
  ]
}
```

## Agent Configuration

### Get Agent Config

#### `GET /api/sync/agent-config`

**Auth:** Agent authentication (standalone: Bearer API key; plugin: mTLS with `sync:read` capability).

Returns the full configuration an agent needs to operate, including decrypted storage credentials and project definitions with encryption passwords.

**Response (200):**

```json
{
  "provider": {
    "type": "spaces",
    "bucket": "my-sync",
    "endpoint": "https://ams3.digitaloceanspaces.com",
    "accessKeyId": "<plaintext-key>",
    "secretAccessKey": "<plaintext-secret>",
    "encryptionPassword": "<plaintext-password>  (only when at least one project uses encryption)"
  },
  "projects": [
    {
      "id": "training-data",
      "name": "training-data",
      "remotePath": "training-data",
      "direction": "bidirectional",
      "includes": [],
      "excludes": [".DS_Store", "*.tmp"],
      "encrypted": true,
      "encryptionPassword": "<plaintext-project-password>",
      "schedule": "0 */6 * * *",
      "watch": true,
      "status": "synced",
      "bandwidthLimit": "10M",
      "conflictStrategy": "newest-wins",
      "trigger": "watch+schedule",
      "watchDebounceMs": 5000,
      "softDelete": {
        "enabled": true,
        "retentionDays": 90,
        "cleanupSchedule": "0 3 * * *"
      }
    }
  ],
  "softDelete": {
    "enabled": true,
    "retentionDays": 90,
    "cleanupSchedule": "0 3 * * *"
  }
}
```

Optional fields are omitted when unset (e.g., `region`, `bandwidthLimit`). Fields like `schedule` are sent as `null` when not configured. Each project object also includes conditional fields when a server-initiated operation is pending: `pendingOperationId`, `pendingType`, and optionally `pendingDirection`.

**Note:** Credential field names in the `provider` object are provider-specific:

| Provider | Fields |
| --- | --- |
| `spaces`, `s3`, `custom` | `accessKeyId`, `secretAccessKey` |
| `gcs` | `serviceAccountKey` |
| `azure` | `storageAccountName`, `storageAccountKey` |
| `b2` | `applicationKeyId`, `applicationKey` |
| `local` | *(no credentials)* |

This is the only endpoint that returns plaintext credentials. It is protected by agent authentication.

### Report Operation Result

#### `POST /api/sync/agent-report`

**Auth:** Agent authentication (standalone: Bearer API key; plugin: mTLS with `sync:write` capability). Also requires `X-Agent-Token` header when any registered agent has a stored token hash.

Report the result of a sync, archive, or restore operation.

**Request:**

```json
{
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "projectId": "training-data",
  "status": "completed",
  "type": "sync",
  "direction": "bidirectional",
  "trigger": "watch",
  "bytesTransferred": 104857600,
  "filesTransferred": 42,
  "duration": 45,
  "errors": 0,
  "conflicts": [],
  "spaceFreed": 0,
  "totalSize": 104857600,
  "fileCount": 42,
  "localSize": 104857600,
  "remoteSize": 104857600
}
```

All fields except `operationId`, `projectId`, and `status` are optional. The `direction`, `type`, `trigger`, `localSize`, and `remoteSize` fields provide additional context when available.

**Response (200):**

```json
{
  "ok": true
}
```

## Agent Registry

### Register Agent

#### `POST /api/sync/agents`

Register a new agent with the server.

**Request:**

```json
{
  "name": "office-mac",
  "hostname": "office-mac.local",
  "os": "darwin",
  "osVersion": "25.1.0",
  "nodeVersion": "22.0.0",
  "agentVersion": "0.1.0",
  "projectIds": []
}
```

**Response (201):**

```json
{
  "ok": true,
  "agent": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "office-mac",
    "hostname": "office-mac.local",
    "os": "darwin",
    "status": "online"
  },
  "agentToken": "<one-time-token>"
}
```

The `agentToken` is returned only on registration. The agent must save it and send it in subsequent `X-Agent-Token` headers for heartbeats, project assignment updates, agent removal, and operation reporting.

If an agent with the same `name` and `hostname` already exists, it is re-registered (updated) with a new token. The server stores the token as a SHA-256 hash.

**Errors:**
- `409` — Maximum number of agents (50) reached

### List Agents

#### `GET /api/sync/agents`

**Response (200):**

```json
{
  "agents": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "office-mac",
      "hostname": "office-mac.local",
      "os": "darwin",
      "status": "online",
      "lastHeartbeat": "2026-03-24T10:30:15.000Z",
      "registeredAt": "2026-03-20T09:00:00.000Z",
      "activeSyncs": [],
      "projectIds": ["training-data"],
      "diskUsage": {
        "totalBytes": 500000000000,
        "freeBytes": 200000000000,
        "usedBytes": 300000000000
      }
    }
  ]
}
```

Online/offline status is determined by whether `lastHeartbeat` is within 30 seconds of now.

### Agent Heartbeat

#### `POST /api/sync/agents/:agentId/heartbeat`

**Auth:** Requires `X-Agent-Token` header with the agent's token. Returns `403` if the token is missing or invalid.

**Request:**

```json
{
  "activeSyncs": [
    {
      "projectId": "training-data",
      "operationId": "550e8400-e29b-41d4-a716-446655440000",
      "startedAt": "2026-03-24T10:30:00.000Z"
    }
  ],
  "diskUsage": {
    "totalBytes": 500000000000,
    "freeBytes": 200000000000,
    "usedBytes": 300000000000
  }
}
```

**Response (200):**

```json
{
  "ok": true,
  "agent": { ... }
}
```

Returns the updated agent object with current status.

### Assign Projects to Agent

#### `PATCH /api/sync/agents/:agentId/projects`

**Auth:** Requires `X-Agent-Token` header with the agent's token. Returns `403` if the token is missing or invalid.

**Request:**

```json
{
  "projectIds": ["training-data", "documents"]
}
```

**Response (200):**

```json
{
  "ok": true,
  "agent": { ... }
}
```

Returns the updated agent object with new project assignments.

### Remove Agent

#### `DELETE /api/sync/agents/:agentId`

**Auth:** Requires `X-Agent-Token` header with the agent's token. Returns `403` if the token is missing or invalid.

**Response (200):**

```json
{
  "ok": true
}
```

## Sync Previews

When a project's confirm mode is set to require approval, the agent runs `rclone --dry-run` and saves the planned changes as a preview. The server exposes these previews for the desktop UI and CLI.

### List Previews

#### `GET /api/sync/previews`

Returns all pending (non-expired) sync previews. The `localPath` field is stripped from the response -- local paths never cross the network.

**Response (200):**

```json
{
  "previews": [
    {
      "projectId": "training-data",
      "projectName": "training-data",
      "operationId": "550e8400-e29b-41d4-a716-446655440000",
      "direction": "push",
      "remotePath": "projects/training",
      "trigger": "watch",
      "createdAt": "2026-03-24T10:30:00.000Z",
      "expiresAt": "2026-03-24T10:40:00.000Z",
      "status": "pending",
      "copyCount": 5,
      "deleteCount": 1,
      "changes": [
        { "path": "data/new-file.csv", "action": "copy" },
        { "path": "data/old-file.csv", "action": "delete" }
      ]
    }
  ]
}
```

### Get Preview Detail

#### `GET /api/sync/previews/:projectId`

Get the pending preview for a specific project. The `localPath` field is stripped from the response.

**Response (200):**

```json
{
  "preview": {
    "projectId": "training-data",
    "projectName": "training-data",
    "operationId": "550e8400-e29b-41d4-a716-446655440000",
    "direction": "push",
    "remotePath": "projects/training",
    "trigger": "watch",
    "createdAt": "2026-03-24T10:30:00.000Z",
    "expiresAt": "2026-03-24T10:40:00.000Z",
    "status": "pending",
    "copyCount": 5,
    "deleteCount": 1,
    "changes": [
      { "path": "data/new-file.csv", "action": "copy" },
      { "path": "data/old-file.csv", "action": "delete" }
    ]
  }
}
```

**Errors:**
- `404` — No pending preview found for this project

### Approve Preview

#### `POST /api/sync/previews/:projectId/approve`

Approve a pending sync preview. The agent will proceed with the sync operation.

**Response (200):**

```json
{
  "ok": true
}
```

**Errors:**
- `404` — No pending preview found (may have expired or already been handled)

### Reject Preview

#### `POST /api/sync/previews/:projectId/reject`

Reject a pending sync preview. The agent will discard the planned operation.

**Response (200):**

```json
{
  "ok": true
}
```

**Errors:**
- `404` — No pending preview found (may have expired or already been handled)

## Path Approvals

Path approvals control which local directories are mapped to which projects on the agent. These routes manage the `approved-paths.json` file.

### List Approvals

#### `GET /api/sync/approvals`

Returns the approved paths manifest. The `localPath` field is stripped from the response -- local paths never cross the network.

**Response (200):**

```json
{
  "version": 1,
  "entries": [
    {
      "projectId": "training-data",
      "approvedAt": "2026-03-24T10:00:00.000Z",
      "projectName": "training-data",
      "accessMode": "full",
      "confirmMode": "auto",
      "deleteThreshold": 10
    }
  ]
}
```

> **Note:** The `localPath` field is stored on the agent only and never included in API responses.

### Create/Update Approval

#### `POST /api/sync/approvals`

Add or update a path approval for a project.

**Request:**

```json
{
  "projectId": "training-data",
  "localPath": "/Users/me/training-data",
  "projectName": "training-data",
  "accessMode": "full",
  "confirmMode": "auto",
  "deleteThreshold": 10
}
```

**Required fields:** `projectId`, `localPath`, `projectName`

**Optional fields:**
- `accessMode` — one of `full`, `push-only`, `pull-only`, `protected` (default: `full`)
- `confirmMode` — one of `auto`, `confirm-destructive`, `confirm-always` (default: `auto`)
- `deleteThreshold` — maximum number of deletes before requiring confirmation (default: 10)

**Response (201):**

```json
{
  "ok": true,
  "projectId": "training-data"
}
```

**Errors:**
- `400` — Invalid local path

### Revoke Approval

#### `DELETE /api/sync/approvals/:projectId`

Remove the path approval for a project.

**Response (200):**

```json
{
  "ok": true
}
```

**Errors:**
- `404` — No approval found for this project

## Related Documentation

- [Projects API](projects.md) — project CRUD and sync endpoints
- [API Overview](overview.md) — authentication and error format
- [Configuring Storage](../02-guides/configuring-storage.md) — storage setup guide
- [Archiving Files](../02-guides/archiving-files.md) — archive workflow guide
