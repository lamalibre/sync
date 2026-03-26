import { randomBytes } from 'node:crypto';
import { checkNodeVersion } from '@lamalibre/sync-shared';
import { buildServer } from './server.js';
import { loadConfig, setDataDir } from './lib/state.js';

checkNodeVersion();

export const PACKAGE_NAME = '@lamalibre/sync-server';

export { buildServer } from './server.js';
export { generateApiKey, setupApiKey, hashApiKey, clearAuthCache } from './lib/auth.js';
export {
  buildPlugin,
  isPluginMode,
  parsePluginManifest,
  type PluginOptions,
  type PluginManifest,
} from './lib/plugin.js';
export {
  TicketInstanceManager,
  type TicketCertConfig,
  type TicketInstanceManagerOptions,
} from '@lamalibre/portlama-tickets';

export async function main(): Promise<void> {
  const config = await loadConfig();
  const port = Number(process.env['SYNC_PORT']) || config.port || 9393;

  if (process.env['SYNC_DATA_DIR']) {
    setDataDir(process.env['SYNC_DATA_DIR']);
  }

  const app = await buildServer({ logger: true });

  // If no API key is configured, generate a one-time setup token that must be
  // provided in the X-Setup-Token header when calling the setup endpoint.
  // This prevents a race condition where an attacker could claim the setup
  // endpoint before the legitimate administrator.
  if (!config.apiKeyHash) {
    const setupToken = randomBytes(16).toString('hex');
    app.decorate('setupToken', setupToken);
    app.log.info(`\n  Setup token: ${setupToken}\n  Use this token to generate your API key.\n`);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down gracefully');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const host = process.env['SYNC_HOST'] ?? '127.0.0.1';
    await app.listen({ port, host });
    app.log.info({ port, host }, `${PACKAGE_NAME} listening`);

    // Warn if the server is exposed on a non-loopback address without TLS
    if (host !== '127.0.0.1' && host !== 'localhost' && !process.env['SYNC_TLS_CERT']) {
      app.log.warn(
        'Server is listening on a non-loopback address without TLS. ' +
          'Credentials may be exposed over the network.',
      );
    }
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// main() is called from bin/sync-server.mjs, not here.
// This module only exports — it does not auto-start the server on import.
