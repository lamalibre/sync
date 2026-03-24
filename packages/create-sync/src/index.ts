import { checkNodeVersion, saveCliConfig as saveCliConfigShared } from '@lamalibre/sync-shared';

checkNodeVersion();

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ensureRclone } from './lib/detect-rclone.js';
import { promptStorageProvider, testConnection, type StorageSetup } from './lib/provider-setup.js';
import { installService } from './lib/service-installer.js';
import { promptAndDecryptBundle } from './lib/bundle.js';

export const PACKAGE_NAME = '@lamalibre/create-sync';

// ---------------------------------------------------------------------------
// Server API helper
// ---------------------------------------------------------------------------

async function apiRequest<T>(
  serverUrl: string,
  method: string,
  path: string,
  body?: unknown,
  apiKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({
      error: `HTTP ${res.status}`,
    }))) as { error: string };
    throw new Error(errBody.error);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Standalone mode setup
// ---------------------------------------------------------------------------

async function standaloneSetup(): Promise<void> {
  // Step 1: Server URL
  const serverUrlInput = await p.text({
    message: 'Sync server URL',
    placeholder: 'http://localhost:9393',
    defaultValue: 'http://localhost:9393',
  });
  if (p.isCancel(serverUrlInput)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  const serverUrl = serverUrlInput.replace(/\/+$/, '');

  // Step 2: Check if server is reachable
  const healthSpinner = p.spinner();
  healthSpinner.start('Checking server...');
  try {
    await apiRequest(serverUrl, 'GET', '/api/sync/health');
    healthSpinner.stop(pc.green('Server is reachable.'));
  } catch {
    healthSpinner.stop(pc.red('Server is not reachable'));
    p.log.error(`Could not connect to ${serverUrl}. Make sure the sync server is running.`);
    p.log.info(`Start the server with: ${pc.cyan('npx @lamalibre/sync-server')}`);
    process.exit(1);
  }

  // Step 3: Generate API key
  const generateKey = await p.confirm({
    message: 'Generate an API key for authentication?',
    initialValue: true,
  });
  if (p.isCancel(generateKey)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  let apiKey: string | undefined;
  if (generateKey) {
    const keySpinner = p.spinner();
    keySpinner.start('Generating API key...');
    try {
      const result = await apiRequest<{ ok: boolean; apiKey: string }>(
        serverUrl,
        'POST',
        '/api/sync/setup/api-key',
      );
      apiKey = result.apiKey;
      keySpinner.stop(pc.green('API key generated.'));
      p.note(
        `${pc.bold('API Key:')} ${apiKey}\n\n` +
          `${pc.yellow('Save this key! It cannot be retrieved later.')}`,
        'Authentication',
      );
    } catch (err: unknown) {
      keySpinner.stop(pc.yellow('API key generation skipped'));
      p.log.warn(
        `Could not generate API key: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      p.log.info('You can set up authentication manually later.');
    }
  }

  // Step 4: Storage provider setup
  p.log.step('Configure storage provider');
  const storage = await promptStorageProvider();
  if (!storage) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  // Step 5: Test connection
  const connectionOk = await testConnection(storage);
  if (!connectionOk) {
    const cont = await p.confirm({
      message: 'Connection test failed. Continue anyway?',
      initialValue: false,
    });
    if (p.isCancel(cont) || !cont) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
  }

  // Step 6: Save storage config to server
  const saveSpinner = p.spinner();
  saveSpinner.start('Saving storage configuration...');
  try {
    await apiRequest(
      serverUrl,
      'PATCH',
      '/api/sync/storage',
      {
        provider: storage.provider,
        endpoint: storage.endpoint,
        bucket: storage.bucket,
        region: storage.region || undefined,
        accessKey: storage.accessKey,
        secretKey: storage.secretKey,
      },
      apiKey,
    );
    saveSpinner.stop(pc.green('Storage configuration saved.'));
  } catch (err: unknown) {
    saveSpinner.stop(pc.red('Failed to save storage config'));
    p.log.error(err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  }

  // Step 7: Create first project
  await createFirstProject(serverUrl, apiKey);

  // Step 8: Install agent service
  const installAgent = await p.confirm({
    message: 'Install sync-agent as a system service?',
    initialValue: true,
  });

  if (!p.isCancel(installAgent) && installAgent && apiKey) {
    await installService(serverUrl, apiKey);
  } else if (!apiKey) {
    p.log.warn('Skipping agent installation: no API key generated.');
  }

  // Step 9: Save CLI config
  await saveCliConfig(serverUrl, apiKey);

  // Summary
  printSummary(serverUrl, storage, apiKey);
}

// ---------------------------------------------------------------------------
// Bundle mode setup
// ---------------------------------------------------------------------------

async function bundleSetup(): Promise<void> {
  const bundle = await promptAndDecryptBundle();
  if (!bundle) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const serverUrl = bundle.serverUrl;
  const apiKey = bundle.apiKey;

  // Verify server connectivity
  const healthSpinner = p.spinner();
  healthSpinner.start('Checking server...');
  try {
    await apiRequest(serverUrl, 'GET', '/api/sync/health');
    healthSpinner.stop(pc.green('Server is reachable.'));
  } catch {
    healthSpinner.stop(pc.red('Server is not reachable'));
    p.log.error(`Could not connect to ${serverUrl}`);
    process.exit(1);
  }

  p.log.success(
    `Bundle contains ${bundle.projects.length} project(s) with ${bundle.storage.provider} storage.`,
  );

  // Install agent service
  const installAgent = await p.confirm({
    message: 'Install sync-agent as a system service?',
    initialValue: true,
  });

  if (!p.isCancel(installAgent) && installAgent) {
    await installService(serverUrl, apiKey);
  }

  // Save CLI config
  await saveCliConfig(serverUrl, apiKey);

  p.outro(pc.green('Setup complete! Your sync agent is configured.'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createFirstProject(serverUrl: string, apiKey?: string): Promise<void> {
  const createProject = await p.confirm({
    message: 'Create your first sync project?',
    initialValue: true,
  });

  if (p.isCancel(createProject) || !createProject) return;

  const name = await p.text({
    message: 'Project name',
    placeholder: 'my-project',
    validate: (v) => {
      if (!v) return 'Project name is required';
      if (v.length > 100) return 'Max 100 characters';
      return undefined;
    },
  });
  if (p.isCancel(name)) return;

  const localPath = await p.text({
    message: 'Local directory path to sync',
    placeholder: '/Users/you/projects/my-project',
    validate: (v) => {
      if (!v) return 'Path is required';
      if (!v.startsWith('/')) return 'Must be an absolute path';
      return undefined;
    },
  });
  if (p.isCancel(localPath)) return;

  const direction = await p.select({
    message: 'Sync direction',
    options: [
      { value: 'push', label: 'Push', hint: 'Local -> Cloud' },
      { value: 'pull', label: 'Pull', hint: 'Cloud -> Local' },
      {
        value: 'bidirectional',
        label: 'Bidirectional',
        hint: 'Both directions (bisync)',
      },
    ],
  });
  if (p.isCancel(direction)) return;

  const projectSpinner = p.spinner();
  projectSpinner.start('Creating project...');
  try {
    await apiRequest(
      serverUrl,
      'POST',
      '/api/sync/projects',
      {
        name,
        localPath,
        direction,
      },
      apiKey,
    );
    projectSpinner.stop(pc.green(`Project "${name}" created.`));
  } catch (err: unknown) {
    projectSpinner.stop(pc.red('Failed to create project'));
    p.log.error(err instanceof Error ? err.message : 'Unknown error');
  }
}

async function saveCliConfig(serverUrl: string, apiKey?: string): Promise<void> {
  try {
    await saveCliConfigShared({ serverUrl, apiKey });
  } catch {
    // best-effort
  }
}

function printSummary(serverUrl: string, storage: StorageSetup, apiKey?: string): void {
  const summaryLines = [
    `Server:   ${serverUrl}`,
    `Provider: ${storage.provider}`,
    `Bucket:   ${storage.bucket}`,
    `Auth:     ${apiKey ? 'API key configured' : 'no authentication'}`,
    '',
    'Next steps:',
    `  ${pc.cyan('sync-cli status')}      - Check sync status`,
    `  ${pc.cyan('sync-cli trigger')}     - Trigger a sync`,
    `  ${pc.cyan('sync-cli projects')}    - Manage projects`,
  ];

  p.note(summaryLines.join('\n'), 'Setup Complete');
  p.outro(pc.green('Happy syncing!'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  p.intro(pc.bold(pc.cyan(' create-sync ')));

  p.log.info(
    'Welcome to the Sync installer. This will set up file synchronization\n' +
      'with your cloud storage provider.\n',
  );

  // Step 1: Check rclone
  const rcloneOk = await ensureRclone();
  if (!rcloneOk) {
    process.exit(1);
  }

  // Step 2: Choose mode
  const mode = await p.select({
    message: 'How would you like to set up?',
    options: [
      {
        value: 'standalone',
        label: 'Standalone',
        hint: 'Configure storage and projects from scratch',
      },
      {
        value: 'bundle',
        label: 'Config bundle',
        hint: 'Import settings from an encrypted bundle file',
      },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  if (mode === 'standalone') {
    await standaloneSetup();
  } else {
    await bundleSetup();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\nFatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
