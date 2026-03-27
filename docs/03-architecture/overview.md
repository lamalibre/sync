# System Architecture Overview

> Sync is an orchestration layer around rclone where a Fastify server manages projects and storage credentials, and polling agents execute sync operations with file watching, cron scheduling, and real-time progress reporting.

## In Plain English

Sync has three main pieces:

1. **The Sync Server** — a Fastify application that stores project definitions, encrypted storage credentials, sync history, and agent registry. In standalone mode it runs on its own. In plugin mode it runs inside Portlama.

2. **The Sync Agent** — a daemon on the machine with files to sync that polls the server for config, executes rclone operations, watches for file changes, runs scheduled syncs, and reports results back.

3. **The Admin Tools** — a CLI (and Portlama panel in plugin mode) that lets you manage projects, configure storage, trigger syncs, and view history.

These three pieces interact through a polling loop: the agent checks the server every 30 seconds for config changes, executes operations, and reports results. The server is the single source of truth for project definitions and credentials.

## System Diagram

```
                        ┌──────────────────────────────────────────────────┐
                        │  Server Machine (Mac / VPS / Portlama)           │
                        │                                                  │
  Admin                 │  ┌────────────────────────────────────────────┐  │
  (CLI)                 │  │  Sync Server (Fastify, port 9393)          │  │
       │                │  │                                            │  │
       │  HTTP          │  │  REST API                                  │  │
       ├───────────────►│  │  ├─ /api/sync/projects    (CRUD + sync)   │  │
       │                │  │  ├─ /api/sync/storage     (provider cfg)  │  │
       │                │  │  ├─ /api/sync/agents      (registry)      │  │
       │                │  │  ├─ /api/sync/status      (global)        │  │
       │                │  │  ├─ /api/sync/history     (operation log) │  │
       │                │  │  ├─ /api/sync/savings     (archive stats) │  │
       │                │  │  ├─ /api/sync/agent-config (agent pulls)  │  │
       │                │  │  └─ /api/sync/agent-report (agent posts)  │  │
       │                │  └────────────────────────────────────────────┘  │
       │                │                                                  │
       │                │  State: ~/.sync/                                  │
       │                │  ├─ sync-config.json     (storage, encrypted)    │
       │                │  ├─ projects.json        (project definitions)   │
       │                │  ├─ sync-history.json    (operation log)         │
       │                │  ├─ archive-savings.json (disk savings)          │
       │                │  ├─ agents.json          (agent registry)        │
       │                │  └─ master.key           (encryption key)        │
       │                └──────────────────────────────────────────────────┘
       │                            ▲
       │                            │  HTTP (poll 30s, heartbeat 15s)
       │                            │
       │                ┌───────────┴──────────────────────────────────────┐
       │                │  Agent Machine (macOS / Linux)                    │
       │                │                                                  │
       │                │  sync-agent                                      │
       │                │  ├── Poll /api/sync/agent-config (30s)           │
       │                │  ├── Generate rclone.conf from provider config   │
       │                │  ├── Execute rclone sync/bisync/move/copy        │
       │                │  ├── Watch files via chokidar (debounced)        │
       │                │  ├── Schedule syncs via node-cron                │
       │                │  ├── Parse rclone progress (real-time)           │
       │                │  ├── Report results to /api/sync/agent-report    │
       │                │  └── Heartbeat every 15s (disk usage)            │
       │                │                                                  │
       │                │  State: ~/.sync-agent/                           │
       │                │  ├─ agent-settings.json  (server URL, API key)   │
       │                │  ├─ cached-config.json   (encrypted cache)       │
       │                │  ├─ rclone.conf          (generated, 0600)       │
       │                │  ├─ master.key           (local encryption key)  │
       │                │  ├─ approved-paths.json  (project→path mapping)  │
       │                │  ├─ bisync-state.json    (per-project bisync)    │
       │                │  ├─ pending-syncs/       (sync preview state)    │
       │                │  ├─ exclude-filters/     (rclone exclude files)  │
       │                │  └─ .sync-trash/         (soft-delete trash)     │
       │                └──────────────────────────────────────────────────┘
       │
┌──────┴───────────────────────────┐
│  Admin Machine                    │
│                                  │
│  sync-cli                        │
│  ├── status                      │
│  ├── trigger [project]           │
│  ├── archive [project]           │
│  ├── restore [project]           │
│  ├── projects                    │
│  ├── config                      │
│  └── uninstall                   │
│                                  │
│  ~/.sync-cli/config.json         │
└──────────────────────────────────┘
```

## Component Roles

| Component | Technology | Role |
| --- | --- | --- |
| **Sync Server** | Fastify 5, Zod | REST API, project management, storage config, agent registry, history |
| **Sync Agent** | Node.js ESM, rclone, chokidar, node-cron, execa | Sync execution, file watching, scheduling, progress reporting |
| **Sync CLI** | @clack/prompts, picocolors | Admin command-line interface |
| **Create Sync** | esbuild bundled, zero deps | One-command installer (standalone + bundle) |
| **Sync Shared** | TypeScript | Shared types, atomic writes, rclone config builder, ignore resolver, approved paths, pending sync, error sanitization |

## Monorepo Structure

```
sync/
├── packages/
│   ├── sync-server/              ← Fastify REST API
│   │   └── src/
│   │       ├── index.ts          ← Standalone server entry
│   │       ├── server.ts         ← Fastify app factory, error handling
│   │       ├── routes/           ← REST endpoints (health, setup, storage, projects, sync, archive, status, agent, agents)
│   │       └── lib/              ← Business logic (plugin, auth, state, crypto, schemas)
│   │
│   ├── sync-agent/               ← Agent daemon
│   │   └── src/
│   │       ├── agent.ts          ← Main daemon (poll, diff, reconcile)
│   │       ├── index.ts          ← Entry point
│   │       └── lib/
│   │           ├── rclone-runner.ts   ← rclone sync/bisync/move/copy execution
│   │           ├── rclone-config.ts   ← rclone.conf generation
│   │           ├── file-watcher.ts    ← chokidar file watching with debounce
│   │           ├── scheduler.ts       ← node-cron scheduling
│   │           ├── archive.ts         ← Archive scan, stub generation, restore
│   │           ├── bisync-state.ts    ← Bisync baseline tracking
│   │           ├── dry-run-parser.ts  ← rclone --dry-run output parsing
│   │           ├── stub.ts            ← .sync-stub.json read/write
│   │           ├── trash-cleanup.ts   ← Periodic local + remote trash cleanup
│   │           ├── trash-paths.ts     ← Timestamped trash directory paths
│   │           ├── server-client.ts   ← HTTP communication with sync-server
│   │           ├── config.ts          ← Agent settings and config cache
│   │           ├── plugin-mode.ts     ← Portlama mTLS + ticket auth
│   │           └── progress-parser.ts ← rclone stderr progress parsing
│   │
│   ├── sync-cli/                 ← Admin CLI
│   │   └── src/
│   │       ├── index.ts          ← Entry point and command dispatch
│   │       └── commands/         ← status, trigger, archive, restore, config, projects,
│   │                                project-delete, project-restore, trash-list,
│   │                                trash-restore, trash-purge, agent-approve, preview, uninstall
│   │
│   ├── sync-shared/              ← Shared utilities
│   │   └── src/
│   │       ├── types.ts           ← Domain types (provider, direction, strategy, trigger, status)
│   │       ├── atomic-write.ts    ← Atomic file write (temp → fsync → rename)
│   │       ├── rclone-config.ts   ← buildRcloneIni(), buildCryptIni()
│   │       ├── rclone-defaults.ts ← Default rclone transfer settings
│   │       ├── cli-config.ts      ← CLI config encryption/decryption
│   │       ├── ignore-resolver.ts ← 5-layer ignore resolution (.gitignore, .syncignore, etc.)
│   │       ├── ignore-file-writer.ts ← Atomic rclone --exclude-from file writer
│   │       ├── approved-paths.ts  ← Agent path approval, access modes, confirm modes
│   │       ├── pending-sync.ts    ← Sync preview/confirm state management
│   │       └── sanitize-error.ts  ← Credential redaction from rclone errors
│   │
│   └── create-sync/              ← npx installer
│       └── src/lib/
│           ├── provider-setup.ts    ← Storage provider setup wizard
│           ├── bundle.ts            ← Portlama config bundle setup
│           ├── service-installer.ts ← launchd / systemd generation
│           └── detect-rclone.ts     ← Platform + rclone detection
│
├── tests/
│   └── e2e/                      ← E2E tests (two-VM setup)
│
└── docs/                         ← This documentation
```

## Data Flows

### Agent Polling Loop

```
1. Agent starts
   └── Reads agent-settings.json (server URL, API key, agent ID)
   └── Registers with server: POST /api/sync/agents

2. Every 30 seconds: poll
   └── GET /api/sync/agent-config
   └── Returns: provider config (credentials) + project list
   └── Agent diffs against previous config

3. Config diff triggers reconciliation
   └── New project → generate rclone.conf, start watcher, set up cron
   └── Updated project → update watcher/cron, regenerate rclone.conf
   └── Deleted project → stop watcher, remove cron, clean up state

4. Every 15 seconds: heartbeat
   └── POST /api/sync/agents/:id/heartbeat
   └── Body: activeSyncs[], diskUsage { totalBytes, freeBytes, usedBytes }
```

### Sync Execution

```
1. Trigger fires (watch, cron, or manual API call)
   └── Server creates ActiveOperation (in-memory)
   └── Project status → "syncing"

2. Agent runs rclone
   └── Builds command: rclone sync|bisync|move|copy
   └── Adds flags: --config, --transfers, --checkers, --bwlimit, --exclude
   └── Starts execa process with array arguments
   └── Parses stderr progress in real-time

3. rclone completes
   └── Agent POST /api/sync/agent-report
   └── Body: operationId, status, bytes, files, duration, errors, conflicts
   └── Server clears ActiveOperation, updates history, updates project status

4. If error
   └── Project status → "error"
   └── Error message stored in history entry
```

## Design Decisions

### Why polling instead of WebSocket push?

The agent polls the server every 30 seconds. A WebSocket would deliver config changes instantly, but adds connection management complexity, reconnection logic, and bidirectional state. At a 30-second poll interval, the delay is acceptable — most syncs are triggered by file watching or cron, not by config changes.

### Why rclone instead of direct S3/cloud SDKs?

Direct SDK calls would require implementing each provider's API, handling authentication differences, delta detection, retry logic, and bandwidth management. rclone handles all of this for 40+ providers. Sync's job is orchestration, not file transfer.

### Why per-project isolation?

Each project has its own watcher, scheduler, and sync state. A stuck sync (network timeout, large directory) on project A runs in its own async context and cannot block project B. This is critical for reliability — one misbehaving project should not take down the entire agent.

### Why JSON files instead of a database?

At this scale (a handful of projects, a few agents), a database adds a process dependency and migration complexity for no benefit. JSON files with atomic writes provide crash-safe persistence.

## Key Files

| File | Role |
| --- | --- |
| `~/.sync/sync-config.json` | Storage provider config (encrypted credentials) |
| `~/.sync/projects.json` | Project definitions |
| `~/.sync/sync-history.json` | Sync operation log (last 100 per project) |
| `~/.sync/archive-savings.json` | Archive disk savings tracker |
| `~/.sync/agents.json` | Agent registry (IDs, heartbeats, project assignments) |
| `~/.sync/master.key` | Encryption master key (32-byte hex) |
| `~/.sync-agent/agent-settings.json` | Agent config (server URL, API key) |
| `~/.sync-agent/rclone.conf` | Generated rclone config (credentials, mode 0600) |
| `~/.sync-agent/cached-config.json` | Encrypted config cache (offline resilience) |
| `~/.sync-agent/approved-paths.json` | Project-to-local-path mapping with access/confirm modes |
| `~/.sync-agent/bisync-state.json` | Per-project bisync baseline + conflict tracking |
| `~/.sync-agent/exclude-filters/` | Generated rclone `--exclude-from` files per project |
| `~/.sync-agent/pending-syncs/` | Pending sync previews awaiting approval |
| `~/.sync-agent/.sync-trash/` | Soft-delete trash (local side) |

## Related Documentation

- [Sync Server](sync-server.md) — server architecture in detail
- [Sync Agent](sync-agent.md) — agent daemon internals
- [State Management](state-management.md) — file formats and concurrency
- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs plugin
