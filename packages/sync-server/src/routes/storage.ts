import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { execa } from 'execa';
import { buildRcloneIni } from '@lamalibre/sync-shared';
import { storageUpdateSchema } from '../lib/schemas.js';
import {
  loadConfig,
  saveConfig,
  encryptStorageConfig,
  decryptStorageConfig,
  redactStorageConfig,
  getDataDir,
} from '../lib/state.js';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/sync/storage — current provider config (credentials redacted)
  server.get('/api/sync/storage', async (_request, reply) => {
    const config = await loadConfig();
    if (!config.storage) {
      return reply.send({
        configured: false,
        provider: null,
        lastTested: null,
        testResult: null,
      });
    }

    return reply.send({
      ...redactStorageConfig(config.storage),
      lastTested: config.lastTested,
      testResult: config.testResult,
    });
  });

  // PATCH /api/sync/storage — update provider config
  server.patch(
    '/api/sync/storage',
    {
      schema: {
        body: storageUpdateSchema,
      },
    },
    async (request, reply) => {
      const body = request.body;
      const config = await loadConfig();

      config.storage = await encryptStorageConfig(body);
      config.lastTested = null;
      config.testResult = null;
      await saveConfig(config);

      return reply.send({ ok: true, provider: body.provider });
    },
  );

  // POST /api/sync/storage/test — test connection
  server.post('/api/sync/storage/test', async (_request, reply) => {
    const config = await loadConfig();
    if (!config.storage) {
      return reply.status(400).send({
        ok: false,
        error: 'Storage not configured',
      });
    }

    const decrypted = await decryptStorageConfig(config.storage);
    const rcloneConf = buildTempRcloneConfig(decrypted);
    const confPath = join(getDataDir(), `rclone-test-${randomUUID()}.conf`);

    await writeFile(confPath, rcloneConf, { mode: 0o600 });

    const start = Date.now();
    try {
      await execa('rclone', ['lsd', `sync-remote:${decrypted.bucket}`, '--config', confPath]);

      const latency = Date.now() - start;
      config.lastTested = new Date().toISOString();
      config.testResult = 'ok';
      await saveConfig(config);

      return reply.send({
        ok: true,
        latency,
        message: 'Connection successful. Bucket is accessible.',
      });
    } catch (err: unknown) {
      config.lastTested = new Date().toISOString();
      config.testResult = 'error';
      await saveConfig(config);

      const message = sanitizeRcloneError(err);
      return reply.status(502).send({
        ok: false,
        error: message,
      });
    } finally {
      await unlink(confPath).catch(() => {});
    }
  });

  // POST /api/sync/storage/create-bucket — create bucket
  server.post(
    '/api/sync/storage/create-bucket',
    {
      schema: {
        body: z
          .object({
            bucket: z.string().min(1).max(255).optional(),
          })
          .optional(),
      },
    },
    async (request, reply) => {
      const config = await loadConfig();
      if (!config.storage) {
        return reply.status(400).send({
          ok: false,
          error: 'Storage not configured',
        });
      }

      const decrypted = await decryptStorageConfig(config.storage);
      const bucketName =
        (request.body as { bucket?: string } | undefined)?.bucket ?? decrypted.bucket;
      const rcloneConf = buildTempRcloneConfig(decrypted);
      const confPath = join(getDataDir(), `rclone-test-${randomUUID()}.conf`);

      await writeFile(confPath, rcloneConf, { mode: 0o600 });

      try {
        await execa('rclone', ['mkdir', `sync-remote:${bucketName}`, '--config', confPath]);

        return reply.send({
          ok: true,
          bucket: bucketName,
          created: true,
        });
      } catch (err: unknown) {
        const message = sanitizeRcloneError(err);
        return reply.status(502).send({
          ok: false,
          error: message,
        });
      } finally {
        await unlink(confPath).catch(() => {});
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize rclone error messages to prevent credential leakage in API responses.
 * Extracts only the first line and redacts sensitive keywords.
 */
function sanitizeRcloneError(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Connection test failed';
  }
  return (err.message.split('\n')[0] ?? '').replace(/key|secret|password|token/gi, '[REDACTED]');
}

function buildTempRcloneConfig(storage: {
  provider: string;
  endpoint: string;
  bucket: string;
  region?: string;
  accessKey: string;
  secretKey: string;
}): string {
  return buildRcloneIni({
    provider: storage.provider,
    accessKey: storage.accessKey,
    secretKey: storage.secretKey,
    endpoint: storage.endpoint,
    bucket: storage.bucket,
    region: storage.region,
  });
}
