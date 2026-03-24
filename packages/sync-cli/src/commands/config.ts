import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { loadCliConfig } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';

interface StorageInfo {
  configured: boolean;
  provider: string | null;
  endpoint?: string;
  bucket?: string;
  region?: string;
  encryption?: boolean;
  lastTested: string | null;
  testResult: string | null;
}

interface ConfigOptions {
  json?: boolean;
}

export async function configCommand(client: ApiClient, opts: ConfigOptions): Promise<void> {
  const cliConfig = await loadCliConfig();
  const storage = await client.get<StorageInfo>('/api/sync/storage');

  if (opts.json) {
    process.stdout.write(jsonOutput({ cli: cliConfig, storage }) + '\n');
    return;
  }

  process.stdout.write(pc.bold('\nCLI Configuration\n\n'));
  process.stdout.write(`  Server URL: ${pc.cyan(cliConfig.serverUrl)}\n`);
  process.stdout.write(
    `  API Key:    ${cliConfig.apiKey ? pc.green('configured') : pc.dim('not set')}\n`,
  );

  process.stdout.write(pc.bold('\n\nServer Storage\n\n'));

  if (!storage.configured) {
    process.stdout.write(
      `  ${pc.yellow('Storage not configured.')} Run the installer to set up a provider.\n\n`,
    );
    return;
  }

  process.stdout.write(
    `  Provider:   ${storage.provider}\n` +
      `  Endpoint:   ${storage.endpoint ?? pc.dim('n/a')}\n` +
      `  Bucket:     ${storage.bucket ?? pc.dim('n/a')}\n` +
      `  Region:     ${storage.region ?? pc.dim('n/a')}\n` +
      `  Encryption: ${storage.encryption ? pc.green('enabled') : pc.dim('disabled')}\n` +
      `  Tested:     ${storage.testResult === 'ok' ? pc.green('ok') : storage.testResult === 'error' ? pc.red('error') : pc.dim('not tested')}\n\n`,
  );
}
