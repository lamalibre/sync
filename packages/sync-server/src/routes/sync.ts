import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getProject,
  getActiveOperation,
  setActiveOperation,
  loadConfig,
  addHistoryEntry,
  updateProjectStatus,
  NotFoundError,
} from '../lib/state.js';
import type { SyncOperation, ActiveOperation } from '../lib/schemas.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/sync/projects/:projectId/sync — trigger sync
  server.post(
    '/api/sync/projects/:projectId/sync',
    {
      schema: {
        params: z.object({
          projectId: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists
      let project;
      try {
        project = await getProject(projectId);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      // Check storage is configured
      const config = await loadConfig();
      if (!config.storage) {
        return reply.status(400).send({
          ok: false,
          error: 'Storage not configured',
        });
      }

      // Reject if sync already in progress
      const active = getActiveOperation(projectId);
      if (active) {
        return reply.status(409).send({
          ok: false,
          error: `Sync already in progress for project "${projectId}"`,
          operationId: active.operationId,
        });
      }

      // Create operation
      const operationId = crypto.randomUUID();
      const now = new Date().toISOString();

      const activeOp: ActiveOperation = {
        operationId,
        projectId,
        type: 'sync',
        startedAt: now,
        transferred: 0,
        totalSize: 0,
        speed: 0,
        eta: 0,
        filesTransferred: 0,
        filesTotal: 0,
      };
      setActiveOperation(activeOp);

      // Record in history as pending
      const historyEntry: SyncOperation = {
        id: operationId,
        projectId,
        type: 'sync',
        direction: project.direction,
        trigger: 'manual',
        status: 'running',
        startedAt: now,
        completedAt: null,
        duration: null,
        bytesTransferred: null,
        filesTransferred: null,
        errors: 0,
        errorMessage: null,
      };
      await addHistoryEntry(historyEntry);

      // Update project status to syncing
      await updateProjectStatus(projectId, 'syncing').catch(() => {
        // best-effort status update
      });

      request.log.info({ operationId, projectId, direction: project.direction }, 'Sync triggered');

      return reply.send({
        ok: true,
        operationId,
        status: 'started',
      });
    },
  );
}
