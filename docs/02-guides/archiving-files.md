# Archiving Files

> Move files to the cloud to free local disk space, leaving behind a tiny metadata stub — then restore when you need the files back.

## In Plain English

Archiving is Sync's "offload" feature. Think of it as packing a box, labeling it, and putting it in a storage unit. The box (your files) goes to the cloud. The label (the stub file) stays on your desk so you know what you stored and where.

## Step 1: Archive a Project

### Via CLI

```bash
sync archive
```

The CLI lists your projects and lets you pick one interactively. Or specify directly:

```bash
sync archive --project training-data --yes
```

### Via API

```bash
curl -X POST http://localhost:9393/api/sync/projects/training-data/archive \
  -H "Authorization: Bearer <api-key>"
```

Response:

```json
{
  "ok": true,
  "operationId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "archiving"
}
```

### What Happens

1. The server marks the project as "archiving"
2. The agent scans the local directory (file count, total size)
3. rclone moves all files to the cloud (`rclone move`)
4. A `.sync-stub.json` metadata file is created in the local directory
5. The agent reports savings to the server
6. Project status becomes "archived"

## Step 2: Check Archive Status

```bash
curl http://localhost:9393/api/sync/projects/training-data/status \
  -H "Authorization: Bearer <api-key>"
```

During archiving, the status shows progress. After completion:

```json
{
  "projectId": "training-data",
  "status": "archived"
}
```

## Step 3: View Savings

```bash
# Per-project savings
curl http://localhost:9393/api/sync/projects/training-data/savings \
  -H "Authorization: Bearer <api-key>"
```

```json
{
  "archivedFileCount": 1247,
  "archivedTotalBytes": 52428800000,
  "stubSizeBytes": 312,
  "bytesSaved": 52428799688,
  "lastArchivedAt": "2026-03-20T14:30:00Z"
}
```

```bash
# Global savings across all projects
curl http://localhost:9393/api/sync/savings \
  -H "Authorization: Bearer <api-key>"
```

## Step 4: Restore When Needed

### Via CLI

```bash
sync restore
```

Or:

```bash
sync restore --project training-data --yes
```

### Via API

```bash
curl -X POST http://localhost:9393/api/sync/projects/training-data/restore \
  -H "Authorization: Bearer <api-key>"
```

### What Happens

1. The agent downloads all files from the cloud (`rclone copy`)
2. The `.sync-stub.json` stub is removed
3. Project status returns to "synced"
4. The cloud copy is preserved (not deleted)

## The Stub File

After archiving, the local directory contains only `.sync-stub.json`:

```json
{
  "syncStub": true,
  "version": 1,
  "archivedAt": "2026-03-20T14:30:00Z",
  "remotePath": "projects/training-data",
  "provider": "spaces",
  "bucket": "my-sync",
  "projectId": "training-data",
  "totalSize": 52428800000,
  "fileCount": 1247
}
```

The stub is a few KB — your 50 GB folder becomes a tiny metadata file. For archives with 200 files or fewer, the stub also includes a `files` array listing every archived file.

## Constraints

| Rule | Reason |
| --- | --- |
| Cannot archive while syncing | Avoids conflicts (returns 409) |
| Cannot archive an archived project | Already archived |
| Only archived projects can be restored | Must be in "archived" status |
| Cloud copy preserved after restore | Safety — manual deletion if desired |

## Related Documentation

- [Archive & Restore](../01-concepts/archive-restore.md) — concept details
- [Managing Projects](managing-projects.md) — project CRUD
- [CLI Usage](cli-usage.md) — CLI commands
- [Storage & Archive API](../04-api-reference/storage-archive.md) — archive API reference
