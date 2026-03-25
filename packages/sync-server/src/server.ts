import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { healthRoutes } from './routes/health.js';
import { storageRoutes } from './routes/storage.js';
import { projectRoutes } from './routes/projects.js';
import { syncRoutes } from './routes/sync.js';
import { statusRoutes } from './routes/status.js';
import { agentRoutes } from './routes/agent.js';
import { agentRegistryRoutes } from './routes/agents.js';
import { archiveRoutes } from './routes/archive.js';
import { trashRoutes } from './routes/trash.js';
import { setupRoutes } from './routes/setup.js';
import { registerAuthHook } from './lib/auth.js';
import { purgeExpiredProjects, loadConfig } from './lib/state.js';
import { DEFAULT_SOFT_DELETE_CONFIG } from '@lamalibre/sync-shared';

export interface BuildServerOptions {
  logger?: boolean;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    bodyLimit: 1_048_576, // 1 MB
  });

  // Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — default to localhost origins only; override with SYNC_CORS_ORIGIN env var
  await app.register(cors, {
    origin: process.env['SYNC_CORS_ORIGIN'] ?? /^https?:\/\/localhost(:\d+)?$/,
  });

  // Authentication
  registerAuthHook(app);

  // Error handler with proper Zod validation support
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    // Handle Zod validation errors from fastify-type-provider-zod
    if (error.validation) {
      return reply.status(400).send({
        ok: false,
        error: 'Validation error',
        details: error.validation,
      });
    }

    // Handle known status codes
    if (error.statusCode) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: error.message,
      });
    }

    // Unexpected errors
    app.log.error(error, 'Unhandled error');
    return reply.status(500).send({
      ok: false,
      error: 'Internal server error',
    });
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(storageRoutes);
  await app.register(projectRoutes);
  await app.register(syncRoutes);
  await app.register(statusRoutes);
  await app.register(agentRoutes);
  await app.register(agentRegistryRoutes);
  await app.register(archiveRoutes);
  await app.register(trashRoutes);
  await app.register(setupRoutes);

  // Periodically purge soft-deleted projects past retention (every 6 hours)
  const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const purgeTimer = setInterval(async () => {
    try {
      const config = await loadConfig();
      const retentionDays = config.softDelete?.retentionDays ?? DEFAULT_SOFT_DELETE_CONFIG.retentionDays;
      const purged = await purgeExpiredProjects(retentionDays);
      if (purged > 0) {
        app.log.info({ purged }, 'Purged expired soft-deleted projects');
      }
    } catch (err: unknown) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to purge expired projects');
    }
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  return app;
}
