# Security Model

> Sync uses defense-in-depth to protect storage credentials and file data: AES-256-GCM encryption at rest, strict file permissions, path validation, secure process execution, and client-side encryption — so that credentials never appear in logs, CLI arguments, or API responses.

## In Plain English

Security in Sync works in layers, like an onion. The outermost layer protects credentials at rest — they are encrypted with AES-256-GCM on the server's disk. The next layer protects credentials in transit — they travel only through mTLS tunnels or HTTPS. The next layer protects credentials in use — rclone reads them from a config file with mode 0600, never from CLI arguments (which would be visible in `ps aux`). The innermost layer is optional client-side encryption — files are encrypted before they leave your machine.

No single layer is the sole barrier. If one layer fails, the others still protect your data.

## For Users

### What Protects You

#### 1. Credential Encryption at Rest

Storage credentials (access keys, secret keys, encryption passwords) are encrypted on the server's disk using AES-256-GCM with a random master key:

| Component | Storage |
| --- | --- |
| Master key | `~/.sync/master.key` (random 32-byte hex, mode 0600) |
| Encrypted credentials | `sync-config.json` (AES-256-GCM with scrypt key derivation) |
| API key | SHA-256 hash only (raw key shown once during setup) |
| Agent token hash | SHA-256 hash in `agents.json` (raw token shown once on registration) |

On the agent side, the API key and agent token in `agent-settings.json` are also encrypted at rest using AES-256-GCM with the agent's own master key. Backward-compatible: plaintext values from earlier versions are detected and read transparently.

Even if an attacker reads the config file, the credentials are ciphertext without the master key.

#### 2. Credential Security in Transit

| Mode | Transport |
| --- | --- |
| **Standalone** | HTTPS between admin/agent and server |
| **Plugin** | Portlama's mTLS tunnel (client certificates on both sides) |

Credentials are sent to agents via `GET /api/sync/agent-config`. In the API response, credentials are included only for authenticated agents — admin API responses redact credentials.

#### 3. Process Argument Security

rclone credentials are never passed as CLI arguments. This is a critical rule:

- **Arguments are visible** in process listings (`ps aux`, `/proc/<pid>/cmdline`)
- **Config files are private** — written with mode 0600, readable only by the owner

Sync writes an `rclone.conf` file with credentials, then passes `--config <path>` to rclone. The child process environment is explicitly sanitized to prevent leaking parent environment variables such as `RCLONE_CONFIG_PASS`. Sync operations receive `PATH`, `HOME`, and `RCLONE_CONFIG`, plus `TMPDIR` when it is set in the parent environment; utility commands like `rclone obscure` receive only `PATH` and `HOME`.

#### 4. Path Validation

All path inputs are validated to prevent directory traversal:

- No null bytes (`\0`)
- No `..` segments after normalization
- Maximum 4096 characters
- `remotePath` validated on the server side
- Local path validation happens on the agent side only — local paths are stored in the agent's `approved-paths.json` and never sent to or stored on the server

#### 4a. Local Path Allowlist

Local paths are managed exclusively on the agent via `sync agent-approve`. The agent maintains an `approved-paths.json` file that maps project IDs to approved local directories. This design ensures:

- Local filesystem paths never cross the network
- Each agent independently controls which directories it exposes
- The server cannot instruct an agent to read or write arbitrary local paths

#### 5. File Permissions

| File | Mode | Rationale |
| --- | --- | --- |
| `~/.sync/` | `0700` | Server state — owner access only |
| `~/.sync/master.key` | `0600` | Encryption master key |
| `~/.sync/sync-config.json` | `0600` | Encrypted credentials |
| `~/.sync-agent/` | `0700` | Agent state — owner access only |
| `~/.sync-agent/rclone.conf` | `0600` | Cloud credentials |
| `~/.sync-agent/cached-config.json` | `0600` | Encrypted config cache |
| `~/.sync-agent/master.key` | `0600` | Agent encryption key |

#### 6. Client-Side Encryption (Optional)

When enabled per-project, files are encrypted before leaving your machine:
- NaCl SecretBox (XSalsa20 + Poly1305) for content
- EME wide-block encryption for filenames and directory names
- Cloud provider never sees plaintext

See [Encryption](encryption.md) for details.

#### 7. Agent Token Verification

All agent mutation endpoints verify the per-agent `X-Agent-Token` header:

- `POST /api/sync/agents/:id/heartbeat`
- `PATCH /api/sync/agents/:id/projects`
- `DELETE /api/sync/agents/:id`
- `POST /api/sync/agent-report`

The token is generated on registration, returned once, and stored as a SHA-256 hash. Verification uses constant-time comparison. If any registered agent has a stored token hash, the server requires a valid token from all agents.

#### 8. Error Message Sanitization

rclone error messages are sanitized before storage or display to prevent credential leakage:

- URL credentials stripped (e.g., `https://key:secret@host` becomes `https://***@host`)
- Absolute file paths to config/key files redacted
- Credential key=value pairs (access_key_id, secret_access_key, password, etc.) redacted
- Output truncated to 2048 characters

This sanitization is shared between sync-server and sync-agent via `sanitizeRcloneError()` in sync-shared.

#### 9. Capacity Limits

The server enforces hard limits to prevent resource exhaustion:

- **MAX_AGENTS = 50** -- registration returns 409 when the limit is reached
- **MAX_PROJECTS = 100** -- project creation returns 409 when the limit is reached

#### 10. Atomic File Writes

All state files use the temp → fsync → rename pattern. This prevents:
- Partial reads (file is either old or new, never half-written)
- Corruption from crashes or power loss
- Credential leakage from incomplete writes

### What Is NOT Included

Sync does not include:

- **Rate limiting** — no built-in request throttling on the API (use a reverse proxy)
- **Network encryption for standalone** — standalone mode uses HTTP by default; use a reverse proxy with TLS in production
- **Credential rotation** — the master key is generated once and never rotated; rotation would require re-encrypting all credentials
- **Two-factor authentication** — standalone mode uses API key only; plugin mode inherits Portlama's mTLS

## For Developers

### Encryption Scheme

All at-rest encryption uses the same scheme:

```
1. Generate random 32-byte salt
2. Derive 32-byte key: scrypt(masterKey, salt, 32)
3. Generate random 16-byte IV
4. Encrypt: AES-256-GCM(key, iv, plaintext) → ciphertext + authTag
5. Pack: base64(salt || iv || authTag || ciphertext)
```

Decryption reverses the process: unpack, derive key from salt, decrypt with GCM (auth tag verifies integrity).

### Master Key

- 64-character hex string (32 random bytes) generated on first run
- Stored at `~/.sync/master.key` (server) and `~/.sync-agent/master.key` (agent)
- Mode 0600
- Never transmitted, never derived, never rotated
- Loss = need to reconfigure credentials (but not data loss unless encryption passwords are also lost)

### API Key Authentication

**Setup flow:**
1. Server starts, generates a one-time setup token, logs it to console
2. Admin calls `POST /api/sync/setup/api-key` with `X-Setup-Token` header (constant-time comparison)
3. Server generates random API key (`sync_<random>`)
4. Server stores SHA-256 hash of key in `sync-config.json`
5. Raw key returned in response (shown once, never retrievable)

**Regeneration flow:**
When an API key already exists, `POST /api/sync/setup/api-key` requires a valid `Authorization: Bearer <existing-key>` header (enforced by the auth hook). The setup token is only required for the initial key generation.

**Verification:**
- Agent/admin sends `Authorization: Bearer <api-key>`
- Server hashes received key with SHA-256
- Constant-time comparison with stored hash (timing-attack resistant)

### rclone Config Security

```
1. Agent receives provider config from server (decrypted in transit)
2. Agent calls buildRcloneIni() to generate INI content
3. Values sanitized (newlines removed — prevents INI injection)
4. Written to rclone.conf with mode 0600
5. rclone invoked with --config flag pointing to the file
6. Config recreated on every poll cycle (idempotent)
```

For encryption passwords, the agent calls `rclone obscure` with the password on stdin (never as a CLI argument).

### Agent Config Cache

The agent caches its config locally in `cached-config.json`, encrypted with the agent's own master key. This allows the agent to continue operating if the server is temporarily unreachable.

### Input Validation

All REST inputs validated with Zod schemas at the route level:

| Schema | Validates |
| --- | --- |
| Path fields (remote) | No null bytes, no `..`, max 4096 chars |
| Path fields (local) | Validated on agent only — absolute, no null bytes, no `..`, max 4096 chars, must be in `approved-paths.json` |
| Project name | 1-100 chars |
| Project ID | Lowercase alphanumeric + hyphens only, must start with alphanumeric, 1-100 chars |
| Provider type | One of: spaces, s3, gcs, azure, b2, custom, local |
| Cron expression | Valid 5-field cron syntax (no seconds field) |
| Encryption password | Min 12 characters |
| Bandwidth limit | Valid rclone bwlimit format |
| Include/exclude patterns | No null bytes, no rclone filter prefixes (+, -, !), max 100 patterns |

### Execa Array Arguments

All external process calls use execa with array arguments:

```javascript
// CORRECT: array arguments + env-based config, safe with special characters
await execa('rclone', ['sync', localPath, remotePath], {
  env: buildRcloneEnv(configPath),  // RCLONE_CONFIG via env, not CLI
  extendEnv: false,                 // prevent leaking parent env vars
});

// WRONG: string interpolation, command injection risk
await exec(`rclone sync ${localPath} ${remotePath}`);  // NEVER
```

This is enforced project-wide. The `child_process` module and string interpolation for commands are prohibited. Config paths are passed via `RCLONE_CONFIG` environment variable to avoid exposure in process argument lists.

## Quick Reference

### Security Layers

| Layer | Technology | Protects |
| --- | --- | --- |
| Credential encryption | AES-256-GCM + scrypt | Credentials at rest on server |
| Transport security | mTLS / HTTPS | Credentials in transit |
| File permissions | chmod 0600/0700 | Credentials on disk |
| Process isolation | execa array args + config file | Credentials from process listings |
| Path validation | Zod + normalization | Directory traversal attacks |
| Client-side encryption | rclone crypt (NaCl) | File data in the cloud |
| Agent token verification | SHA-256 hash + constant-time compare | Unauthorized agent mutations |
| Error sanitization | Regex redaction of URLs, paths, credentials | Credential leakage in error messages |
| Capacity limits | MAX_AGENTS=50, MAX_PROJECTS=100 | Resource exhaustion |
| Atomic writes | temp → fsync → rename | State file corruption |
| API key hashing | SHA-256 + constant-time compare | Key theft and timing attacks |

## Related Documentation

- [Encryption](encryption.md) — client-side encryption details
- [Storage Providers](storage-providers.md) — credential configuration
- [Config Files](../05-reference/config-files.md) — file locations and permissions
- [Deployment Modes](deployment-modes.md) — standalone vs plugin authentication
