# State Management

> All Sync state is stored in JSON files with atomic writes and promise-chain patterns for concurrency control. No database is required.

## Design Philosophy

Sync stores state in flat JSON files rather than a database. At this scale — a handful of projects, a few agents — a database adds a process dependency, migration complexity, and operational overhead for no benefit.

Every write follows the **atomic rename pattern**: write to a temp file, fsync, rename into place. This ensures that a crash mid-write never corrupts the file — the old content remains intact until the rename succeeds.

## Server-Side Files (`~/.sync/`)

### `sync-config.json`

Storage provider configuration with encrypted credentials.

```json
{
  "port": 9393,
  "dataDir": "/Users/admin/.sync",
  "storage": {
    "provider": "spaces",
    "endpoint": "https://ams3.digitaloceanspaces.com",
    "bucket": "my-sync",
    "region": null,
    "accessKeyEncrypted": "base64(salt||iv||authTag||ciphertext)",
    "secretKeyEncrypted": "base64(salt||iv||authTag||ciphertext)",
    "encryption": true,
    "encryptionPasswordEncrypted": "base64(salt||iv||authTag||ciphertext)"
  },
  "lastTested": "2026-03-24T10:00:00.000Z",
  "testResult": "ok",
  "apiKeyHash": "sha256hex...",
  "softDelete": { "enabled": true, "retentionDays": 90, "cleanupSchedule": "0 3 * * *" }
}
```

- **Mode:** `0600`
- **Encryption:** Credentials encrypted with AES-256-GCM (scrypt key derivation from master key)
- **API key:** Stored as SHA-256 hash (raw key shown once during setup)

### `projects.json`

Project definitions.

```json
{
  "projects": [
    {
      "id": "training-data",
      "name": "training-data",
      "localPath": "/home/user/data/training",
      "remotePath": "projects/training-data",
      "direction": "bidirectional",
      "includes": [],
      "excludes": [".DS_Store", "*.tmp", "__pycache__"],
      "schedule": "0 */6 * * *",
      "encrypted": true,
      "encryptionPasswordEncrypted": "base64(...)",
      "conflictStrategy": "newest-wins",
      "watch": true,
      "trigger": "watch+schedule",
      "watchDebounceMs": 5000,
      "bandwidthLimit": "10M",
      "softDelete": { "enabled": true, "retentionDays": 90, "cleanupSchedule": "0 3 * * *" },
      "deletedAt": null,
      "status": "synced",
      "lastSync": "2026-03-24T10:30:00.000Z",
      "createdAt": "2026-03-20T09:00:00.000Z",
      "updatedAt": "2026-03-24T10:30:00.000Z"
    }
  ]
}
```

- **Status values:** `synced`, `syncing`, `local-only`, `cloud-only`, `archived`, `error`
- **Soft delete:** Projects have a `deletedAt` field (ISO timestamp or `null`). Soft-deleted projects are filtered from normal queries but remain in the file. Hard delete splices them from the array.
- **Encryption passwords:** Stored encrypted (same scheme as storage credentials)

### `sync-history.json`

Sync operation log (last 100 per project).

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

- **Pruning:** Oldest entries pruned beyond 100 per project
- **Status values:** `pending`, `running`, `completed`, `error`

### `archive-savings.json`

Per-project archive disk savings.

```json
{
  "savings": [
    {
      "projectId": "training-data",
      "archivedFileCount": 1247,
      "archivedTotalBytes": 52428800000,
      "stubSizeBytes": 312,
      "bytesSaved": 52428799688,
      "lastArchivedAt": "2026-03-20T14:30:00Z"
    }
  ]
}
```

- Updated when agent reports archive result
- Cleared when project is restored

### `agents.json`

Agent registry.

```json
{
  "agents": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "office-mac",
      "hostname": "office-mac.local",
      "os": "darwin",
      "osVersion": "25.1.0",
      "nodeVersion": "22.0.0",
      "agentVersion": "0.1.0",
      "projectIds": ["training-data", "documents"],
      "lastHeartbeat": "2026-03-24T10:30:15.000Z",
      "registeredAt": "2026-03-20T09:00:00.000Z",
      "activeSyncs": [],
      "diskUsage": {
        "totalBytes": 500000000000,
        "freeBytes": 200000000000,
        "usedBytes": 300000000000
      }
    }
  ]
}
```

- **Online/offline:** Agent is online if `lastHeartbeat` is within 30 seconds of now
- **Project assignment:** `projectIds` controls which projects the agent receives

### `master.key`

Random 32-byte hex string used to derive encryption keys.

- Created on first run
- Mode `0600`
- Never transmitted, never rotated
- Loss = need to reconfigure credentials (not data loss unless encryption passwords also lost)

## Agent-Side Files (`~/.sync-agent/`)

### `agent-settings.json`

Agent configuration.

```json
{
  "serverUrl": "http://192.168.1.100:9393",
  "apiKey": "sync_a1b2c3d4...",
  "pollIntervalMs": 30000,
  "agentId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agentName": "office-mac",
  "agentToken": "..."
}
```

- Mode `0600`

### `cached-config.json`

Encrypted cache of the latest server config.

- Full config from `/api/sync/agent-config` (provider + projects, including credentials)
- Encrypted with AES-256-GCM using agent's master key
- Updated on every successful poll
- Used as fallback during server downtime

### `rclone.conf`

Generated rclone configuration.

- Contains provider remote section + optional crypt overlay sections
- Credentials in rclone's format (provider-specific field names)
- Mode `0600`
- Recreated on every poll cycle (idempotent)

### `sync-state.json`

Per-project sync tracking.

- Last sync time per project
- Whether bisync `--resync` has been run (first-run tracking)
- Used for delta detection during offline periods

### `master.key`

Agent's local encryption master key (same format as server's).

## Active Operations (In-Memory)

The server maintains ephemeral state for operations in progress:

```
activeOperations: Map<projectId, ActiveOperation>
```

This state is not persisted. On server restart, active operations are lost. The agent detects missing operations on its next poll and re-reports if needed.

## Atomic Write Pattern

All JSON files use the shared `atomicWriteFile()` utility:

```javascript
async function atomicWriteFile(filePath, data, mode) {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, data, { mode: mode ?? 0o644 });
  const fd = await open(tmpPath, 'r');
  await fd.sync();     // fsync ensures data reaches disk
  await fd.close();
  await rename(tmpPath, filePath);  // atomic on same filesystem
}
```

Note: callers pass `0o600` explicitly for sensitive files (credentials, keys). The default mode is `0o644`.

The `rename` is atomic on the same filesystem — the file appears at its final path in a single operation. No reader can ever see a partially written file.

## Related Documentation

- [Sync Server](sync-server.md) — server architecture
- [Sync Agent](sync-agent.md) — agent file layout
- [Config Files](../05-reference/config-files.md) — quick reference table
- [Security Model](../01-concepts/security-model.md) — file permissions
