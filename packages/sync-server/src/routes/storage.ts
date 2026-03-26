import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { execa } from 'execa';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildRcloneIni, sanitizeRcloneError } from '@lamalibre/sync-shared';
import { storageUpdateSchema } from '../lib/schemas.js';
import {
  loadConfig,
  saveConfig,
  encryptStorageConfig,
  decryptStorageConfig,
  redactStorageConfig,
  getDataDir,
} from '../lib/state.js';

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

    await writeExclusiveFile(confPath, rcloneConf);

    const start = Date.now();
    try {
      await execa('rclone', ['lsd', `sync-remote:${decrypted.bucket}`, '--config', confPath], {
        extendEnv: false,
        env: buildMinimalRcloneEnv(confPath),
      });

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

      const message = sanitizeRcloneErrorResponse(err);
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
            bucket: z.string().min(1).max(255)
              .refine((v) => !/[\r\n]/.test(v), 'Bucket name must not contain newlines')
              .refine((v) => !v.includes(':'), 'Bucket name must not contain colons')
              .optional(),
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
      const parsed = request.body as { bucket?: string } | undefined;
      const bucketName = parsed?.bucket ?? decrypted.bucket;
      const rcloneConf = buildTempRcloneConfig(decrypted);
      const confPath = join(getDataDir(), `rclone-test-${randomUUID()}.conf`);

      await writeExclusiveFile(confPath, rcloneConf);

      try {
        await execa('rclone', ['mkdir', `sync-remote:${bucketName}`, '--config', confPath], {
          extendEnv: false,
          env: buildMinimalRcloneEnv(confPath),
        });

        return reply.send({
          ok: true,
          bucket: bucketName,
          created: true,
        });
      } catch (err: unknown) {
        const message = sanitizeRcloneErrorResponse(err);
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
 * Build a minimal environment for server-side rclone commands.
 * Prevents leaking parent env vars like RCLONE_CONFIG_PASS.
 */
function buildMinimalRcloneEnv(confPath: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    RCLONE_CONFIG: confPath,
  };
}

/**
 * Extract and sanitize rclone error messages for API responses.
 * Uses the shared sanitizer for consistent credential redaction.
 */
function sanitizeRcloneErrorResponse(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Connection test failed';
  }
  // Take first line only (most relevant), then run through shared sanitizer
  const firstLine = err.message.split('\n')[0] ?? '';
  return sanitizeRcloneError(firstLine);
}

/**
 * Write a temporary file exclusively with O_CREAT | O_EXCL to guarantee
 * the file is freshly created with the correct permissions (0600).
 * Unlike `writeFile` with a `mode` option, this never reuses a stale file.
 */
async function writeExclusiveFile(filePath: string, content: string): Promise<void> {
  const fd = await open(filePath, 'wx', 0o600);
  try {
    await fd.writeFile(content);
    await fd.sync();
  } finally {
    await fd.close();
  }
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
