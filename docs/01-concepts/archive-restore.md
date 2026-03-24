# Archive & Restore

> Sync's archive workflow moves files to the cloud and replaces them with a tiny metadata stub — like iCloud's "Offload" feature — freeing local disk space while keeping a record of what was archived and how to get it back.

## In Plain English

Imagine your laptop has 50 GB of old project files you rarely open but cannot delete. iCloud solves this by offloading files to the cloud and replacing them with placeholders. When you double-click a placeholder, the file downloads on demand.

Sync does the same thing, but for any folder and any cloud provider. You archive a project — Sync moves all files to your cloud bucket and replaces the entire folder with a single metadata file (the stub). The stub is a few KB and says: "your 1247 files totaling 50 GB are in bucket X at path Y, archived on this date." When you need the files back, you restore — Sync downloads everything from the cloud and removes the stub.

The key difference from a simple backup: the stub is tiny. Your 50 GB folder becomes a few KB on disk. The files are not deleted — they are moved to the cloud where you control them.

## For Users

### The Archive Workflow

**Step 1: Archive**

```bash
sync archive
# Or via API:
# POST /api/sync/projects/:id/archive
```

What happens:
1. Agent scans the local directory (file count, total size)
2. Agent runs `rclone move` to upload all files to the cloud
3. Agent creates `.sync-stub.json` in the local directory
4. Agent reports savings to the server
5. Project status changes to "archived"

**Step 2: The Stub**

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

For small archives (200 files or fewer), the stub also includes a `files` array listing every archived file with its path, size, and modification time. For larger archives, the `files` array is omitted to keep the stub small (KB, not MB).

**Step 3: Restore**

```bash
sync restore
# Or via API:
# POST /api/sync/projects/:id/restore
```

What happens:
1. Agent runs `rclone copy` to download all files from the cloud
2. Agent removes `.sync-stub.json`
3. Project status returns to "synced"

Note: `rclone copy` is used (not `rclone move`) — the cloud copy is preserved. This is intentional. If the restore fails halfway, the cloud copy is still intact. You can safely delete the remote copy separately if needed.

### Viewing Savings

Check how much disk space archiving has saved:

```bash
# Global savings across all projects
curl http://localhost:9393/api/sync/savings \
  -H "Authorization: Bearer <api-key>"

# Per-project savings
curl http://localhost:9393/api/sync/projects/:id/savings \
  -H "Authorization: Bearer <api-key>"
```

Response:

```json
{
  "archivedFileCount": 1247,
  "archivedTotalBytes": 52428800000,
  "stubSizeBytes": 312,
  "bytesSaved": 52428799688,
  "lastArchivedAt": "2026-03-20T14:30:00Z"
}
```

### Constraints

- A project that is currently syncing cannot be archived (returns 409)
- A project that is already archived cannot be archived again
- Only archived projects can be restored
- Archive stubs must be small — the stub is metadata, not a data copy
- The agent does not hold the entire file tree in memory during scan (streaming/batched stat)

## For Developers

### Archive Implementation

The agent's archive flow:

```
1. Receive archive operation from server poll
   └── /api/sync/agent-config returns project with pending archive

2. Scan local directory
   └── Walk directory tree with batched stat() calls
   └── Skip hidden files (starting with .)
   └── Skip .sync-stub.json
   └── Skip symlinks
   └── Collect: total file count, total bytes

3. rclone move
   └── execa('rclone', ['move', localPath, remotePath,
       '--delete-empty-src-dirs',
       '--exclude', '.sync-stub.json',
       ...standardFlags])

4. Generate stub
   └── Build .sync-stub.json with metadata
   └── If fileCount <= 200: include files[] array
   └── If fileCount > 200: omit files[] (keep stub small)
   └── Atomic write to <localPath>/.sync-stub.json

5. Report to server
   └── POST /api/sync/agent-report
   └── { type: "archive", spaceFreed: totalBytes, fileCount, ... }
```

### Restore Implementation

```
1. rclone copy (not move — preserve cloud copy)
   └── execa('rclone', ['copy', remotePath, localPath, ...standardFlags])

2. Remove stub
   └── fs.unlink(<localPath>/.sync-stub.json)

3. Report to server
   └── POST /api/sync/agent-report
   └── { type: "restore", ... }
```

### Savings Tracking

The server maintains `archive-savings.json` with per-project savings:

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

Updated when the agent reports an archive result. Cleared when the project is restored.

### Why rclone move for Archive, rclone copy for Restore?

**Archive uses `rclone move`** because the goal is to free local disk space. Move uploads and then deletes the local copy. `--delete-empty-src-dirs` cleans up empty directories left behind.

**Restore uses `rclone copy`** because the goal is to get files back safely. If the download fails halfway, the cloud copy is still intact. A move would delete cloud files as they download — a network error could lose files from both sides.

## Quick Reference

| Item | Value |
| --- | --- |
| **Archive command** | `rclone move` (local → cloud, deletes local) |
| **Restore command** | `rclone copy` (cloud → local, preserves cloud) |
| **Stub file** | `.sync-stub.json` in project's local directory |
| **Stub size** | A few KB (metadata only) |
| **File list in stub** | Included if ≤ 200 files, omitted if > 200 |
| **Cloud files after restore** | Preserved (not deleted) |

## Related Documentation

- [Sync Engine](sync-engine.md) — rclone operations in detail
- [Managing Projects](../02-guides/managing-projects.md) — creating projects with archive support
- [Archiving Files](../02-guides/archiving-files.md) — step-by-step guide
- [Storage & Archive API](../04-api-reference/storage-archive.md) — archive and savings endpoints
