# Storage Providers

> Sync supports 40+ cloud storage providers through rclone, with first-class configuration for DigitalOcean Spaces, AWS S3, Google Cloud Storage, Azure Blob, Backblaze B2, any S3-compatible endpoint, and local disk.

## In Plain English

Cloud storage comes in many flavors — Amazon S3, Google Cloud, Azure, DigitalOcean Spaces, Backblaze — and each has its own API, authentication scheme, and configuration format. Rather than implementing adapters for each one, Sync delegates all storage access to rclone.

You configure your storage provider once on the Sync server (provider type, credentials, bucket name). The server encrypts the credentials and stores them. When an agent needs to sync, it receives the credentials (decrypted over a secure channel), generates an rclone config file, and rclone handles the rest.

## For Users

### Supported Providers

| Provider | Type ID | Authentication |
| --- | --- | --- |
| **DigitalOcean Spaces** | `spaces` | Access key + secret key + endpoint |
| **AWS S3** | `s3` | Access key + secret key + region |
| **Google Cloud Storage** | `gcs` | Service account JSON key |
| **Azure Blob Storage** | `azure` | Storage account name + key |
| **Backblaze B2** | `b2` | Application key ID + application key |
| **S3-Compatible** | `custom` | Access key + secret key + endpoint (+ optional region, path style) |
| **Local Disk** | `local` | No credentials (path only) — defined in shared types but not yet accepted by server validation |

### Choosing a Provider

| Factor | Best Choice |
| --- | --- |
| **Cheapest storage** | Backblaze B2 ($0.005/GB/month) |
| **Cheapest egress** | Backblaze B2 (free with Cloudflare) or local |
| **Lowest latency** | Provider with a region near you |
| **Existing account** | Use what you already have |
| **Self-hosted** | MinIO, Garage, or other S3-compatible (use `custom`) |
| **No cloud** | `local` (sync to external drive or NAS) |

### Configuration Fields

Each provider requires different credentials:

**DigitalOcean Spaces:**
- `accessKey` — Spaces access key
- `secretKey` — Spaces secret key
- `endpoint` — e.g., `https://ams3.digitaloceanspaces.com` (full URL required)
- `bucket` — bucket name

**AWS S3:**
- `accessKey` — IAM access key ID
- `secretKey` — IAM secret access key
- `region` — e.g., `us-east-1`
- `bucket` — bucket name

**Google Cloud Storage:**
- `accessKey` — service account JSON (the entire key file content)
- `secretKey` — `"unused"` (required by schema, not used for GCS)
- `endpoint` — `https://storage.googleapis.com`
- `bucket` — bucket name

**Azure Blob Storage:**
- `accessKey` — storage account name
- `secretKey` — storage account key
- `bucket` — container name

**Backblaze B2:**
- `accessKey` — application key ID
- `secretKey` — application key
- `bucket` — bucket name

**S3-Compatible (MinIO, Garage, etc.):**
- `accessKey` — access key
- `secretKey` — secret key
- `endpoint` — e.g., `https://minio.example.com:9000` (full URL required)
- `region` — optional
- `bucket` — bucket name

**Local Disk:**
- No credentials needed
- `bucket` field is used as the base path (e.g., `/mnt/backup`)

## For Developers

### rclone Config Generation

The agent generates rclone config from the provider config. Each provider maps to specific rclone settings:

**Spaces → rclone S3 with DigitalOcean provider:**
```ini
[sync-remote]
type = s3
provider = DigitalOcean
access_key_id = <key>
secret_access_key = <secret>
endpoint = ams3.digitaloceanspaces.com
acl = private
```

**AWS S3 → rclone S3 with AWS provider:**
```ini
[sync-remote]
type = s3
provider = AWS
access_key_id = <key>
secret_access_key = <secret>
region = us-east-1
acl = private
```

**GCS → rclone Google Cloud Storage:**
```ini
[sync-remote]
type = google cloud storage
service_account_credentials = <json>
bucket_policy_only = true
```

**Azure → rclone Azure Blob:**
```ini
[sync-remote]
type = azureblob
account = <account_name>
key = <account_key>
```

**B2 → rclone Backblaze B2:**
```ini
[sync-remote]
type = b2
account = <app_key_id>
key = <app_key>
```

**Custom S3 → rclone S3 with custom endpoint:**
```ini
[sync-remote]
type = s3
provider = Other
access_key_id = <key>
secret_access_key = <secret>
endpoint = <endpoint>
force_path_style = true
```

### Config Builder

`buildRcloneIni()` in `sync-shared` generates provider-specific INI sections:

- Maps Sync's unified credential names to provider-specific rclone field names
- Sanitizes values (removes newlines to prevent INI injection)
- Filters empty values
- Returns a complete INI string ready to write to `rclone.conf`

### Credential Flow

```
1. Admin saves credentials via PATCH /api/sync/storage
   └── Server encrypts with AES-256-GCM using master key
   └── Stored in sync-config.json

2. Agent polls GET /api/sync/agent-config
   └── Server decrypts credentials
   └── Returns provider config (credentials in plaintext)
   └── Transport: mTLS tunnel (plugin) or HTTPS (standalone)

3. Agent generates rclone.conf
   └── Writes config file with mode 0600
   └── Credentials only exist in this file (never in CLI args or logs)

4. rclone reads config file
   └── Authenticates with cloud provider
   └── Config file recreated on every poll cycle
```

### Testing Storage

`POST /api/sync/storage/test` verifies bucket accessibility:
- Runs `rclone lsd` to list top-level directories in the bucket
- Measures latency
- Returns success/error with timing

`POST /api/sync/storage/create-bucket` creates a new bucket:
- Runs `rclone mkdir` to create the bucket
- Returns success with bucket name

## Quick Reference

| Provider | rclone Type | Key Fields |
| --- | --- | --- |
| Spaces | `s3` (DigitalOcean) | access_key_id, secret_access_key, endpoint |
| S3 | `s3` (AWS) | access_key_id, secret_access_key, region |
| GCS | `google cloud storage` | service_account_credentials |
| Azure | `azureblob` | account, key |
| B2 | `b2` | account, key |
| Custom | `s3` (Other) | access_key_id, secret_access_key, endpoint |
| Local | `local` | (not yet in server schema) |

## Related Documentation

- [Configuring Storage](../02-guides/configuring-storage.md) — step-by-step provider setup
- [Encryption](encryption.md) — client-side encryption via rclone crypt
- [Security Model](security-model.md) — credential storage and transport security
- [Sync Engine](sync-engine.md) — how rclone is invoked
