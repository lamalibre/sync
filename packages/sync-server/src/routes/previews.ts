/**
 * Preview (dry-run) management routes.
 *
 * These routes proxy pending sync preview data from the agent's local
 * storage (`~/.sync-agent/pending-syncs/`) to the desktop UI. The server
 * acts as an intermediary since the desktop connects to the server, not
 * directly to the agent.
 *
 * In a multi-agent setup, these operate on the server's own agent directory
 * (set via SYNC_DATA_DIR or ~/.sync/). In production, the agent reports
 * preview data to the server which stores it in the server data directory.
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectIdSchema } from '../lib/schemas.js';
import {
  listPendingSyncs,
  readPendingSync,
  approvePendingSync,
  rejectPendingSync,
} from '@lamalibre/sync-shared';
import { getDataDir } from '../lib/state.js';

export async function previewRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/sync/previews — list all pending sync previews
  server.get('/api/sync/previews', async (_request, reply) => {
    const dataDir = getDataDir();
    const previews = await listPendingSyncs(dataDir);

    // Filter to only pending (non-expired) previews
    const now = Date.now();
    const pending = previews.filter(
      (p) => p.status === 'pending' && new Date(p.expiresAt).getTime() > now,
    );

    // Strip localPath from response — local paths never cross the network
    const sanitized = pending.map(({ localPath: _, ...rest }) => rest);

    return reply.send({ previews: sanitized });
  });

  // GET /api/sync/previews/:projectId — get preview detail for a project
  server.get(
    '/api/sync/previews/:projectId',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const dataDir = getDataDir();
      const preview = await readPendingSync(dataDir, request.params.projectId);

      if (!preview) {
        return reply.status(404).send({
          ok: false,
          error: `No pending preview found for project "${request.params.projectId}"`,
        });
      }

      // Strip localPath from response — local paths never cross the network
      const { localPath: _, ...sanitizedPreview } = preview;

      return reply.send({ preview: sanitizedPreview });
    },
  );

  // POST /api/sync/previews/:projectId/approve — approve a pending preview
  server.post(
    '/api/sync/previews/:projectId/approve',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const dataDir = getDataDir();
      const success = await approvePendingSync(dataDir, request.params.projectId);

      if (!success) {
        return reply.status(404).send({
          ok: false,
          error: `No pending preview found for project "${request.params.projectId}" (may have expired or already been handled)`,
        });
      }

      request.log.info(
        { projectId: request.params.projectId },
        'Preview approved',
      );

      return reply.send({ ok: true });
    },
  );

  // POST /api/sync/previews/:projectId/reject — reject a pending preview
  server.post(
    '/api/sync/previews/:projectId/reject',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const dataDir = getDataDir();
      const success = await rejectPendingSync(dataDir, request.params.projectId);

      if (!success) {
        return reply.status(404).send({
          ok: false,
          error: `No pending preview found for project "${request.params.projectId}" (may have expired or already been handled)`,
        });
      }

      request.log.info(
        { projectId: request.params.projectId },
        'Preview rejected',
      );

      return reply.send({ ok: true });
    },
  );
}
