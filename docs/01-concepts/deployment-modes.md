# Deployment Modes

> Sync runs in two modes: standalone (your own server with its own API key and encryption) or plugin (inside Portlama, using Portlama's existing certificates and agent registry).

## In Plain English

Think of Sync as a filing clerk who keeps your local folders and cloud storage in sync. The question is: does the clerk work independently, or does the clerk work inside an existing office?

**Standalone mode** is the independent clerk. You set up a server, it generates its own API key, manages its own storage credentials, and runs on its own port (9393). The agent talks directly to this server. This is ideal when you want a simple sync solution on your local network or when you do not use Portlama.

**Plugin mode** is the clerk working inside Portlama's office. Sync registers itself as a Fastify plugin inside Portlama's existing server. It uses Portlama's certificates, Portlama's agent registry, and Portlama's admin panel. No separate server, no separate port, no separate API key. This is ideal when you already use Portlama and want to add file sync as a capability.

## Comparison

|  | Standalone | Plugin |
| --- | --- | --- |
| **Server** | Own Fastify server on port 9393 | Runs inside Portlama's Fastify instance |
| **Admin auth** | API key (Bearer token) | mTLS admin certificate |
| **Agent auth** | API key (Bearer token) | mTLS agent certificate with `sync:read`/`sync:write` capabilities |
| **Agent registry** | File-based (`~/.sync/agents.json`) | Portlama's agent registry |
| **Install command** | `npx @lamalibre/create-sync` | Plugin registered in Portlama config |
| **Port** | 9393 (configurable) | Portlama's port (typically 9292 via nginx) |
| **Network requirement** | Agents need direct access to server | Agents connect through Portlama's relay |
| **Management UI** | CLI + Desktop app | Portlama panel (sync-panel microfrontend) + CLI + Desktop app |
| **Agent enrollment** | API key enrollment | API key + delegated Portlama mTLS certificate enrollment |
| **State directory** | `~/.sync/` | Portlama's state directory |
| **Storage credentials** | Encrypted in `sync-config.json` | Encrypted in Portlama's state |

## Standalone Mode

### How It Works

```
Admin (CLI)                              Agent Machine
┌──────────────────┐                    ┌──────────────────────┐
│ sync-cli         │                    │ sync-agent           │
│                  │                    │                      │
└────────┬─────────┘                    └──────────┬───────────┘
         │                                         │
         │  HTTP                                   │  HTTP (polling)
         │  Bearer API key                         │  Bearer API key
         │                                         │
         ▼                                         ▼
┌────────────────────────────────────────────────────────────┐
│  Sync Server (Fastify, port 9393)                          │
│                                                            │
│  API key auth  │  Storage config  │  Project management    │
│  (SHA-256 hash)  (AES-256-GCM)     (CRUD + sync triggers) │
└────────────────────────────────────────────────────────────┘
```

The server generates a one-time setup token on first start (logged to the console). Use this token to generate an API key. The API key is stored as a SHA-256 hash — the raw key is shown once during setup and cannot be retrieved.

### Authentication

**Admin operations** (REST API):
- Bearer token: `Authorization: Bearer <api-key>`
- API key generated via `POST /api/sync/setup/api-key` with setup token

**Agent operations** (polling + reporting):
- Same Bearer token mechanism
- Agent receives API key during enrollment

### Setup Flow

1. Run `npx @lamalibre/create-sync`
2. Installer starts server, generates setup token
3. Admin creates API key using setup token
4. Configure storage provider (interactive wizard)
5. Create first project (optional)
6. Install system service (launchd/systemd)

## Plugin Mode

### How It Works

```
Admin (Portlama panel)                  Agent Machine
┌──────────────────┐                    ┌──────────────────────┐
│ Browser          │                    │ sync-agent           │
│ (admin cert)     │                    │ (agent cert)         │
└────────┬─────────┘                    └──────────┬───────────┘
         │                                         │
         │  mTLS (admin cert)                      │  mTLS (agent cert)
         │                                         │
         ▼                                         ▼
┌────────────────────────────────────────────────────────────┐
│  Portlama Server                                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Sync Plugin (fastify-plugin)                        │  │
│  │  ├─ All sync routes under /api/sync/*                │  │
│  │  ├─ Storage config (encrypted)                       │  │
│  │  └─ Project management + sync triggers               │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  Portlama's mTLS middleware provides:                      │
│  ├─ request.certRole (admin / agent)                       │
│  └─ Agent capabilities (sync:read, sync:write)             │
└────────────────────────────────────────────────────────────┘
```

### Panel Microfrontend

In plugin mode, the server serves a `panel.js` microfrontend (built by `@lamalibre/sync-panel`) that Portlama loads into its admin UI. The panel registers itself at `window.__portlamaPlugins.sync` and provides 6 pages: Dashboard, Storage, Agents, Preview, Trash, and Settings. The panel uses an HTTP fetch-based client to communicate with the Sync server through Portlama's routes.

### Authentication

Portlama's mTLS middleware handles authentication before Sync routes execute. The plugin reads `request.certRole` and agent capabilities directly — no API keys needed.

### Agent Capabilities

| Capability | Grants |
| --- | --- |
| `sync:read` | Read project list and storage config from `/api/sync/agent-config` |
| `sync:write` | Post sync results to `/api/sync/agent-report` |
| `storage:read` | Read storage configuration |
| `storage:write` | Modify storage configuration |

### Config Bundle

In plugin mode, agents receive a config bundle from Portlama containing:
- Server URL (Portlama tunnel endpoint)
- Storage credentials (encrypted with a one-time passphrase)
- Project definitions

The agent decrypts the bundle during enrollment and caches the config locally.

### Delegated Enrollment

When a new agent registers with a plugin-mode server, the server requests a delegated enrollment token from Portlama. The registration response includes this token alongside the standard agent ID and token. The agent then uses the enrollment token to obtain mTLS certificates from Portlama, enabling secure ticket-based authorization for inter-agent communication. Enrollment is best-effort — if it fails, the agent continues operating without Portlama certificates.

## Choosing a Mode

**Choose standalone when:**
- You do not use Portlama
- You want a self-contained sync server
- You have direct network access between all machines
- You want minimal dependencies

**Choose plugin when:**
- You already use Portlama for tunneling
- Your agents are behind firewalls without direct access
- You want a single management interface for all services
- You want Portlama's certificate infrastructure

## Related Documentation

- [Standalone Setup](../02-guides/standalone-setup.md) — step-by-step server installation
- [Agent Enrollment](../02-guides/agent-enrollment.md) — enrolling agents in both modes
- [System Overview](../03-architecture/overview.md) — architecture details
- [Security Model](security-model.md) — credential security
