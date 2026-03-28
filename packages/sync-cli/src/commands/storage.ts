import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { formatRelativeTime, jsonOutput } from '../lib/format.js';
import { PROVIDER_TYPES } from '@lamalibre/sync-shared';

// ---------------------------------------------------------------------------
// Types matching server response shapes
// ---------------------------------------------------------------------------

interface StorageStatus {
  configured: boolean;
  provider: string | null;
  endpoint?: string;
  bucket?: string;
  region?: string;
  encryption?: boolean;
  lastTested: string | null;
  testResult: string | null;
}

interface StorageTestResult {
  ok: boolean;
  latency?: number;
  message?: string;
  error?: string;
}

interface StorageCreateBucketResult {
  ok: boolean;
  bucket?: string;
  created?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface StorageOptions {
  json?: boolean;
  yes?: boolean;
  // Configure flags for non-interactive mode
  provider?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
  encrypt?: boolean;
  encryptPassword?: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function storageCommand(
  client: ApiClient,
  subcommand: string | undefined,
  opts: StorageOptions,
): Promise<void> {
  switch (subcommand) {
    case 'configure':
      await configureSub(client, opts);
      break;
    case 'test':
      await testSub(client, opts);
      break;
    case 'create-bucket':
      await createBucketSub(client, opts);
      break;
    default:
      await showSub(client, opts);
      break;
  }
}

// ---------------------------------------------------------------------------
// Show current storage configuration
// ---------------------------------------------------------------------------

async function showSub(client: ApiClient, opts: StorageOptions): Promise<void> {
  const status = await client.get<StorageStatus>('/api/sync/storage');

  if (opts.json) {
    process.stdout.write(jsonOutput(status) + '\n');
    return;
  }

  process.stdout.write(pc.bold('\nStorage Configuration\n\n'));

  if (!status.configured) {
    process.stdout.write(
      pc.dim('  Storage is not configured. Run ') +
        pc.cyan('sync storage configure') +
        pc.dim(' to set up.\n\n'),
    );
    return;
  }

  process.stdout.write(
    `  Provider:    ${status.provider ?? pc.dim('unknown')}\n` +
      `  Endpoint:    ${status.endpoint ?? pc.dim('n/a')}\n` +
      `  Bucket:      ${status.bucket ?? pc.dim('n/a')}\n` +
      `  Region:      ${status.region ?? pc.dim('n/a')}\n` +
      `  Encryption:  ${status.encryption ? pc.green('enabled') : pc.dim('disabled')}\n` +
      `  Last tested: ${status.lastTested ? formatRelativeTime(status.lastTested) : pc.dim('never')}\n` +
      `  Test result: ${formatTestResult(status.testResult)}\n\n`,
  );
}

function formatTestResult(result: string | null): string {
  if (!result) return pc.dim('n/a');
  if (result === 'ok') return pc.green('ok');
  return pc.red(result);
}

// ---------------------------------------------------------------------------
// Configure storage (interactive or via flags)
// ---------------------------------------------------------------------------

async function configureSub(client: ApiClient, opts: StorageOptions): Promise<void> {
  let provider: string;
  let endpoint: string;
  let bucket: string;
  let region: string | undefined;
  let accessKey: string;
  let secretKey: string;
  let encryption: boolean;
  let encryptionPassword: string | undefined;

  // Check env vars as fallbacks for sensitive credentials
  const resolvedAccessKey = opts.accessKey ?? process.env['SYNC_STORAGE_ACCESS_KEY'];
  const resolvedSecretKey = opts.secretKey ?? process.env['SYNC_STORAGE_SECRET_KEY'];

  const hasAllFlags =
    opts.provider !== undefined &&
    opts.endpoint !== undefined &&
    opts.bucket !== undefined &&
    resolvedAccessKey !== undefined &&
    resolvedSecretKey !== undefined;

  if (hasAllFlags) {
    // Non-interactive mode
    // Safe: all five required fields are guarded by hasAllFlags check above
    provider = opts.provider!;
    endpoint = opts.endpoint!;
    bucket = opts.bucket!;
    region = opts.region;
    accessKey = resolvedAccessKey!;
    secretKey = resolvedSecretKey!;
    encryption = opts.encrypt === true;
    encryptionPassword = opts.encryptPassword;
  } else {
    // Interactive mode
    const providerResult = await p.select({
      message: 'Storage provider',
      options: PROVIDER_TYPES.map((pt) => ({ value: pt, label: pt })),
    });
    if (p.isCancel(providerResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    provider = providerResult as string;

    const endpointResult = await p.text({
      message: 'Endpoint URL',
      placeholder: 'https://nyc3.digitaloceanspaces.com',
      validate: (v) => {
        if (!v.trim()) return 'Endpoint is required';
        try {
          new URL(v.trim());
        } catch {
          return 'Must be a valid URL';
        }
        return undefined;
      },
    });
    if (p.isCancel(endpointResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    endpoint = (endpointResult as string).trim();

    const bucketResult = await p.text({
      message: 'Bucket name',
      placeholder: 'my-sync-bucket',
      validate: (v) => {
        if (!v.trim()) return 'Bucket name is required';
        if (v.includes(':')) return 'Bucket name must not contain colons';
        return undefined;
      },
    });
    if (p.isCancel(bucketResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    bucket = (bucketResult as string).trim();

    const regionResult = await p.text({
      message: 'Region (optional)',
      placeholder: 'us-east-1',
    });
    if (p.isCancel(regionResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    region = (regionResult as string).trim() || undefined;

    const accessKeyResult = await p.text({
      message: 'Access key',
      validate: (v) => (!v.trim() ? 'Access key is required' : undefined),
    });
    if (p.isCancel(accessKeyResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    accessKey = (accessKeyResult as string).trim();

    const secretKeyResult = await p.password({
      message: 'Secret key',
      validate: (v) => (!v.trim() ? 'Secret key is required' : undefined),
    });
    if (p.isCancel(secretKeyResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    secretKey = (secretKeyResult as string).trim();

    const encryptResult = await p.confirm({
      message: 'Enable encryption at rest?',
      initialValue: false,
    });
    if (p.isCancel(encryptResult)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    encryption = encryptResult as boolean;

    if (encryption) {
      const pwResult = await p.password({
        message: 'Encryption password (min 12 chars)',
        validate: (v) => {
          if (!v || v.length < 12) return 'Password must be at least 12 characters';
          return undefined;
        },
      });
      if (p.isCancel(pwResult)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      encryptionPassword = pwResult as string;
    }
  }

  // Confirm before saving
  if (!opts.yes && !opts.json && !hasAllFlags) {
    const confirmed = await p.confirm({
      message: `Save storage configuration (${provider} at ${endpoint})?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const body: Record<string, unknown> = {
    provider,
    endpoint,
    bucket,
    accessKey,
    secretKey,
    encryption,
  };
  if (region) body['region'] = region;
  if (encryptionPassword) body['encryptionPassword'] = encryptionPassword;

  const result = await client.patch<{ ok: boolean; provider: string }>(
    '/api/sync/storage',
    body,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Storage configured: ${pc.cyan(result.provider)}`);
}

// ---------------------------------------------------------------------------
// Test storage connection
// ---------------------------------------------------------------------------

async function testSub(client: ApiClient, opts: StorageOptions): Promise<void> {
  if (!opts.json) {
    process.stdout.write(pc.dim('\n  Testing storage connection...\n'));
  }

  const result = await client.post<StorageTestResult>('/api/sync/storage/test');

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  if (result.ok) {
    p.log.success(
      `Connection successful. Latency: ${pc.cyan(`${result.latency ?? 0}ms`)}`,
    );
  } else {
    p.log.error(`Connection failed: ${result.error ?? 'unknown error'}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Create bucket
// ---------------------------------------------------------------------------

async function createBucketSub(client: ApiClient, opts: StorageOptions): Promise<void> {
  if (!opts.yes && !opts.json) {
    const confirmed = await p.confirm({
      message: 'Create the configured bucket on the storage provider?',
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.post<StorageCreateBucketResult>(
    '/api/sync/storage/create-bucket',
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  if (result.ok) {
    p.log.success(`Bucket "${result.bucket}" created.`);
  } else {
    p.log.error(`Failed to create bucket: ${result.error ?? 'unknown error'}`);
    process.exit(1);
  }
}
