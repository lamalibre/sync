# Configuring Storage

> Set up a cloud storage provider for Sync — configure credentials, choose a bucket, test connectivity, and optionally enable client-side encryption.

## In Plain English

Before Sync can move files to the cloud, it needs to know where to put them and how to authenticate. This guide walks through configuring your storage provider — from creating a bucket to verifying the connection works.

You configure storage once on the server. Every agent receives the config automatically during polling.

## Step 1: Create a Bucket

Create a bucket (or container) with your cloud provider:

| Provider | Where to Create |
| --- | --- |
| DigitalOcean Spaces | DigitalOcean Control Panel → Spaces → Create a Space |
| AWS S3 | AWS Console → S3 → Create bucket |
| Google Cloud Storage | Google Cloud Console → Cloud Storage → Create bucket |
| Azure Blob | Azure Portal → Storage accounts → Containers → + Container |
| Backblaze B2 | Backblaze Dashboard → Buckets → Create a Bucket |

Use **private** access (not public). Sync manages all access through API credentials.

## Step 2: Get Credentials

**DigitalOcean Spaces:**
- Control Panel → API → Spaces Keys → Generate New Key
- Note: access key and secret key

**AWS S3:**
- IAM Console → Users → Create user → Attach S3 policy → Create access key
- Note: access key ID and secret access key

**Google Cloud Storage:**
- IAM Console → Service Accounts → Create → Grant Storage Admin role → Create key (JSON)
- Note: the entire JSON key file content

**Azure Blob:**
- Storage account → Access keys → Show keys
- Note: storage account name and key

**Backblaze B2:**
- Account → App Keys → Add a New Application Key
- Note: application key ID and application key

## Step 3: Configure via API

```bash
curl -X PATCH http://localhost:9393/api/sync/storage \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "spaces",
    "endpoint": "https://ams3.digitaloceanspaces.com",
    "bucket": "my-sync-bucket",
    "accessKey": "<access-key>",
    "secretKey": "<secret-key>",
    "encryption": false
  }'
```

**Provider-specific examples:**

AWS S3:
```json
{
  "provider": "s3",
  "endpoint": "https://s3.us-east-1.amazonaws.com",
  "region": "us-east-1",
  "bucket": "my-sync-bucket",
  "accessKey": "<access-key-id>",
  "secretKey": "<secret-access-key>",
  "encryption": false
}
```

Google Cloud Storage:
```json
{
  "provider": "gcs",
  "endpoint": "https://storage.googleapis.com",
  "bucket": "my-sync-bucket",
  "accessKey": "<entire-service-account-json>",
  "secretKey": "unused",
  "encryption": false
}
```

Note: For GCS, the service account JSON is passed as `accessKey`. The `secretKey` field is required by the schema — use `"unused"` as a placeholder for GCS.

Azure Blob:
```json
{
  "provider": "azure",
  "endpoint": "https://blob.core.windows.net",
  "bucket": "my-container",
  "accessKey": "<storage-account-name>",
  "secretKey": "<storage-account-key>",
  "encryption": false
}
```

Backblaze B2:
```json
{
  "provider": "b2",
  "endpoint": "https://api.backblazeb2.com",
  "bucket": "my-sync-bucket",
  "accessKey": "<application-key-id>",
  "secretKey": "<application-key>",
  "encryption": false
}
```

## Step 4: Test the Connection

```bash
curl -X POST http://localhost:9393/api/sync/storage/test \
  -H "Authorization: Bearer <api-key>"
```

Success:
```json
{
  "ok": true,
  "latency": 245,
  "message": "Connection successful. Bucket is accessible."
}
```

Failure:
```json
{
  "ok": false,
  "error": "bucket not found or access denied"
}
```

Common fixes:
- **Access denied** — check credentials, ensure the API key has read/write access to the bucket
- **Bucket not found** — check the bucket name spelling and region
- **Connection timeout** — check the endpoint URL (region-specific for Spaces and S3)

## Step 5: Create a Bucket via API (Optional)

If the bucket does not exist, create it:

```bash
curl -X POST http://localhost:9393/api/sync/storage/create-bucket \
  -H "Authorization: Bearer <api-key>"
```

```json
{
  "ok": true,
  "bucket": "my-sync-bucket",
  "created": true
}
```

## Enabling Global Encryption

To encrypt all projects by default, set an encryption password on the storage config:

```json
{
  "provider": "spaces",
  "endpoint": "https://ams3.digitaloceanspaces.com",
  "bucket": "my-sync-bucket",
  "accessKey": "<access-key>",
  "secretKey": "<secret-key>",
  "encryption": true,
  "encryptionPassword": "my-global-encryption-password"
}
```

Projects can override this with their own per-project encryption password. See [Encryption](../01-concepts/encryption.md).

## Viewing Current Storage Config

```bash
curl http://localhost:9393/api/sync/storage \
  -H "Authorization: Bearer <api-key>"
```

Credentials are omitted entirely from the response (not shown, not even redacted). The response shows only the provider type, endpoint, bucket, region, encryption flag, and test results.

## Related Documentation

- [Storage Providers](../01-concepts/storage-providers.md) — provider details and rclone config
- [Encryption](../01-concepts/encryption.md) — client-side encryption
- [Quick Start](../00-introduction/quickstart.md) — first sync from scratch
- [Managing Projects](managing-projects.md) — creating sync projects
