# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add soft delete for projects — `DELETE /api/sync/projects/:id` now marks projects as deleted instead of removing them, with `POST .../undelete` to restore
- Add permanent delete via `?permanent=true` query parameter on the delete endpoint
- Add sync trash system using rclone `--backup-dir` — overwritten files are kept in timestamped `.sync-trash/` directories (local and remote)
- Add trash management endpoints: `GET .../trash`, `POST .../purge-trash`, `POST .../restore-trash`
- Add CLI commands: `project-delete`, `project-restore`, `trash-list`, `trash-purge`, `trash-restore`
- Add configurable soft delete retention (`SoftDeleteConfig`) at global and per-project level (default: 90 days)
- Add automatic trash cleanup on agent (hourly) and server (every 6 hours) based on retention policy
- Add per-sync direction override — `POST .../sync` now accepts an optional `direction` body parameter
- Add server-initiated operation detection — agent picks up pending operations via `pendingOperationId` on config poll
- Add `local` provider type for local-to-local rclone sync
- Add `projectIdSchema` validation (lowercase alphanumeric + hyphens only) across all route params

### Changed

- Raise minimum encryption password length from 8 to 12 characters
- Validate include/exclude patterns: reject rclone filter prefixes (`+`, `-`, `!`) and null bytes
- Validate cron expressions: enforce exactly 5 fields (no sub-minute scheduling)
- Validate project names: reject control characters
- Replace `NODE_ENV=development` auth bypass with `SYNC_SKIP_AUTH=1` (loopback-only)
- Use timing-safe comparison for setup token validation
- Create state directories with mode `0700` instead of default permissions
- Strip `agentTokenHash` from all agent API responses via `redactAgent()` helper
- Reject sync/archive/restore operations on soft-deleted projects with informative error messages
- Agent config endpoint now returns only active (non-deleted) projects
- Agent reports for in-flight operations on deleted projects are still accepted (graceful completion)
- Validate glob metacharacters in restore file paths now includes `]`, `\`, `}`

### Fixed

- Fix archive space-freed calculation to never report negative values (`Math.max(0, ...)`)
- Fix stub file path construction to use `path.join()` instead of string concatenation
- Fix archive restore to verify `projectId` matches stub metadata (prevents cross-project restore)
- Fix agent-initiated syncs (watch/schedule) creating history entries when no server-side entry exists

### Security

- Use `timingSafeEqual` for setup token comparison to prevent timing attacks
- Add defense-in-depth pattern validation in agent's `buildExcludeFlags()` (rejects unsafe patterns even from cached config)
- Validate remote trash directory names before `rclone purge` to prevent path traversal

## [0.1.0] - 2026-03-24

### Added

- Implement full Sync monorepo: server (Fastify REST API), agent daemon, CLI tool, shared utilities, npx installer
- Add rclone-based bidirectional sync engine with support for 40+ cloud storage providers
- Add archive/restore workflow (iCloud offload pattern) with metadata stub files
- Add project-scoped sync operations with independent async contexts
- Add storage provider credential encryption at rest
- Add rclone config bundle generation with one-time passphrase encryption
- Add atomic file writes (write → fsync → rename) for all state files
- Add path validation: no null bytes, no `..` after normalization, max 4096 characters
- Add sync-desktop Tauri app: project CRUD, storage configuration, agents view, polling
- Add two-VM E2E test infrastructure with MCP orchestration
- Add structured documentation in numbered sections matching Portlama style
