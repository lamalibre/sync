import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectIdSchema, purgeTrashSchema } from '../lib/schemas.js';
import type { ActiveOperation, SyncOperation } from '../lib/schemas.js';
import {
  getProject,
  getActiveOperation,
  setActiveOperation,
  addHistoryEntry,
  updateProjectStatus,
  loadConfig,
  NotFoundError,
} from '../lib/state.js';

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/sync/projects/:projectId/purge-trash — request trash cleanup
  server.post(
    '/api/sync/projects/:projectId/purge-trash',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
        body: purgeTrashSchema.optional().default({}),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists (include soft-deleted — trash may exist for deleted projects)
      try {
        await getProject(projectId, true);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      const olderThanDays = request.body?.olderThanDays;
      const operationId = crypto.randomUUID();

      request.log.info(
        { operationId, projectId, olderThanDays },
        'Trash purge requested',
      );

      return reply.send({ ok: true, operationId, olderThanDays });
    },
  );

  // GET /api/sync/projects/:projectId/trash — get trash metadata
  server.get(
    '/api/sync/projects/:projectId/trash',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists (include soft-deleted)
      try {
        await getProject(projectId, true);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      // Trash metadata would be reported by the agent.
      // For now, return an empty structure; the agent will populate
      // this as part of cleanup reporting.
      return reply.send({
        projectId,
        entries: [],
      });
    },
  );

  // POST /api/sync/projects/:projectId/restore-trash — restore files from trash
  server.post(
    '/api/sync/projects/:projectId/restore-trash',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
        body: z
          .object({
            timestamp: z
              .string()
              .regex(
                /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
                'Timestamp must match trash directory format (e.g., 2026-03-25T14-30-00-000Z)',
              )
              .optional(),
          })
          .optional(),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists (include soft-deleted — trash may exist for deleted projects)
      let project;
      try {
        project = await getProject(projectId, true);
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

      // Reject if another operation is already in progress for this project
      const active = getActiveOperation(projectId);
      if (active) {
        return reply.status(409).send({
          ok: false,
          error: `Operation already in progress for project "${projectId}"`,
          operationId: active.operationId,
        });
      }

      const operationId = crypto.randomUUID();
      const now = new Date().toISOString();
      const timestamp = request.body?.timestamp;

      const activeOp: ActiveOperation = {
        operationId,
        projectId,
        type: 'restore',
        startedAt: now,
        transferred: 0,
        totalSize: 0,
        speed: 0,
        eta: 0,
        filesTransferred: 0,
        filesTotal: 0,
      };
      setActiveOperation(activeOp);

      const historyEntry: SyncOperation = {
        id: operationId,
        projectId,
        type: 'restore',
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

      await updateProjectStatus(projectId, 'syncing').catch(() => {
        // best-effort status update
      });

      request.log.info(
        { operationId, projectId, timestamp },
        'Trash restore requested',
      );

      return reply.send({
        ok: true,
        operationId,
        timestamp: timestamp ?? null,
      });
    },
  );
}
