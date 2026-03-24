# Encryption

> Sync supports client-side encryption via rclone crypt — files are encrypted on the agent machine before upload, so the cloud provider never sees your plaintext data.

## In Plain English

When you store files in the cloud, the cloud provider can read them. Even with "server-side encryption," the provider holds the keys and could theoretically access your data (or be compelled to by a court order).

Client-side encryption solves this. Your files are encrypted on your machine before they leave. The cloud provider receives only ciphertext — random-looking bytes. Without your password, the data is unreadable. rclone uses NaCl SecretBox (XSalsa20 + Poly1305) for file contents and EME wide-block encryption for filenames.

Sync integrates this as a per-project toggle. Enable encryption on a project, set a password, and every file synced to the cloud is encrypted automatically. The password never leaves your network — it is stored encrypted on the server and decrypted only on the agent machine.

## For Users

### Enabling Encryption

Set `encrypted: true` and provide a password when creating a project:

```json
{
  "name": "sensitive-data",
  "localPath": "/home/user/sensitive",
  "direction": "push",
  "encrypted": true,
  "encryptionPassword": "my-very-strong-passphrase"
}
```

The server returns a warning: **"Encryption enabled. If you lose the password, the data cannot be recovered."**

### What Gets Encrypted

| Component | Encryption | Algorithm |
| --- | --- | --- |
| **File contents** | Encrypted | NaCl SecretBox (XSalsa20 + Poly1305) |
| **File names** | Encrypted | EME wide-block encryption |
| **Directory names** | Encrypted | EME wide-block encryption |
| **File sizes** | Padded to 16 bytes | Approximate size visible |
| **Modification times** | Not encrypted | Visible to provider |
| **Directory tree depth** | Not encrypted | Visible to provider |

### Password Management

- **Per-project passwords** — each project can have its own encryption password (minimum 8 characters)
- **Global password** — the storage config can define a fallback encryption password for projects that do not specify one
- **Password loss = data loss** — there is no key recovery mechanism. Store passwords securely.

### What It Looks Like in the Cloud

Without encryption:
```
bucket/training-data/
├── dataset.csv
├── model.pkl
└── notes.txt
```

With encryption:
```
bucket/training-data/
├── 7h2kq9m3f5v1p8x4/
│   ├── r4t6y8u0i2o4p6a8
│   ├── s5d7f9g1h3j5k7l9
│   └── z2x4c6v8b0n2m4q6
```

File names, directory names, and contents are all unreadable without the password.

## For Developers

### rclone crypt Integration

When a project has `encrypted: true`, the agent creates a crypt overlay remote in `rclone.conf`:

```ini
[sync-remote]
type = s3
provider = DigitalOcean
access_key_id = <key>
secret_access_key = <secret>
endpoint = ams3.digitaloceanspaces.com
acl = private

[sync-encrypted]
type = crypt
remote = sync-remote:<bucket>
password = <obscured>
filename_encryption = standard
directory_name_encryption = true
```

All sync operations then use `sync-encrypted:` instead of `sync-remote:<bucket>/<path>`.

### Password Obscuring

rclone requires passwords to be "obscured" (a reversible encoding, not encryption). The agent calls:

```
rclone obscure <password>
```

The password is passed via stdin, never as a CLI argument. The obscured value is written to `rclone.conf`.

### Multi-Project Encryption

When multiple projects share the same encryption password, they share one crypt remote (`sync-encrypted`). When different passwords exist, the agent creates separate crypt remotes:

```ini
[sync-encrypted]
type = crypt
remote = sync-remote:bucket/project-a
password = <obscured-password-1>
...

[sync-encrypted-2]
type = crypt
remote = sync-remote:bucket/project-b
password = <obscured-password-2>
...
```

The agent builds a `cryptRemoteMap` mapping unique passwords to remote names.

### Credential Storage

Encryption passwords are stored encrypted on the server alongside other credentials:

```
1. Admin creates project with encryptionPassword
2. Server encrypts password with AES-256-GCM (master key + scrypt)
3. Stored as encryptionPasswordEncrypted in projects.json
4. Agent receives decrypted password via /api/sync/agent-config
5. Agent passes password to rclone obscure
6. Obscured password written to rclone.conf (mode 0600)
```

The plaintext password exists only in memory during agent operation.

### Encryption Scope

rclone crypt configuration used by Sync:

| Setting | Value | Effect |
| --- | --- | --- |
| `filename_encryption` | `standard` | File names encrypted (EME) |
| `directory_name_encryption` | `true` | Directory names encrypted |
| Content encryption | NaCl SecretBox | XSalsa20 stream cipher + Poly1305 MAC |
| File size padding | 16 bytes | Approximate size visible (±16 bytes) |

## Quick Reference

| Item | Value |
| --- | --- |
| **Content cipher** | NaCl SecretBox (XSalsa20 + Poly1305) |
| **Filename cipher** | EME wide-block encryption |
| **Minimum password** | 8 characters |
| **Password storage** | AES-256-GCM encrypted at rest on server |
| **Password in transit** | mTLS tunnel (plugin) or HTTPS (standalone) |
| **Password in rclone.conf** | Obscured (rclone's reversible encoding) |
| **Key recovery** | None — password loss = data loss |
| **Per-project passwords** | Supported (each project can have its own) |

## Related Documentation

- [Security Model](security-model.md) — credential encryption at rest
- [Storage Providers](storage-providers.md) — provider configuration
- [Managing Projects](../02-guides/managing-projects.md) — creating encrypted projects
- [Sync Engine](sync-engine.md) — rclone invocation details
