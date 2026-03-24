# Quick Start

> From zero to first sync in 10 minutes — standalone mode with DigitalOcean Spaces.

## In Plain English

This guide sets up Sync as a standalone server on your Mac (or Linux machine), connects it to a DigitalOcean Spaces bucket, creates your first sync project, and watches it sync files automatically. By the end, you have a working bidirectional sync between a local folder and the cloud.

The same steps work for AWS S3, Google Cloud Storage, Azure Blob, Backblaze B2, or any S3-compatible provider — just pick a different provider during storage setup.

## Prerequisites

- **Node.js 22+** on the machine
- **rclone** installed (`brew install rclone` on macOS, or [rclone.org/install](https://rclone.org/install/))
- A **DigitalOcean Spaces** bucket (or any supported provider)
  - Access key and secret key from your DigitalOcean control panel

## Step 1: Install the Server

```bash
npx @lamalibre/create-sync
```

The installer runs interactively:

1. Detects your platform (macOS or Linux)
2. Verifies rclone is installed
3. Creates `~/.sync/` (server state directory)
4. Generates a master encryption key
5. Starts the server temporarily on port 9393
6. Generates an API key (printed once — save it)
7. Walks you through storage provider setup
8. Optionally creates your first project
9. Installs a system service (launchd on macOS, systemd on Linux)

At the end, the installer prints:
- The server URL (`http://localhost:9393`)
- Your API key
- Instructions for enrolling agents on other machines

## Step 2: Configure Storage

If you skipped storage setup during installation, configure it now:

```bash
sync config
```

Or via the API:

```bash
curl -X PATCH http://localhost:9393/api/sync/storage \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "spaces",
    "endpoint": "https://ams3.digitaloceanspaces.com",
    "bucket": "my-sync-bucket",
    "accessKey": "<your-access-key>",
    "secretKey": "<your-secret-key>",
    "encryption": false
  }'
```

Test the connection:

```bash
curl -X POST http://localhost:9393/api/sync/storage/test \
  -H "Authorization: Bearer <your-api-key>"
```

Response:

```json
{
  "ok": true,
  "latency": 245,
  "message": "Connection successful. Bucket is accessible."
}
```

## Step 3: Create a Project

```bash
curl -X POST http://localhost:9393/api/sync/projects \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "training-data",
    "localPath": "/home/user/data/training",
    "direction": "bidirectional",
    "watch": true,
    "trigger": "watch+schedule",
    "schedule": "0 */6 * * *",
    "excludes": [".DS_Store", "*.tmp", "__pycache__"]
  }'
```

This creates a project that:
- Watches `/home/user/data/training` for changes (syncs after 5s of quiet)
- Runs a full bidirectional sync every 6 hours
- Excludes macOS metadata, temp files, and Python cache

## Step 4: Trigger Your First Sync

```bash
curl -X POST http://localhost:9393/api/sync/projects/training-data/sync \
  -H "Authorization: Bearer <your-api-key>"
```

Check status:

```bash
curl http://localhost:9393/api/sync/projects/training-data/status \
  -H "Authorization: Bearer <your-api-key>"
```

```json
{
  "projectId": "training-data",
  "status": "syncing",
  "activeOperation": {
    "type": "sync",
    "transferred": 52428800,
    "totalSize": 104857600,
    "speed": 10485760,
    "eta": 5,
    "filesTransferred": 21,
    "filesTotal": 42
  }
}
```

## Step 5: Check History

```bash
curl http://localhost:9393/api/sync/history?projectId=training-data \
  -H "Authorization: Bearer <your-api-key>"
```

```json
{
  "operations": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "projectId": "training-data",
      "type": "sync",
      "direction": "bidirectional",
      "trigger": "manual",
      "status": "completed",
      "startedAt": "2026-03-24T10:30:00.000Z",
      "completedAt": "2026-03-24T10:30:45.000Z",
      "duration": 45,
      "bytesTransferred": 104857600,
      "filesTransferred": 42,
      "errors": 0
    }
  ]
}
```

## Using the CLI Instead

The CLI provides an interactive interface for all operations:

```bash
# Check sync status
sync status

# Trigger a sync interactively
sync trigger

# Archive a project (free disk space)
sync archive

# Restore archived files
sync restore

# List projects
sync projects
```

## What's Next

- [Configuring Storage](../02-guides/configuring-storage.md) — set up other providers (S3, GCS, Azure, B2)
- [Managing Projects](../02-guides/managing-projects.md) — scheduling, encryption, bandwidth limits
- [Archiving Files](../02-guides/archiving-files.md) — the iCloud-style offload workflow
- [Agent Enrollment](../02-guides/agent-enrollment.md) — sync files on remote machines
- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs Portlama plugin
