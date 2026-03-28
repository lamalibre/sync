# Sync Server

> The Sync Server is a Fastify application that manages projects, stores encrypted storage credentials, tracks sync history, and serves as the central coordination point for agents — running standalone on port 9393 or as a plugin inside Portlama.

## In Plain English

The server is the brain. It stores what needs to be synced (projects), where to sync it (storage config with encrypted credentials), what happened (history), and who is doing the syncing (agents). It does not do any file transfer itself — that is the agent's job via rclone.

## Dual-Mode Design

The server runs in two modes from the same codebase:

### Standalone Mode (`index.ts`)

- Starts its own Fastify server on `SYNC_PORT` (default 9393)
- Generates API key on first setup
- Manages its own auth hook (Bearer token verification)
- State directory: `~/.sync/` (or `SYNC_DATA_DIR`)
- CORS configured for localhost development

### Plugin Mode (`plugin.ts`)

- Exports a Fastify plugin via `buildPlugin()`
- Portlama registers the plugin into its existing server
- No separate port — routes mount at `/api/sync/`
- Auth delegated to Portlama's mTLS middleware
- State directory provided by Portlama

## Route Map

### Public Routes (No Auth)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sync/health` | Health check: `{ ok, uptime, timestamp }` |

### Setup Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/sync/setup/api-key` | Setup token or Bearer | Generate or regenerate API key |

### Admin Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sync/storage` | Get storage config (credentials redacted) |
| PATCH | `/api/sync/storage` | Update storage config |
| POST | `/api/sync/storage/test` | Test storage connectivity |
| POST | `/api/sync/storage/create-bucket` | Create cloud bucket |
| GET | `/api/sync/projects` | List all projects |
| GET | `/api/sync/projects/:projectId` | Get single project |
| POST | `/api/sync/projects` | Create project |
| PATCH | `/api/sync/projects/:projectId` | Update project |
| DELETE | `/api/sync/projects/:projectId` | Delete project |
| POST | `/api/sync/projects/:projectId/undelete` | Restore soft-deleted project |
| POST | `/api/sync/projects/:projectId/sync` | Trigger manual sync |
| POST | `/api/sync/projects/:projectId/archive` | Start archive operation |
| POST | `/api/sync/projects/:projectId/restore` | Start restore operation |
| GET | `/api/sync/projects/:projectId/status` | Get project status + active operation |
| GET | `/api/sync/projects/:projectId/stubs` | Get archive stub info |
| GET | `/api/sync/projects/:projectId/savings` | Get archive savings for project |
| GET | `/api/sync/status` | Global sync status |
| GET | `/api/sync/history` | Sync operation history |
| GET | `/api/sync/savings` | Global archive savings |
| GET | `/api/sync/agents` | List agents |
| GET | `/api/sync/agents/:agentId` | Get single agent |
| GET | `/api/sync/previews` | List pending sync previews |
| GET | `/api/sync/previews/:projectId` | Get preview detail |
| POST | `/api/sync/previews/:projectId/approve` | Approve pending preview |
| POST | `/api/sync/previews/:projectId/reject` | Reject pending preview |
| GET | `/api/sync/approvals` | List approved path entries |
| POST | `/api/sync/approvals` | Create/update path approval |
| DELETE | `/api/sync/approvals/:projectId` | Revoke path approval |

### Agent Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/sync/agent-config` | Agent (sync:read) | Get projects + storage config (credentials included) |
| POST | `/api/sync/agent-report` | Agent (sync:write) + Agent Token | Report sync/archive/restore result |
| POST | `/api/sync/agents` | Agent | Register new agent (returns one-time agent token) |
| POST | `/api/sync/agents/:agentId/heartbeat` | Agent Token | Send heartbeat with disk usage |
| PATCH | `/api/sync/agents/:agentId/projects` | Admin + Agent Token | Update project assignments |
| DELETE | `/api/sync/agents/:agentId` | Admin + Agent Token | Remove agent |

## Library Modules

### `lib/state.ts`

Unified state management (the largest server module):
- Load/save all JSON state files (projects, history, savings, agents, config)
- Project CRUD and sync operations (MAX_PROJECTS = 100)
- Agent registry (register, heartbeat, online/offline status, MAX_AGENTS = 50)
- Agent token generation (SHA-256 hash), verification (constant-time), and re-registration
- Storage credential encrypt/decrypt/redact
- Active operations map (in-memory)
- Sync history and archive savings tracking

### `lib/crypto.ts`

Encryption utilities:
- `encrypt(plaintext)` → `base64(salt || iv || authTag || ciphertext)`
- `decrypt(packed64)` → plaintext
- Uses scrypt key derivation from master key
- Master key loaded from `master.key` file

### `lib/auth.ts`

Authentication hook:
- API key verification (SHA-256 hash comparison, constant-time)
- Agent token verification (SHA-256 hash comparison, constant-time)
- `SYNC_SKIP_AUTH=1` bypass (loopback only)

### Agent Token Verification

Agent mutation endpoints verify the `X-Agent-Token` header at the route level:
- Heartbeat (`POST /agents/:id/heartbeat`)
- Project assignment (`PATCH /agents/:id/projects`)
- Agent removal (`DELETE /agents/:id`)
- Operation reporting (`POST /agent-report`)

The token is verified by hashing with SHA-256 and comparing against the stored hash using `timingSafeEqual`. If any registered agent has a stored token hash, the server requires a valid token from all agents on these endpoints.

### `lib/schemas.ts`

Zod validation schemas for all API inputs:
- Project creation/update schemas
- Storage configuration schema
- Agent registration schema
- Path validation rules

## Active Operations (In-Memory)

The server maintains a `Map<projectId, ActiveOperation>` for operations currently in progress:

```typescript
interface ActiveOperation {
  operationId: string;
  projectId: string;
  type: "sync" | "archive" | "restore";
  startedAt: string;
  transferred: number;
  totalSize: number;
  speed: number;
  eta: number;
  filesTransferred: number;
  filesTotal: number;
}
```

Active operations are not persisted — they exist only while the server process runs. On server restart, any in-progress operations are lost (the agent will detect this and re-report).

## Source Files

| File | Role |
| --- | --- |
| `src/index.ts` | Standalone server entry (own Fastify, own auth) |
| `src/server.ts` | Fastify app factory, error handling |
| `src/lib/plugin.ts` | Portlama plugin entry (buildPlugin, fastify-plugin) |
| `src/lib/auth.ts` | Authentication hook (API key, SYNC_SKIP_AUTH) |
| `src/lib/state.ts` | State file management (load/save JSON) |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt utilities |
| `src/lib/schemas.ts` | Zod validation schemas |
| `src/routes/approvals.ts` | Path approval management routes |
| `src/routes/previews.ts` | Sync preview (dry-run) management routes |
| `src/routes/` | Route handlers: health, setup, storage, projects, sync, archive, status, agent, agents, approvals, previews |

## Related Documentation

- [Sync Agent](sync-agent.md) — the other half of the system
- [State Management](state-management.md) — file formats and concurrency
- [API Overview](../04-api-reference/overview.md) — full API reference
- [Deployment Modes](../01-concepts/deployment-modes.md) — standalone vs plugin
