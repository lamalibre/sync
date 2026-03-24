/**
 * Unified rclone INI config builder.
 *
 * Produces rclone.conf content from a provider-agnostic input type.
 * Used by sync-server (connection testing), sync-agent (runtime config),
 * and create-sync (installer connection test).
 */

/** The remote name used in all rclone invocations. */
export const RCLONE_REMOTE_NAME = 'sync-remote';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Unified input for building an rclone INI config.
 *
 * Each provider type uses a different subset of fields:
 * - spaces, s3, custom: accessKey, secretKey, endpoint, region
 * - gcs: accessKey (service account credentials)
 * - azure: accessKey (account name), secretKey (account key)
 * - b2: accessKey (application key ID), secretKey (application key)
 * - local: no credentials needed
 */
export interface RcloneConfigInput {
  readonly provider: string;
  readonly accessKey?: string;
  readonly secretKey?: string;
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly region?: string;
  readonly forcePathStyle?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an rclone INI config string for the base remote.
 *
 * The returned string can be written directly to an rclone.conf file.
 * For encrypted remotes, use {@link buildCryptIni} to append a crypt
 * overlay section.
 */
export function buildRcloneIni(input: RcloneConfigInput): string {
  return generateBaseRemote(input);
}

/**
 * Build a crypt overlay INI section.
 *
 * The `obscuredPassword` must already be obscured via `rclone obscure`.
 */
export function buildCryptIni(
  remoteName: string,
  bucket: string,
  obscuredPassword: string,
): string {
  return buildIni(remoteName, {
    type: 'crypt',
    remote: `${RCLONE_REMOTE_NAME}:${bucket}`,
    password: obscuredPassword,
    filename_encryption: 'standard',
    directory_name_encryption: 'true',
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateBaseRemote(input: RcloneConfigInput): string {
  switch (input.provider) {
    case 'spaces':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 's3',
        provider: 'DigitalOcean',
        access_key_id: input.accessKey ?? '',
        secret_access_key: input.secretKey ?? '',
        endpoint: input.region ? `${input.region}.digitaloceanspaces.com` : (input.endpoint ?? ''),
        acl: 'private',
      });

    case 's3':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 's3',
        provider: 'AWS',
        access_key_id: input.accessKey ?? '',
        secret_access_key: input.secretKey ?? '',
        region: input.region ?? 'us-east-1',
        acl: 'private',
      });

    case 'gcs':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 'google cloud storage',
        service_account_credentials: input.accessKey ?? '',
        bucket_policy_only: 'true',
      });

    case 'azure':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 'azureblob',
        account: input.accessKey ?? '',
        key: input.secretKey ?? '',
      });

    case 'b2':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 'b2',
        account: input.accessKey ?? '',
        key: input.secretKey ?? '',
      });

    case 'custom':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 's3',
        provider: 'Other',
        access_key_id: input.accessKey ?? '',
        secret_access_key: input.secretKey ?? '',
        endpoint: input.endpoint ?? '',
        ...(input.region ? { region: input.region } : {}),
        ...(input.forcePathStyle ? { force_path_style: 'true' } : {}),
        acl: 'private',
      });

    case 'local':
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 'local',
      });

    default:
      // Treat unknown providers as custom S3-compatible
      return buildIni(RCLONE_REMOTE_NAME, {
        type: 's3',
        provider: 'Other',
        access_key_id: input.accessKey ?? '',
        secret_access_key: input.secretKey ?? '',
        endpoint: input.endpoint ?? '',
        ...(input.region ? { region: input.region } : {}),
        acl: 'private',
      });
  }
}

/**
 * Sanitize a value for safe inclusion in an INI file.
 * Strips newlines to prevent INI injection attacks where a malicious
 * credential value could inject additional config sections or keys.
 */
function sanitizeIniValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/**
 * Build an INI section from a section name and key-value pairs.
 * Filters out empty values.
 */
function buildIni(sectionName: string, entries: Record<string, string>): string {
  const lines: string[] = [`[${sectionName}]`];
  for (const [key, value] of Object.entries(entries)) {
    if (value !== '') {
      lines.push(`${key} = ${sanitizeIniValue(value)}`);
    }
  }
  return lines.join('\n');
}
