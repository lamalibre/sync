# Sync

File synchronization and cloud archive tool. rclone-based. Bidirectional sync, archive/restore (iCloud offload pattern). Dual-mode: standalone + Portlama plugin.

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
│   └── e2e/               E2E tests
└── docs/                  Architecture, API, Storage docs
```

## Development

```bash
pnpm install               # install all workspace dependencies
pnpm build                 # build all packages
pnpm dev:server            # standalone sync server
```

Build before considering a task complete. Avoid commands that hang (e.g., `npm start`).

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Fastify 5, Zod validation |
| Sync engine | rclone (external binary, 40+ providers) |
| File watching | chokidar |
| Process execution | execa (array args only) |
| Shared | @lamalibre/sync-shared (types, atomic writes, rclone config) |
| CLI | @clack/prompts, picocolors |
| Bundling | esbuild → zero runtime deps |
| State | JSON files (atomic writes) |
| Target OS | macOS (launchd), Linux (systemd) |

## Coding Conventions

**TypeScript / Node.js:**

- ES Modules everywhere (`import`, not `require`)
- TypeScript strict mode — no `any`, no implicit returns
- `execa` for shell commands with array arguments — never `child_process` or string interpolation
- This is critical for rclone paths with spaces and special characters
- Zod schemas for all API input validation at route level
- Routes handle HTTP only — business logic in `lib/`
- Fastify logger, never `console.log` in library code
- All file writes atomic (write to temp → fsync → rename)

**CLI:**

- `@clack/prompts` for interactive prompts
- `picocolors` for terminal output
- Non-interactive mode via flags for CI/scripting

## Critical Constraints

1. **rclone is the ONLY sync engine.** No custom file transfer code. All sync operations go through rclone.
2. **Credentials never in logs, API responses (except to agents), or process argument lists.** Use environment variables or config files for sensitive data.
3. **All rclone invocations via execa with array arguments.** Never shell interpolation — paths may contain spaces, quotes, and special characters.
4. **Archive stubs must be small** (KB, not MB). They are metadata files, not data copies.
5. **Agent must not hold entire file tree in memory.** Use streaming and pagination for large directory listings.
6. **Sync operations are per-project** — stuck sync on project A must not block project B. Each project runs in its own async context.

## Security

- Storage credentials encrypted at rest on server
- rclone.conf created with mode 0600
- Agent directory `~/.sync-agent/` created with mode 0700
- Credentials travel only through mTLS tunnel (plugin mode) or direct HTTPS (standalone mode)
- Config bundles encrypted with one-time passphrase
- Path validation: no null bytes, no `..` after normalization, max 4096 characters
- rclone passwords passed via `RCLONE_CONFIG_PASS` environment variable, never as CLI arguments

## Environment Variables

| Variable | Package | Purpose |
|---|---|---|
| `SYNC_PORT` | sync-server | Server port (default: 9393) |
| `SYNC_HOST` | sync-server | Listen address (default: 127.0.0.1) |
| `SYNC_DATA_DIR` | sync-server | State directory (default: ~/.sync/) |
| `SYNC_CONFIG` | sync-server | Path to config file |
| `SYNC_SKIP_AUTH` | sync-server | Set to `1` to skip auth (loopback only) |

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Copyright (c) 2026 Code Lama Software.
