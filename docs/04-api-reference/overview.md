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

**Development mode** (`SYNC_SKIP_AUTH=1`): Authentication is bypassed for requests from loopback addresses only. A loud warning is logged on startup. This is NOT based on `NODE_ENV`.

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
      "path": ["localPath"],
      "message": "Local path must be absolute"
    }
  ]
}
```

### Common Status Codes

| Code | Meaning | Example |
| --- | --- | --- |
| 200 | Success | Project updated, status retrieved |
| 201 | Created | Project created, agent registered |
| 400 | Validation failed | Invalid path, bad cron expression, already archived |
| 401 | Auth missing | No Authorization header or API key |
| 403 | Forbidden | Invalid API key or agent token |
| 404 | Not found | Project or agent does not exist |
| 409 | Conflict | Sync already in progress |
| 502 | Bad gateway | Storage test failed (provider unreachable) |

## Endpoint Summary

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/sync/health` | None | Health check |
| POST | `/api/sync/setup/api-key` | Setup token | Generate API key |
| GET | `/api/sync/storage` | Admin | Get storage config (redacted) |
| PATCH | `/api/sync/storage` | Admin | Update storage config |
| POST | `/api/sync/storage/test` | Admin | Test storage connectivity |
| POST | `/api/sync/storage/create-bucket` | Admin | Create cloud bucket |
| GET | `/api/sync/projects` | Admin/Agent | List projects |
| GET | `/api/sync/projects/:id` | Admin | Get project |
| POST | `/api/sync/projects` | Admin | Create project |
| PATCH | `/api/sync/projects/:id` | Admin | Update project |
| DELETE | `/api/sync/projects/:id` | Admin | Delete project |
| POST | `/api/sync/projects/:id/sync` | Admin | Trigger sync |
| POST | `/api/sync/projects/:id/archive` | Admin | Start archive |
| POST | `/api/sync/projects/:id/restore` | Admin | Start restore |
| GET | `/api/sync/projects/:id/status` | Admin/Agent | Project status |
| GET | `/api/sync/projects/:id/stubs` | Admin | Archive stub info |
| GET | `/api/sync/projects/:id/savings` | Admin | Archive savings |
| GET | `/api/sync/status` | Admin | Global sync status |
| GET | `/api/sync/history` | Admin | Sync operation log |
| GET | `/api/sync/savings` | Admin | Global archive savings |
| GET | `/api/sync/agents` | Admin | List agents |
| GET | `/api/sync/agents/:id` | Admin | Get agent |
| POST | `/api/sync/agents` | Agent | Register agent |
| PATCH | `/api/sync/agents/:id/projects` | Admin | Assign projects |
| POST | `/api/sync/agents/:id/heartbeat` | Agent | Agent heartbeat |
| DELETE | `/api/sync/agents/:id` | Admin | Remove agent |
| GET | `/api/sync/agent-config` | Agent | Get config (credentials included) |
| POST | `/api/sync/agent-report` | Agent | Report operation result |

## Validation Schemas

| Input | Rules |
| --- | --- |
| Project name | 1-100 characters |
| Local path | Absolute, no null bytes, no `..`, max 4096 chars |
| Remote path | No null bytes, no `..`, max 4096 chars |
| Provider type | One of: `spaces`, `s3`, `gcs`, `azure`, `b2`, `custom` |
| Direction | One of: `push`, `pull`, `bidirectional` |
| Trigger | One of: `manual`, `watch`, `schedule`, `watch+schedule` |
| Conflict strategy | One of: `newest-wins`, `local-wins`, `remote-wins`, `manual` |
| Schedule | Valid 5-field cron expression |
| Encryption password | Minimum 8 characters |
| Bandwidth limit | Valid rclone bwlimit format (e.g., `10M`, `500k`) |

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
