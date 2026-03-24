# What is Sync?

> Sync is a file synchronization and cloud archive tool for self-hosters that uses rclone to sync files bidirectionally with 40+ cloud storage providers, with an iCloud-style archive/restore workflow for offloading files to the cloud and freeing local disk space.

## In Plain English

Imagine your laptop is running low on disk space. You have a folder of old training data — 50 GB — that you rarely need but cannot delete. The usual options are an external hard drive (which you lose or forget) or a cloud backup (which you set up once and never check again until it fails silently).

Sync takes a different approach. You tell it: "keep this folder in sync with my DigitalOcean Spaces bucket." It watches for changes and syncs them automatically. When you need disk space, you archive the folder — Sync moves the files to the cloud and replaces them with a tiny metadata stub that says "your files are here, here is how big they are, here is when they were archived." When you need the files back, you restore — Sync downloads them from the cloud and removes the stub.

The sync engine is rclone — a battle-tested tool that handles 40+ storage providers, delta transfers (only changed bytes move), client-side encryption, and bandwidth throttling. Sync does not implement file transfer. It orchestrates rclone with a REST API, a file-watching agent, cron scheduling, and per-project isolation.

Sync runs in two modes: standalone (your own server on port 9393) or as a Portlama plugin (runs inside Portlama's existing server, using Portlama's certificates and agent registry).

## For Users

Sync solves the problem of keeping files synchronized between local machines and cloud storage, with the option to offload files when disk space is tight. Here is what you get:

**What it does:**

- Syncs files bidirectionally between local directories and cloud storage via rclone
- Archives entire folders to the cloud, replacing them with tiny metadata stubs (iCloud-style offload)
- Restores archived files on demand — download from cloud, remove stub
- Watches for file changes and syncs automatically (chokidar + debounce)
- Schedules syncs via cron expressions (hourly, daily, custom)
- Encrypts files before they leave your machine (rclone crypt, NaCl SecretBox)
- Throttles bandwidth per-project or globally
- Detects and resolves conflicts in bidirectional sync (newest-wins, local-wins, remote-wins, manual)

**What you need:**

- A server machine (your Mac, a VPS, or a Portlama instance) to run the sync server
- One or more machines with files to sync (macOS or Linux) running the sync agent
- Node.js 22+ on all machines
- rclone installed on agent machines
- A cloud storage account (DigitalOcean Spaces, AWS S3, Google Cloud Storage, Azure Blob, Backblaze B2, or any S3-compatible provider)

**Two ways to deploy:**

| Mode | Server | Use case |
| --- | --- | --- |
| **Standalone** | Own Fastify server on port 9393 | Self-contained sync server on your LAN or VPS |
| **Plugin** | Runs inside Portlama | Sync through Portlama's existing relay and certificates |

**Key design choices:**

- rclone is the only sync engine — no custom file transfer code, ever
- Per-project isolation — a stuck sync on project A does not block project B
- Archive stubs are tiny (KB) — metadata only, not data copies
- Credentials encrypted at rest — AES-256-GCM with a random master key
- Atomic file writes — all state files use temp → fsync → rename

## For Developers

Sync is a monorepo with five packages:

| Package | Technology | Purpose |
| --- | --- | --- |
| `sync-server` | Fastify 5, Zod | REST API (standalone + plugin), project management, storage config |
| `sync-agent` | Node.js ESM, rclone, chokidar, node-cron, execa | Agent daemon (sync execution, file watching, scheduling) |
| `sync-cli` | @clack/prompts, picocolors | CLI tool (status, trigger, archive, restore, config) |
| `create-sync` | esbuild bundled, zero deps | npx installer (standalone + bundle setup) |
| `sync-shared` | TypeScript | Shared types, atomic writes, rclone config builder, rclone defaults |

**Architecture summary:**

```
Admin (CLI / Desktop)
    │
    │  HTTP
    ▼
Sync Server (Fastify, :9393)
  ├── REST API (projects, storage, sync triggers, agent registry)
  ├── Storage config (encrypted credentials at rest)
  └── Sync history and archive savings tracking
    ▲
    │  HTTP (polling every 30s)
    │
Sync Agent (daemon)
  ├── Polls /api/sync/agent-config for project + storage config
  ├── Executes rclone sync / bisync / move / copy
  ├── Watches files via chokidar (debounced)
  ├── Schedules syncs via node-cron
  ├── Reports results to /api/sync/agent-report
  └── Sends heartbeats every 15s
```

State is stored in JSON files with atomic writes (temp → fsync → rename). No database.

## Quick Reference

| Item | Value |
| --- | --- |
| **Install command** | `npx @lamalibre/create-sync` |
| **Default port** | 9393 (standalone) |
| **Auth (standalone)** | API key (admin) + Bearer token (agents) |
| **Auth (plugin)** | Portlama mTLS certificates |
| **Sync engine** | rclone (40+ providers) |
| **Sync directions** | push, pull, bidirectional |
| **Sync triggers** | manual, watch (chokidar), schedule (cron), watch+schedule |
| **Archive format** | `.sync-stub.json` metadata file |
| **Encryption** | rclone crypt (NaCl SecretBox + EME filename encryption) |
| **State storage** | JSON files (no database) |
| **Target OS** | macOS (launchd), Linux (systemd) |
| **License** | PolyForm Noncommercial 1.0.0 |
