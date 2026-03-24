# How It Works

> Sync orchestrates rclone to keep local directories in sync with cloud storage, using a polling agent that watches for file changes, schedules syncs, and reports results back to a central server.

## In Plain English

Picture a diligent assistant who sits on your computer and watches a folder. When you change a file, the assistant notices. It waits a few seconds (in case you are making more changes), then calls rclone to push the changes to the cloud. If you scheduled a daily sync, the assistant runs it at the right time. If you ask it to archive the folder, it moves everything to the cloud and leaves a note saying "your files are in bucket X, they were 50 GB, here is how to get them back."

That assistant is the Sync Agent. It runs as a daemon on your machine.

The Sync Server is the coordinator. It stores your project definitions ("sync this folder to that bucket"), your storage credentials (encrypted), and the history of every sync operation. The agent polls the server every 30 seconds for its config. If you change a project's schedule or add a new project, the agent picks it up on the next poll.

The CLI and desktop app talk to the server's REST API. When you trigger a sync from the CLI, the server marks the project as "syncing" and the agent picks it up. When the sync completes, the agent reports back: how many files, how many bytes, how long it took, any errors.

### Why rclone?

Sync does not implement file transfer. Here is why:

- **40+ providers** — S3, Spaces, GCS, Azure, B2, any S3-compatible endpoint, local disk. Adding a provider means adding a config template, not a protocol implementation.
- **Delta sync** — rclone compares checksums and timestamps, transferring only changed bytes. No need to build content-addressable storage.
- **Bidirectional sync** — `rclone bisync` handles two-way sync with conflict detection. Building this from scratch would take months.
- **Client-side encryption** — `rclone crypt` encrypts file contents and names before upload. NaCl SecretBox for content, EME wide-block for filenames.
- **Bandwidth throttling** — `--bwlimit` with time-of-day support, handled natively.
- **Battle-tested** — millions of users, thousands of edge cases already handled.

## For Users

### The Big Picture

Sync has three participants that work together:

**1. The Sync Server (coordinator)**

The server sits at the center. In standalone mode, it runs on your Mac or a VPS on port 9393. In plugin mode, it runs inside Portlama.

The server does four things:
- Stores project definitions (which folders to sync, where, how often)
- Stores storage credentials (encrypted at rest with AES-256-GCM)
- Tracks sync history and archive savings
- Manages the agent registry (multi-agent support)

**2. The Sync Agent (worker)**

The agent is a daemon running on the machine with the files. It:
- Polls the server every 30 seconds for config changes
- Executes rclone operations (sync, bisync, move, copy)
- Watches local directories for changes (chokidar with debounce)
- Runs scheduled syncs via cron
- Reports results back to the server
- Sends heartbeats every 15 seconds with disk usage

**3. The Admin (you)**

You use the CLI or Portlama panel to:
- Configure storage providers (credentials, bucket, region)
- Create and manage sync projects
- Trigger manual syncs, archives, and restores
- View sync history and archive savings

### Data Flow: How a Sync Works

```
1. Admin creates project "training-data"
   └── POST /api/sync/projects
   └── Server stores: localPath=/home/user/data, remotePath=training-data,
       direction=bidirectional, watch=true, schedule="0 */6 * * *"

2. Agent polls server (every 30s)
   └── GET /api/sync/agent-config
   └── Agent detects new project, generates rclone.conf,
       starts file watcher, sets up cron schedule

3. File change detected (or cron fires, or manual trigger)
   └── Agent debounces changes (5 seconds)
   └── Calls rclone bisync with:
       - source: /home/user/data
       - dest: sync-remote:bucket/training-data
       - --transfers=4, --checkers=8, --stats=2s
       - --bwlimit (if configured)
   └── Parses progress from rclone stderr in real-time

4. Sync completes
   └── Agent POST /api/sync/agent-report
   └── Server records: 42 files, 1.2 GB, 45 seconds, 0 errors
   └── Project status → "synced"
```

### Data Flow: How an Archive Works

```
1. Admin archives project "training-data"
   └── POST /api/sync/projects/:id/archive

2. Agent picks up archive operation
   └── Scans local directory: 1247 files, 50 GB
   └── rclone move /home/user/data → sync-remote:bucket/training-data
   └── Creates .sync-stub.json:
       {
         "syncStub": true,
         "version": 1,
         "archivedAt": "2026-03-20T14:30:00Z",
         "remotePath": "training-data",
         "provider": "spaces",
         "bucket": "my-sync",
         "projectId": "training-data",
         "totalSize": 52428800000,
         "fileCount": 1247
       }
   └── Reports result: 50 GB freed

3. Local directory now contains only .sync-stub.json (a few KB)
   └── Project status → "archived"

4. Admin restores when needed
   └── POST /api/sync/projects/:id/restore
   └── Agent: rclone copy sync-remote:bucket/training-data → /home/user/data
   └── Removes .sync-stub.json
   └── Project status → "synced"
```

### Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│  Server Machine (Mac / VPS / Portlama)                               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Sync Server (Fastify, port 9393)                              │  │
│  │                                                                │  │
│  │  REST API                                                      │  │
│  │  ├─ /api/sync/projects         (CRUD, sync triggers)          │  │
│  │  ├─ /api/sync/storage          (provider config)              │  │
│  │  ├─ /api/sync/agents           (agent registry)               │  │
│  │  ├─ /api/sync/status           (global + per-project)         │  │
│  │  ├─ /api/sync/history          (sync operation log)           │  │
│  │  ├─ /api/sync/savings          (archive savings)              │  │
│  │  ├─ /api/sync/agent-config     (agent pulls config)           │  │
│  │  └─ /api/sync/agent-report     (agent posts results)          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  State: ~/.sync/                                                     │
│  ├─ sync-config.json     (storage config, encrypted credentials)     │
│  ├─ projects.json        (project definitions)                       │
│  ├─ sync-history.json    (operation log)                             │
│  ├─ archive-savings.json (disk savings tracker)                      │
│  ├─ agents.json          (agent registry)                            │
│  └─ master.key           (encryption master key)                     │
└──────────────────────────────────────────────────────────────────────┘
         ▲
         │  HTTP (polling every 30s, heartbeat every 15s)
         │
┌────────┴─────────────────────────────────────────────────────────────┐
│  Agent Machine (macOS / Linux)                                       │
│                                                                      │
│  sync-agent                                                          │
│  ├── Poll /api/sync/agent-config (30s)                               │
│  ├── Generate rclone.conf from provider config                       │
│  ├── Execute rclone sync / bisync / move / copy                      │
│  ├── Watch files via chokidar (debounced)                            │
│  ├── Schedule syncs via node-cron                                    │
│  ├── Parse rclone progress in real-time                              │
│  ├── Report results to /api/sync/agent-report                        │
│  └── Heartbeat every 15s (disk usage, active syncs)                  │
│                                                                      │
│  State: ~/.sync-agent/                                               │
│  ├─ agent-settings.json  (server URL, API key, agent ID)             │
│  ├─ cached-config.json   (encrypted config cache)                    │
│  ├─ rclone.conf          (generated, mode 0600)                      │
│  ├─ master.key           (local encryption key)                      │
│  └─ sync-state.json      (per-project sync state)                    │
└──────────────────────────────────────────────────────────────────────┘
```

## For Developers

### Architecture Philosophy

Sync follows three core principles:

1. **rclone does the heavy lifting.** Sync never implements file transfer, checksum comparison, or protocol-level storage access. All data movement goes through rclone. Adding a storage provider means adding a config template, not a protocol implementation.

2. **Per-project isolation.** Each project has its own sync state, its own file watcher, its own cron schedule, and its own rclone invocation. A stuck sync on project A runs in its own async context and cannot block project B.

3. **No database.** State is stored in JSON files with atomic writes (temp → fsync → rename). At this scale — a handful of projects, a few agents — a database adds complexity for no benefit. A promise-chain pattern serializes concurrent writes.

### Technology Choices Explained

| Choice | Why | Alternatives Considered |
| --- | --- | --- |
| rclone for sync | 40+ providers, delta sync, bisync, crypt, bandwidth throttle; battle-tested | rsync (no cloud providers), syncthing (P2P, no archive), custom S3 client (one provider) |
| chokidar for file watching | Cross-platform, native OS events, glob ignore patterns, write-finish detection | fs.watch (inconsistent events), watchman (external binary) |
| node-cron for scheduling | Lightweight, standard cron syntax, no external dependencies | system crontab (requires root), node-schedule (heavier API) |
| execa for shell commands | Array arguments (no injection), TypeScript types, streaming stderr | child_process (string concatenation risk), shelljs (sync) |
| Fastify for server | Fast, schema-first validation, plugin system for dual-mode | Express (slower, no plugin system), Hono (less ecosystem) |
| JSON files for state | Simple, no daemon, atomic writes, crash-safe | SQLite (adds dependency), PostgreSQL (overkill at this scale) |
| AES-256-GCM for credentials | Authenticated encryption, standard, built into Node.js crypto | libsodium (external dependency), NaCl (less ecosystem) |

### Related Documentation

- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs plugin mode
- [Sync Engine](../01-concepts/sync-engine.md) — rclone integration details
- [Archive & Restore](../01-concepts/archive-restore.md) — offload workflow
- [Security Model](../01-concepts/security-model.md) — credential security
- [System Overview](../03-architecture/overview.md) — monorepo structure and component roles
- [Glossary](../05-reference/glossary.md) — term definitions
