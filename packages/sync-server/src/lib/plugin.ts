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
import { setupRoutes } from '../routes/setup.js';
import { setDataDir } from './state.js';

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
    await app.register(setupRoutes);

    app.log.info('Sync plugin routes registered');
  };

  return plugin;
}

// ---------------------------------------------------------------------------
// Plugin manifest reader
// ---------------------------------------------------------------------------

/** Shape of the portlama-plugin.json manifest. */
export interface PluginManifest {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly roles: {
    readonly host: {
      readonly package: string;
      readonly binary: string;
      readonly singleton: boolean;
      readonly description: string;
    };
    readonly agent: {
      readonly package: string;
      readonly binary: string;
      readonly singleton: boolean;
      readonly description: string;
    };
  };
  readonly panel: {
    readonly pages: ReadonlyArray<{
      readonly path: string;
      readonly title: string;
      readonly icon: string;
      readonly description: string;
    }>;
    readonly apiPrefix: string;
  };
  readonly capabilities: {
    readonly agent: readonly string[];
  };
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
  if (typeof obj['roles'] !== 'object' || obj['roles'] === null) {
    throw new Error("Plugin manifest must have a 'roles' object field");
  }

  // Trust the shape after basic validation — full Zod validation
  // is done by Portlama when loading the manifest.
  return raw as PluginManifest;
}
