/**
 * Portlama plugin integration for sync-server.
 *
 * When running as a Portlama plugin, the sync-server registers its routes
 * into the host Fastify instance rather than creating its own server.
 * Authentication is handled by Portlama via mTLS (the host decorates
 * requests with verified client identity).
 *
 * When running standalone, the existing buildServer() + main() path is used.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyError } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { healthRoutes } from '../routes/health.js';
import { storageRoutes } from '../routes/storage.js';
import { projectRoutes } from '../routes/projects.js';
import { syncRoutes } from '../routes/sync.js';
import { statusRoutes } from '../routes/status.js';
import { agentRoutes } from '../routes/agent.js';
import { agentRegistryRoutes } from '../routes/agents.js';
import { archiveRoutes } from '../routes/archive.js';
import { previewRoutes } from '../routes/previews.js';
import { approvalRoutes } from '../routes/approvals.js';
import { trashRoutes } from '../routes/trash.js';
import { setupRoutes } from '../routes/setup.js';
import { setDataDir, loadConfig, saveConfig, encryptStorageConfig } from './state.js';
import type { StorageConfig } from './schemas.js';
import { TicketInstanceManager, type TicketCertConfig } from '@lamalibre/portlama-tickets';

// ---------------------------------------------------------------------------
// Plugin mode detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the server is running as a Portlama plugin.
 *
 * Detection is based on:
 * 1. `PORTLAMA_PLUGIN` environment variable set to "1" or "true"
 * 2. `PORTLAMA_DATA_DIR` environment variable providing a data directory
 */
export function isPluginMode(): boolean {
  const flag = process.env['PORTLAMA_PLUGIN'];
  return flag === '1' || flag === 'true';
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface PluginOptions {
  /**
   * Data directory for state storage.
   * In plugin mode, Portlama provides this instead of ~/.sync/.
   * Falls back to PORTLAMA_DATA_DIR env var, then ~/.sync/.
   */
  readonly dataDir?: string;

  /**
   * When true, the plugin skips registering its own auth hook.
   * Portlama provides authentication via mTLS — the host Fastify
   * instance decorates requests before they reach plugin routes.
   */
  readonly skipAuth?: boolean;

  /**
   * Route prefix to mount under.
   * Defaults to empty string (routes already contain /api/sync prefix).
   */
  readonly prefix?: string;

  /**
   * Panel URL for ticket system integration.
   * When provided along with `ticketCerts`, the plugin registers a
   * `sync:connect` ticket instance and manages tickets for agents.
   * Only used in plugin mode.
   */
  readonly panelUrl?: string;

  /**
   * mTLS certificate paths for ticket system API calls.
   * Required when `panelUrl` is set.
   */
  readonly ticketCerts?: TicketCertConfig;

  /**
   * Storage configuration injected by Portlama.
   * When provided, sync uses this instead of its own storage config.
   * The `prefix` field ensures bucket isolation per Portlama server.
   */
  readonly storage?: {
    readonly provider: string;
    readonly region?: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly prefix: string;
  };
}

// ---------------------------------------------------------------------------
// buildPlugin
// ---------------------------------------------------------------------------

/**
 * Build a Fastify plugin that registers all sync-server routes.
 *
 * This is the entry point for Portlama plugin mode. Portlama calls:
 * ```ts
 * import { buildPlugin } from '@lamalibre/sync-server';
 * await app.register(buildPlugin(), { prefix: '/api/sync' });
 * ```
 *
 * The plugin does NOT create its own Fastify instance — it registers
 * routes into the host instance provided by Portlama.
 */
export function buildPlugin(options?: PluginOptions): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
    // Configure data directory
    const dataDir =
      options?.dataDir ?? process.env['PORTLAMA_DATA_DIR'] ?? process.env['SYNC_DATA_DIR'];

    if (dataDir) {
      setDataDir(dataDir);
    }

    // Inject storage config from Portlama if provided.
    // This converts the plaintext storage into sync's encrypted format and
    // stores it via the normal state mechanism, making it indistinguishable
    // from manually configured storage to all downstream code.
    if (options?.storage) {
      const injected = options.storage;
      const plain: StorageConfig = {
        provider: injected.provider as StorageConfig['provider'],
        endpoint: injected.endpoint,
        bucket: injected.bucket,
        ...(injected.region ? { region: injected.region } : {}),
        accessKey: injected.accessKey,
        secretKey: injected.secretKey,
        encryption: false,
      };

      const config = await loadConfig();
      config.storage = await encryptStorageConfig(plain);
      config.storagePrefix = injected.prefix;
      await saveConfig(config);
    }

    // Set up Zod validation compilers (if not already set by host)
    try {
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
    } catch {
      // If the host already set compilers, Fastify may throw.
      // This is fine — the host's compilers will be used.
      app.log.debug('Validator/serializer compilers already set by host, using host compilers');
    }

    // Plugin-mode error handler for sync routes (scoped to this plugin)
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.validation) {
        return reply.status(400).send({
          ok: false,
          error: 'Validation error',
          details: error.validation,
        });
      }

      if (error.statusCode) {
        return reply.status(error.statusCode).send({
          ok: false,
          error: error.message,
        });
      }

      app.log.error(error, 'Unhandled error in sync plugin');
      return reply.status(500).send({
        ok: false,
        error: 'Internal server error',
      });
    });

    // In plugin mode, Portlama handles auth via mTLS.
    // In standalone mode (when buildPlugin is used with skipAuth=false),
    // the caller is responsible for auth — but we don't register our own
    // auth hook here because the host manages authentication.
    //
    // If someone uses buildPlugin in standalone mode and wants API key auth,
    // they should use buildServer() instead, or add their own auth hook.

    // Register all sync routes
    await app.register(healthRoutes);
    await app.register(storageRoutes);
    await app.register(projectRoutes);
    await app.register(syncRoutes);
    await app.register(statusRoutes);
    await app.register(agentRoutes);
    await app.register(agentRegistryRoutes);
    await app.register(archiveRoutes);
    await app.register(trashRoutes);
    await app.register(previewRoutes);
    await app.register(approvalRoutes);
    await app.register(setupRoutes);

    app.log.info('Sync plugin routes registered');

    // Start ticket manager if panel URL and certs are provided.
    // This registers a sync:connect ticket instance and handles
    // ticket lifecycle for agent authorization.
    const panelUrl =
      options?.panelUrl ?? process.env['PORTLAMA_PANEL_URL'];
    const ticketCerts = options?.ticketCerts ?? readTicketCertsFromEnv();

    if (panelUrl && ticketCerts) {
      const ticketManager = new TicketInstanceManager({
        panelUrl,
        certs: ticketCerts,
        scope: 'sync:connect',
        transport: {
          strategies: ['tunnel'],
          preferred: 'tunnel',
        },
        logger: app.log,
      });

      // Decorate the Fastify instance so routes can access the ticket manager
      // (e.g., to request tickets when agents register).
      app.decorate('ticketManager', ticketManager);

      // Expose panelUrl and ticketCerts so routes (e.g., delegated enrollment
      // in agent registration) can create their own mTLS dispatchers.
      app.decorate('pluginContext', { panelUrl, ticketCerts } as PluginContext);

      // Start asynchronously — don't block route registration
      void ticketManager.start().catch((err: unknown) => {
        app.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to start ticket manager',
        );
      });

      // Graceful shutdown
      app.addHook('onClose', async () => {
        await ticketManager.stop();
      });

      app.log.info('Ticket manager configured');
    }
  };

  return plugin;
}

// ---------------------------------------------------------------------------
// Ticket cert helpers
// ---------------------------------------------------------------------------

/**
 * Read ticket certificate paths from environment variables.
 * Returns null if any required variable is missing.
 */
function readTicketCertsFromEnv(): TicketCertConfig | null {
  const certPath = process.env['PORTLAMA_CERT_PATH'];
  const keyPath = process.env['PORTLAMA_KEY_PATH'];
  const caPath = process.env['PORTLAMA_CA_PATH'];

  if (!certPath || !keyPath || !caPath) return null;

  return { certPath, keyPath, caPath };
}

// ---------------------------------------------------------------------------
// Fastify type augmentation for ticket manager
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plugin context for route access
// ---------------------------------------------------------------------------

/** Portlama panel connection details, available in plugin mode when ticket certs are configured. */
export interface PluginContext {
  readonly panelUrl: string;
  readonly ticketCerts: TicketCertConfig;
}

declare module 'fastify' {
  interface FastifyInstance {
    ticketManager?: TicketInstanceManager;
    /** Portlama panel connection context (available in plugin mode with ticket certs). */
    pluginContext?: PluginContext;
  }
}

// ---------------------------------------------------------------------------
// Plugin manifest reader
// ---------------------------------------------------------------------------

/** Shape of the portlama-plugin.json manifest (new format). */
export interface PluginManifest {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly packages: {
    readonly server: string;
    readonly agent: string;
  };
  readonly panel: {
    readonly pages: ReadonlyArray<{
      readonly path: string;
      readonly title: string;
      readonly icon: string;
    }>;
  };
  readonly config: Record<string, unknown>;
}

/**
 * Read the plugin manifest from a JSON object.
 * In production, Portlama reads portlama-plugin.json from the package root.
 * This function validates the structure at runtime.
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Plugin manifest must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['name'] !== 'string') {
    throw new Error("Plugin manifest must have a 'name' string field");
  }
  if (typeof obj['version'] !== 'string') {
    throw new Error("Plugin manifest must have a 'version' string field");
  }
  if (!Array.isArray(obj['capabilities'])) {
    throw new Error("Plugin manifest must have a 'capabilities' array field");
  }
  if (typeof obj['packages'] !== 'object' || obj['packages'] === null) {
    throw new Error("Plugin manifest must have a 'packages' object field");
  }

  // Trust the shape after basic validation — full Zod validation
  // is done by Portlama when loading the manifest.
  return raw as PluginManifest;
}
