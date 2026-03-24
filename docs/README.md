# Sync Documentation

File synchronization and cloud archive — standalone and Portlama plugin.

## Documentation Structure

### [Introduction](00-introduction/)
- [What is Sync?](00-introduction/what-is-sync.md) — overview, use cases, quick reference
- [How It Works](00-introduction/how-it-works.md) — architecture walkthrough, data flows, design decisions
- [Quick Start](00-introduction/quickstart.md) — from zero to first sync in 10 minutes

### [Concepts](01-concepts/)
- [Deployment Modes](01-concepts/deployment-modes.md) — standalone vs plugin mode
- [Sync Engine](01-concepts/sync-engine.md) — rclone integration, directions, triggers, conflicts
- [Archive & Restore](01-concepts/archive-restore.md) — iCloud-style offload, metadata stubs, savings
- [Storage Providers](01-concepts/storage-providers.md) — 40+ providers, credentials, rclone config
- [Encryption](01-concepts/encryption.md) — client-side encryption via rclone crypt
- [Security Model](01-concepts/security-model.md) — credentials, permissions, path validation

### [Guides](02-guides/)
- [Standalone Setup](02-guides/standalone-setup.md) — server installation and service management
- [Agent Enrollment](02-guides/agent-enrollment.md) — enrolling agents in standalone and plugin modes
- [Configuring Storage](02-guides/configuring-storage.md) — provider setup, credentials, connection testing
- [Managing Projects](02-guides/managing-projects.md) — project CRUD, scheduling, encryption, bandwidth
- [Archiving Files](02-guides/archiving-files.md) — archive and restore workflow
- [CLI Usage](02-guides/cli-usage.md) — command-line tool reference

### [Architecture](03-architecture/)
- [System Overview](03-architecture/overview.md) — component roles, monorepo structure, data flows
- [Sync Server](03-architecture/sync-server.md) — Fastify server, routes, libraries, dual-mode design
- [Sync Agent](03-architecture/sync-agent.md) — daemon lifecycle, rclone operations, file watching
- [State Management](03-architecture/state-management.md) — file formats, atomic writes, concurrency

### [API Reference](04-api-reference/)
- [API Overview](04-api-reference/overview.md) — authentication, error format, endpoint summary
- [Projects API](04-api-reference/projects.md) — project CRUD, sync triggers, status, history
- [Storage & Archive API](04-api-reference/storage-archive.md) — storage config, archive savings, agent config

### [Reference](05-reference/)
- [Config Files](05-reference/config-files.md) — file locations, permissions, write patterns
- [Glossary](05-reference/glossary.md) — term definitions
