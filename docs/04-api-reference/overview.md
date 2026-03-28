# API Overview

> The Sync Server exposes a JSON REST API for managing projects, storage, agents, and sync operations, protected by API key (standalone) or mTLS client certificates (plugin mode).

## In Plain English

When you use the CLI to trigger a sync, check status, or archive files, every action maps to a REST API call. The CLI sends JSON requests to the server, the server updates its state files, and sends back a JSON response. The agent uses the same API to pull config and report results.

## Base URL

**Standalone mode:**
```
http://localhost:9393/api/sync/...
```

**Plugin mode (inside Portlama):**
```
https://panel.<domain>/api/sync/...
```

## Authentication

### Standalone Mode

**API Key (admin and agent operations):**
```
Authorization: Bearer <api-key>
```

The API key is generated during installation via `POST /api/sync/setup/api-key` using a one-time setup token. The raw key is shown once and stored as a SHA-256 hash on the server.

**Agent Token (agent mutation endpoints):**
```
X-Agent-Token: <agent-token>
```

Agents receive a unique token upon registration (`POST /api/sync/agents`). All agent mutation endpoints require this per-agent token via the `X-Agent-Token` header in addition to the primary API key:

- `POST /api/sync/agents/:id/heartbeat` — heartbeat
- `PATCH /api/sync/agents/:id/projects` — project assignment updates
- `DELETE /api/sync/agents/:id` — agent removal
- `POST /api/sync/agent-report` — operation result reporting

The raw token is returned only once during registration; the server stores its SHA-256 hash. Verification uses constant-time comparison to prevent timing attacks.

**Development mode** (`SYNC_SKIP_AUTH=1`): Authentication is bypassed for requests from loopback addresses only (`127.0.0.1`, `localhost`, `::1`). The server refuses to start if `SYNC_SKIP_AUTH=1` is combined with a non-loopback `SYNC_HOST` (e.g., `0.0.0.0`). A loud warning is logged on startup. This is NOT based on `NODE_ENV`.

### Plugin Mode

Portlama's mTLS middleware handles authentication before Sync routes execute:
- Admin: certificate with admin role
- Agent: certificate with `sync:read` and/or `sync:write` capabilities

No API keys — everything is certificate-based.

## Content Type

All request and response bodies use `application/json`. Requests with a JSON body must include `Content-Type: application/json`.

## Error Format

Every error response follows a consistent structure:

```json
{
  "ok": false,
  "error": "Human-readable error summary"
}
```

### Validation Errors (400)

Input validated with Zod schemas at the route level:

```json
{
  "ok": false,
  "error": "Validation error",
  "details": [
    {
      "path": ["remotePath"],
      "message": "Remote path contains invalid characters"
    }
  ]
}
```

### Common Status Codes

| Code | Meaning | Example |
| --- | --- | --- |
| 200 | Success | Project updated, status retrieved |
| 201 | Created | Project created, agent registered |
| 400 | Validation failed | Invalid path, bad cron expression, already archived, storage not configured, project is deleted |
| 401 | Auth missing | No Authorization header or API key |
| 403 | Forbidden | Invalid API key or agent token |
| 404 | Not found | Project or agent does not exist |
| 409 | Conflict | Sync already in progress, max agents (50) reached, max projects (100) reached |
| 502 | Bad gateway | Storage test failed (provider unreachable) |

## Endpoint Summary

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/sync/health` | None | Health check — returns `{ ok, uptime, timestamp }` |
| POST | `/api/sync/setup/api-key` | Setup token (first time) or Bearer (regeneration) | Generate API key |
| GET | `/api/sync/storage` | Admin | Get storage config (redacted) |
| PATCH | `/api/sync/storage` | Admin | Update storage config |
| POST | `/api/sync/storage/test` | Admin | Test storage connectivity |
| POST | `/api/sync/storage/create-bucket` | Admin | Create cloud bucket |
| GET | `/api/sync/projects` | Admin/Agent | List projects |
| GET | `/api/sync/projects/:projectId` | Admin | Get project |
| POST | `/api/sync/projects` | Admin | Create project |
| PATCH | `/api/sync/projects/:projectId` | Admin | Update project |
| DELETE | `/api/sync/projects/:projectId` | Admin | Delete project (soft or hard) |
| POST | `/api/sync/projects/:projectId/undelete` | Admin | Restore soft-deleted project |
| POST | `/api/sync/projects/:projectId/sync` | Admin | Trigger sync |
| POST | `/api/sync/projects/:projectId/archive` | Admin | Start archive |
| POST | `/api/sync/projects/:projectId/restore` | Admin | Start restore (optional `filePath` for single-file restore) |
| GET | `/api/sync/projects/:projectId/status` | Admin/Agent | Project status |
| GET | `/api/sync/projects/:projectId/stubs` | Admin | Archive stub info |
| GET | `/api/sync/projects/:projectId/savings` | Admin | Archive savings |
| GET | `/api/sync/status` | Admin | Global sync status |
| GET | `/api/sync/history` | Admin | Sync operation log |
| GET | `/api/sync/savings` | Admin | Global archive savings |
| GET | `/api/sync/projects/:projectId/trash` | Admin | List trash entries |
| POST | `/api/sync/projects/:projectId/purge-trash` | Admin | Purge expired trash |
| POST | `/api/sync/projects/:projectId/restore-trash` | Admin | Restore files from trash |
| GET | `/api/sync/agents` | Admin | List agents |
| GET | `/api/sync/agents/:agentId` | Admin | Get agent |
| POST | `/api/sync/agents` | Admin | Register agent (returns one-time agent token) |
| PATCH | `/api/sync/agents/:agentId/projects` | Admin + Agent Token | Assign projects |
| POST | `/api/sync/agents/:agentId/heartbeat` | Agent Token | Agent heartbeat |
| DELETE | `/api/sync/agents/:agentId` | Admin + Agent Token | Remove agent |
| GET | `/api/sync/previews` | Admin | List pending sync previews |
| GET | `/api/sync/previews/:projectId` | Admin | Get preview detail |
| POST | `/api/sync/previews/:projectId/approve` | Admin | Approve pending preview |
| POST | `/api/sync/previews/:projectId/reject` | Admin | Reject pending preview |
| GET | `/api/sync/approvals` | Admin | List approved path entries |
| POST | `/api/sync/approvals` | Admin | Create/update path approval |
| DELETE | `/api/sync/approvals/:projectId` | Admin | Revoke path approval |
| GET | `/api/sync/agent-config` | Agent | Get config (credentials included) |
| POST | `/api/sync/agent-report` | Agent + Agent Token | Report operation result |

## Validation Schemas

| Input | Rules |
| --- | --- |
| Project ID | Lowercase alphanumeric and hyphens only, must start with alphanumeric (`^[a-z0-9][a-z0-9-]*$`), 1-100 chars |
| Project name | 1-100 characters, no control characters |
| Remote path | No null bytes, no `..`, max 4096 chars |
| Provider type | One of: `spaces`, `s3`, `gcs`, `azure`, `b2`, `custom`, `local` |
| Direction | One of: `push`, `pull`, `bidirectional` |
| Trigger | One of: `manual`, `watch`, `schedule`, `watch+schedule` |
| Conflict strategy | One of: `newest-wins`, `local-wins`, `remote-wins`, `manual` |
| Schedule | Valid 5-field cron expression (no seconds field) |
| Encryption password | Minimum 12 characters |
| Bandwidth limit | Valid rclone bwlimit format — integer or decimal with required unit suffix `k/K/m/M/g/G` (e.g., `10M`, `500k`, `1.5G`) |
| Include/exclude patterns | 1-500 chars each, max 100 patterns, no null bytes, no rclone filter prefixes (`+`, `-`, `!`) |

## Quick Reference

| Item | Value |
| --- | --- |
| **Base URL (standalone)** | `http://localhost:9393/api/sync` |
| **Authentication** | API key (standalone) or mTLS (plugin) |
| **Content-Type** | `application/json` |
| **Validation** | Zod schemas at route level |
| **Error format** | `{ "ok": false, "error": "..." }` |
| **API key format** | `sync_<random>` (Bearer token) |
| **API key storage** | SHA-256 hash on server |

## Related Documentation

- [Projects API](projects.md) — project CRUD and sync endpoints
- [Storage & Archive API](storage-archive.md) — storage config, archive, and savings
- [Security Model](../01-concepts/security-model.md) — authentication details
- [Sync Server](../03-architecture/sync-server.md) — server internals
