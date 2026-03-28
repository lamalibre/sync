# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-03-27

### Added

- Add 5-layer ignore pattern resolver — built-in defaults, `.gitignore`, `.dockerignore`, `.syncignore`, and API excludes merged into rclone `--exclude-from` files
- Add atomic exclude-filter file writer with SHA-256 change detection to avoid unnecessary rewrites
- Add E2E tests for ignore system, include patterns, single-file restore, aggregate savings, protected mode, confirm-destructive mode, and CLI commands (tests 16–20)

### Fixed

- Fix `execa` crash in rclone dry-run when no `AbortSignal` is provided — `gracefulCancel` was set without `cancelSignal`, breaking the entire confirm-destructive flow

**Affected packages:** `@lamalibre/sync-agent` 0.1.1 → 0.1.2, `@lamalibre/sync-shared` 0.1.1 → 0.1.2

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
- Add agent-side path approval — `sync agent-approve` command maps project IDs to local directories; local paths never leave the agent machine
- Add access modes (`full`, `push-only`, `pull-only`, `protected`) per approved path to control sync direction at the agent level
- Add sync preview/confirm workflow — agent runs `rclone --dry-run` and saves pending previews for user approval before executing destructive syncs
- Add confirm modes (`auto`, `confirm-destructive`, `confirm-always`) configurable per approved path with configurable delete thresholds
- Add `sync preview` CLI command to list, inspect, approve, or reject pending sync previews
- Add protected pull mode using `rclone copy --ignore-existing` — downloads new files without overwriting or deleting existing local files
- Add per-project encryption passwords stored encrypted at rest, independent of the global storage encryption password
- Add rclone crypt remote overlay generation for encrypted projects with `rclone obscure` password handling via stdin
- Add `sanitizeRcloneError` utility to redact credential patterns from rclone error messages before logging
- Add deployment use cases guide with real-world deployment scenarios
- Add CLI commands: `agents` (list/detail/delete agents), `storage` (configure/test/create-bucket), `project-create`, `project-edit`, `history`, `health` — full CLI/desktop feature parity
- Add desktop Preview view with dry-run diff display, approve/reject actions, and 10-second auto-refresh
- Add desktop Trash view with project selector, per-entry restore, purge with age filter
- Add desktop agent path approval management with access mode, confirm mode, and delete threshold controls
- Add desktop soft-delete restore and permanent delete with confirmation in Dashboard and ProjectDetail views
- Add server preview routes (`GET/POST /api/sync/previews`) and approval routes (`GET/POST/DELETE /api/sync/approvals`)
- Add server trash routes to plugin mode (previously standalone-only)
- Add `SYNC_API_KEY` environment variable fallback for CLI authentication
- Add `SYNC_STORAGE_ACCESS_KEY` / `SYNC_STORAGE_SECRET_KEY` env var alternatives for non-interactive storage configuration
- Add shared `formatRelativeTime` and `formatBytes` utilities in desktop app (extracted from duplicated inline copies)
- Add glossary terms: access mode, agent token, confirm mode, path approval, setup token, sync preview

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
- Remove `localPath` from server-side project model — local paths are now agent-only via `approved-paths.json`
- Sanitize rclone child process environment with `extendEnv: false` to prevent leaking parent env vars
- Strip `localPath` from all server API responses (previews, approvals) — local paths never cross the network
- Require `X-Agent-Token` on all agent mutation endpoints (heartbeat, project assignment, deletion, reports) — not just heartbeat
- Cap agent registrations at MAX_AGENTS=50 with HTTP 409 on overflow
- Encrypt API key and agent token at rest in `agent-settings.json` using agent master key (backward-compatible with plaintext)

### Fixed

- Fix archive space-freed calculation to never report negative values (`Math.max(0, ...)`)
- Fix stub file path construction to use `path.join()` instead of string concatenation
- Fix archive restore to verify `projectId` matches stub metadata (prevents cross-project restore)
- Fix agent-initiated syncs (watch/schedule) creating history entries when no server-side entry exists
- Fix dry-run failure silently bypassing confirm mode — now correctly blocks sync when preview cannot be generated
- Fix `buildSyncEndpoints` silently treating bidirectional as push — now throws to enforce `runRcloneBisync` usage
- Fix `writeExclusiveFile` missing fsync before close for temporary rclone config files
- Fix desktop `formatBytes` returning `NaN undefined` for negative byte values
- Fix desktop `formatRelativeTime` showing negative durations for clock-skewed timestamps
- Fix desktop API client crashing on non-JSON server error responses (e.g., HTML proxy errors)
- Fix CLI `parseInt` for `--watch-debounce`, `--limit` flags silently sending `NaN` to server
- Fix CLI `project-edit` unable to clear bandwidth limit (now sends `null` to unset)
- Fix unhandled promise rejections in desktop `$effect` blocks and async event handlers

### Security

- Use `timingSafeEqual` for setup token comparison to prevent timing attacks
- Add defense-in-depth pattern validation in agent's `buildExcludeFlags()` (rejects unsafe patterns even from cached config)
- Validate remote trash directory names before `rclone purge` to prevent path traversal
- Use exclusive file creation (`O_CREAT|O_EXCL`) for master key generation to prevent race-condition key overwrite causing data loss
- Validate pending sync preview action values to reject tampered files with unknown actions
- Require `X-Setup-Token` header in create-sync installer for initial API key generation — prevents race-condition takeover
- Use cryptographically random filenames and exclusive open (`O_CREAT|O_EXCL`) for temp rclone.conf in installer — prevents symlink race in shared /tmp
- Add URL credential stripping (`://***@`) to rclone error sanitizer — catches `https://key:secret@endpoint` patterns
- Add Zod refinements for null bytes and `..` traversal on approval `localPath` field (defense-in-depth alongside `validateLocalPath`)
- Remove `localPath` from server log output in approval routes — prevents local filesystem paths from appearing in remote server logs

**Affected packages:** `@lamalibre/sync-server` 0.1.1, `@lamalibre/sync-agent` 0.1.2, `@lamalibre/sync-cli` 0.1.1, `@lamalibre/sync-desktop` 0.1.0, `@lamalibre/sync-shared` 0.1.2, `@lamalibre/create-sync` 0.1.1

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
