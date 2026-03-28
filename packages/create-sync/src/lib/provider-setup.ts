import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { buildRcloneIni } from '@lamalibre/sync-shared';
import { mkdir, open as fsOpen } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

interface ProviderDef {
  label: string;
  hint: string;
  rcloneType: string;
  needsEndpoint: boolean;
  defaultEndpoint?: string;
  needsRegion: boolean;
}

const PROVIDERS: Record<string, ProviderDef> = {
  s3: {
    label: 'Amazon S3',
    hint: 'AWS S3',
    rcloneType: 's3',
    needsEndpoint: false,
    defaultEndpoint: 'https://s3.amazonaws.com',
    needsRegion: true,
  },
  spaces: {
    label: 'DigitalOcean Spaces',
    hint: 'S3-compatible object storage',
    rcloneType: 's3',
    needsEndpoint: true,
    needsRegion: true,
  },
  gcs: {
    label: 'Google Cloud Storage',
    hint: 'GCS',
    rcloneType: 'gcs',
    needsEndpoint: false,
    defaultEndpoint: 'https://storage.googleapis.com',
    needsRegion: true,
  },
  azure: {
    label: 'Azure Blob Storage',
    hint: 'Microsoft Azure',
    rcloneType: 'azureblob',
    needsEndpoint: false,
    defaultEndpoint: 'https://blob.core.windows.net',
    needsRegion: false,
  },
  b2: {
    label: 'Backblaze B2',
    hint: 'Affordable cloud storage',
    rcloneType: 'b2',
    needsEndpoint: false,
    defaultEndpoint: 'https://api.backblazeb2.com',
    needsRegion: false,
  },
};

// ---------------------------------------------------------------------------
// Storage configuration
// ---------------------------------------------------------------------------

export interface StorageSetup {
  provider: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export async function promptStorageProvider(): Promise<StorageSetup | null> {
  const providerChoice = await p.select({
    message: 'Select your storage provider',
    options: Object.entries(PROVIDERS).map(([key, def]) => ({
      value: key,
      label: def.label,
      hint: def.hint,
    })),
  });

  if (p.isCancel(providerChoice)) return null;

  const provider = providerChoice as string;
  const def = PROVIDERS[provider]!;

  // Endpoint
  let endpoint = def.defaultEndpoint ?? '';
  if (def.needsEndpoint) {
    const epInput = await p.text({
      message: 'Enter the endpoint URL',
      placeholder: 'https://ams3.digitaloceanspaces.com',
      validate: (v) => {
        if (!v) return 'Endpoint is required';
        try {
          new URL(v);
        } catch {
          return 'Must be a valid URL';
        }
        return undefined;
      },
    });
    if (p.isCancel(epInput)) return null;
    endpoint = epInput;
  }

  // Region
  let region = '';
  if (def.needsRegion) {
    const regionInput = await p.text({
      message: 'Enter the region',
      placeholder: provider === 'spaces' ? 'ams3' : 'us-east-1',
      defaultValue: provider === 's3' ? 'us-east-1' : undefined,
    });
    if (p.isCancel(regionInput)) return null;
    region = regionInput;
  }

  // Bucket
  const bucketInput = await p.text({
    message: 'Enter the bucket name',
    placeholder: 'my-sync-bucket',
    validate: (v) => {
      if (!v) return 'Bucket name is required';
      if (v.length > 255) return 'Bucket name too long';
      return undefined;
    },
  });
  if (p.isCancel(bucketInput)) return null;

  // Access key
  const accessKeyLabel =
    provider === 'azure'
      ? 'storage account name'
      : provider === 'gcs'
        ? 'service account credentials (JSON path or key)'
        : 'access key';

  const accessKeyInput = await p.text({
    message: `Enter your ${accessKeyLabel}`,
    validate: (v) => {
      if (!v) return `${accessKeyLabel} is required`;
      return undefined;
    },
  });
  if (p.isCancel(accessKeyInput)) return null;

  // Secret key
  const secretKeyLabel =
    provider === 'azure'
      ? 'storage account key'
      : provider === 'b2'
        ? 'application key'
        : 'secret key';

  const secretKeyInput = await p.password({
    message: `Enter your ${secretKeyLabel}`,
    validate: (v) => {
      if (!v) return `${secretKeyLabel} is required`;
      return undefined;
    },
  });
  if (p.isCancel(secretKeyInput)) return null;

  return {
    provider,
    endpoint,
    bucket: bucketInput,
    region,
    accessKey: accessKeyInput,
    secretKey: secretKeyInput,
  };
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export async function testConnection(setup: StorageSetup): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start('Testing connection...');

  const confContent = buildRcloneConfig(setup);
  const confPath = join(tmpdir(), `sync-test-${randomBytes(16).toString('hex')}.conf`);

  try {
    await mkdir(tmpdir(), { recursive: true });
    // Use O_CREAT | O_EXCL ('wx') to prevent symlink races on the temp file
    const fd = await fsOpen(confPath, 'wx', 0o600);
    try {
      await fd.writeFile(confContent);
      await fd.sync();
    } finally {
      await fd.close();
    }

    await execa('rclone', ['lsd', `sync-remote:${setup.bucket}`, '--config', confPath]);

    spinner.stop(pc.green('Connection successful!'));
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    spinner.stop(pc.red('Connection failed'));
    p.log.error(`Connection test failed: ${message}`);

    // Offer to create bucket
    const createBucket = await p.confirm({
      message: `Bucket "${setup.bucket}" may not exist. Try to create it?`,
    });

    if (p.isCancel(createBucket) || !createBucket) {
      return false;
    }

    const createSpinner = p.spinner();
    createSpinner.start(`Creating bucket "${setup.bucket}"...`);

    try {
      await execa('rclone', ['mkdir', `sync-remote:${setup.bucket}`, '--config', confPath]);
      createSpinner.stop(pc.green('Bucket created!'));
      return true;
    } catch (createErr: unknown) {
      const createMessage = createErr instanceof Error ? createErr.message : 'Unknown error';
      createSpinner.stop(pc.red('Failed to create bucket'));
      p.log.error(createMessage);
      return false;
    }
  } finally {
    // Clean up temp config
    const { rm } = await import('node:fs/promises');
    await rm(confPath, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// rclone config builder (delegates to shared)
// ---------------------------------------------------------------------------

function buildRcloneConfig(setup: StorageSetup): string {
  return buildRcloneIni({
    provider: setup.provider,
    accessKey: setup.accessKey,
    secretKey: setup.secretKey,
    endpoint: setup.endpoint,
    bucket: setup.bucket,
    region: setup.region,
  });
}
