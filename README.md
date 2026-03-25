# Sync

> File synchronization and cloud archive for self-hosters.
> Keep working locally. Offload to the cloud when you need space.

Sync provides bidirectional file synchronization between local machines and cloud storage, with an iCloud-style archive/restore workflow. Your data lives locally — the cloud is overflow storage that you control.

```
Your Mac                        rclone                         Cloud Storage
┌──────────────┐   push/pull/bidirectional   ┌──────────────────────────┐
│ ~/Documents  │◄──────────────────────────►│ spaces:my-sync/documents │
│ ~/data       │   delta sync, encryption    │ spaces:my-sync/data      │
│ ~/old-proj   │──── archive (move) ───────►│ spaces:my-sync/old-proj  │
│  └─ .stub    │◄─── restore (copy) ────────│                          │
└──────────────┘                             └──────────────────────────┘
      ▲                                              ▲
      │ watch (chokidar)                             │ 40+ providers
      │ schedule (cron)                              │ S3, Spaces, GCS,
      │ manual (CLI/API)                             │ Azure, B2, MinIO...
```

Sync works **standalone** (own server, own CLI, direct configuration) and optionally as a **Portlama plugin** (panel UI, tunnel transport, mTLS certificates).

## Quick Start

```bash
# Install and configure
npx @lamalibre/create-sync

# Check sync status
sync status

# Trigger a sync
sync trigger

# Archive files to cloud (free disk space)
sync archive

# Restore from cloud
sync restore
```

## Repository Structure

```
sync/
├── packages/
│   ├── sync-server/        @lamalibre/sync-server — Fastify REST API
│   ├── sync-agent/         @lamalibre/sync-agent — Agent daemon
│   ├── sync-cli/           @lamalibre/sync-cli — CLI tool
│   ├── sync-shared/        @lamalibre/sync-shared — Shared utilities
│   └── create-sync/        @lamalibre/create-sync — npx installer
├── tests/
│   └── e2e/               Two-VM E2E tests
└── docs/                  Full documentation
```

## Tech Stack

| Layer | Technology | Why |
| --- | --- | --- |
| Sync engine | rclone | 40+ cloud providers, delta sync, bidirectional, encryption, battle-tested |
| File watching | chokidar | Cross-platform native OS events, glob patterns, write-finish detection |
| Scheduling | node-cron | Lightweight, standard cron syntax, no external deps |
| Server | Fastify 5 | Fast, schema-first validation, plugin system for dual-mode |
| Process execution | execa | Array arguments (no injection), streaming, TypeScript |
| Validation | Zod | Runtime type-safe schemas, composable, good TS inference |
| CLI | @clack/prompts, picocolors | Interactive prompts, terminal colors |
| Bundling | esbuild | Zero runtime deps |
| State | JSON files | Atomic writes, no database dependency |
| Encryption | AES-256-GCM (credentials), rclone crypt (files) | Standard, built into Node.js |

## Documentation

Full documentation is available at **[lamalibre.github.io/sync](https://lamalibre.github.io/sync/)**.

### [Introduction](https://lamalibre.github.io/sync/00-introduction/what-is-sync)
- [What is Sync?](https://lamalibre.github.io/sync/00-introduction/what-is-sync) — overview, use cases, quick reference
- [How It Works](https://lamalibre.github.io/sync/00-introduction/how-it-works) — architecture walkthrough, data flows, design decisions
- [Quick Start](https://lamalibre.github.io/sync/00-introduction/quickstart) — from zero to first sync in 10 minutes

### [Concepts](https://lamalibre.github.io/sync/01-concepts/deployment-modes)
- [Deployment Modes](https://lamalibre.github.io/sync/01-concepts/deployment-modes) — standalone vs plugin mode
- [Sync Engine](https://lamalibre.github.io/sync/01-concepts/sync-engine) — rclone integration, directions, triggers, conflicts
- [Archive & Restore](https://lamalibre.github.io/sync/01-concepts/archive-restore) — iCloud-style offload, metadata stubs, savings
- [Storage Providers](https://lamalibre.github.io/sync/01-concepts/storage-providers) — 40+ providers, credentials, rclone config
- [Encryption](https://lamalibre.github.io/sync/01-concepts/encryption) — client-side encryption via rclone crypt
- [Security Model](https://lamalibre.github.io/sync/01-concepts/security-model) — credentials, permissions, path validation

### [Guides](https://lamalibre.github.io/sync/02-guides/standalone-setup)
- [Standalone Setup](https://lamalibre.github.io/sync/02-guides/standalone-setup) — server installation and service management
- [Agent Enrollment](https://lamalibre.github.io/sync/02-guides/agent-enrollment) — enrolling agents in standalone and plugin modes
- [Configuring Storage](https://lamalibre.github.io/sync/02-guides/configuring-storage) — provider setup, credentials, connection testing
- [Managing Projects](https://lamalibre.github.io/sync/02-guides/managing-projects) — project CRUD, scheduling, encryption, bandwidth
- [Archiving Files](https://lamalibre.github.io/sync/02-guides/archiving-files) — archive and restore workflow
- [CLI Usage](https://lamalibre.github.io/sync/02-guides/cli-usage) — command-line tool reference

### [Architecture](https://lamalibre.github.io/sync/03-architecture/overview)
- [System Overview](https://lamalibre.github.io/sync/03-architecture/overview) — component roles, monorepo structure, data flows
- [Sync Server](https://lamalibre.github.io/sync/03-architecture/sync-server) — Fastify server, routes, libraries, dual-mode design
- [Sync Agent](https://lamalibre.github.io/sync/03-architecture/sync-agent) — daemon lifecycle, rclone operations, file watching
- [State Management](https://lamalibre.github.io/sync/03-architecture/state-management) — file formats, atomic writes, concurrency

### [API Reference](https://lamalibre.github.io/sync/04-api-reference/overview)
- [API Overview](https://lamalibre.github.io/sync/04-api-reference/overview) — authentication, error format, endpoint summary
- [Projects API](https://lamalibre.github.io/sync/04-api-reference/projects) — project CRUD, sync triggers, status, history
- [Storage & Archive API](https://lamalibre.github.io/sync/04-api-reference/storage-archive) — storage config, archive savings, agent config

### [Reference](https://lamalibre.github.io/sync/05-reference/config-files)
- [Config Files](https://lamalibre.github.io/sync/05-reference/config-files) — file locations, permissions, write patterns
- [Glossary](https://lamalibre.github.io/sync/05-reference/glossary) — term definitions

## Security Highlights

- **Credentials encrypted at rest** — AES-256-GCM with random master key and scrypt key derivation
- **Client-side encryption** — optional per-project via rclone crypt (NaCl SecretBox + EME filenames)
- **No credentials in CLI args** — rclone reads from config file (mode 0600), never process arguments
- **Path validation** — no null bytes, no `..` traversal, max 4096 characters
- **Atomic file writes** — temp → fsync → rename for all state files
- **API key hashing** — SHA-256 with constant-time comparison

## Development

```bash
pnpm install               # Install all workspace dependencies
pnpm build                 # Build all packages
pnpm dev:server            # Start standalone sync server (port 9393)
```

## Environment Variables

| Variable | Package | Purpose |
| --- | --- | --- |
| `SYNC_PORT` | sync-server | Server port (default: 9393) |
| `SYNC_HOST` | sync-server | Listen address (default: 127.0.0.1) |
| `SYNC_DATA_DIR` | sync-server | State directory (default: ~/.sync/) |
| `SYNC_CONFIG` | sync-server | Path to config file |
| `SYNC_SKIP_AUTH` | sync-server | Set to `1` to skip auth (loopback only) |

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Copyright (c) 2026 Code Lama Software.
