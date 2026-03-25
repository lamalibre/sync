import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectIdSchema } from '../lib/schemas.js';
import type { SyncOperation, ActiveOperation } from '../lib/schemas.js';
import {
  getProject,
  getActiveOperation,
  setActiveOperation,
  loadConfig,
  addHistoryEntry,
  updateProjectStatus,
  getProjectSavings,
  getAggregateSavings,
  loadSavings,
  NotFoundError,
} from '../lib/state.js';

export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // POST /api/sync/projects/:projectId/archive — trigger archive
  // -------------------------------------------------------------------------
  server.post(
    '/api/sync/projects/:projectId/archive',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists (include soft-deleted for informative error)
      let project;
      try {
        project = await getProject(projectId, true);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      // Reject if project is soft-deleted
      if (project.deletedAt) {
        return reply.status(400).send({
          ok: false,
          error: `Project "${projectId}" is deleted. Restore it before archiving.`,
        });
      }

      // Reject if already archived
      if (project.status === 'archived') {
        return reply.status(400).send({
          ok: false,
          error: `Project "${projectId}" is already archived`,
        });
      }

      // Check storage is configured
      const config = await loadConfig();
      if (!config.storage) {
        return reply.status(400).send({
          ok: false,
          error: 'Storage not configured',
        });
      }

      // Reject if operation already in progress
      const active = getActiveOperation(projectId);
      if (active) {
        return reply.status(409).send({
          ok: false,
          error: `Operation already in progress for project "${projectId}"`,
          operationId: active.operationId,
        });
      }

      // Create operation
      const operationId = crypto.randomUUID();
      const now = new Date().toISOString();

      const activeOp: ActiveOperation = {
        operationId,
        projectId,
        type: 'archive',
        startedAt: now,
        transferred: 0,
        totalSize: 0,
        speed: 0,
        eta: 0,
        filesTransferred: 0,
        filesTotal: 0,
      };
      setActiveOperation(activeOp);

      // Record in history
      const historyEntry: SyncOperation = {
        id: operationId,
        projectId,
        type: 'archive',
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

      // Update project status so the agent detects the pending operation
      await updateProjectStatus(projectId, 'syncing').catch(() => {});

      request.log.info({ operationId, projectId }, 'Archive triggered');

      return reply.send({
        ok: true,
        operationId,
        status: 'archiving',
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/sync/projects/:projectId/restore — trigger restore
  // -------------------------------------------------------------------------
  server.post(
    '/api/sync/projects/:projectId/restore',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
        body: z
          .object({
            /** Restore a single file by relative path instead of the whole project. */
            filePath: z
              .string()
              .min(1)
              .refine((p) => !p.includes('\0') && !p.split('/').includes('..'), {
                message: 'Invalid file path',
              })
              .refine((p) => !/[*?[{\]\\}]/.test(p), {
                message: 'File path must not contain glob metacharacters (*, ?, [, ], {, }, \\)',
              })
              .optional(),
          })
          .optional(),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const filePath = request.body?.filePath;

      // Verify project exists (include soft-deleted for informative error)
      let project;
      try {
        project = await getProject(projectId, true);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      // Reject if project is soft-deleted
      if (project.deletedAt) {
        return reply.status(400).send({
          ok: false,
          error: `Project "${projectId}" is deleted. Restore it before recovering files.`,
        });
      }

      // Full restore requires archived status; single-file doesn't necessarily
      if (!filePath && project.status !== 'archived') {
        return reply.status(400).send({
          ok: false,
          error: `Project "${projectId}" is not archived`,
        });
      }

      // Check storage is configured
      const config = await loadConfig();
      if (!config.storage) {
        return reply.status(400).send({
          ok: false,
          error: 'Storage not configured',
        });
      }

      // Reject if operation already in progress
      const active = getActiveOperation(projectId);
      if (active) {
        return reply.status(409).send({
          ok: false,
          error: `Operation already in progress for project "${projectId}"`,
          operationId: active.operationId,
        });
      }

      // Create operation
      const operationId = crypto.randomUUID();
      const now = new Date().toISOString();

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

      // Update project status so the agent detects the pending operation
      await updateProjectStatus(projectId, 'syncing').catch(() => {});

      request.log.info(
        { operationId, projectId, filePath: filePath ?? 'all' },
        'Restore triggered',
      );

      return reply.send({
        ok: true,
        operationId,
        status: 'restoring',
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/sync/projects/:projectId/stubs — list stub info
  // -------------------------------------------------------------------------
  server.get(
    '/api/sync/projects/:projectId/stubs',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists
      try {
        await getProject(projectId);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      // We track stub info via savings — return what we know from server state.
      // The actual stub file lives on the agent machine.
      const savings = await getProjectSavings(projectId);
      if (!savings) {
        return reply.send({ stubs: [] });
      }

      return reply.send({
        stubs: [
          {
            projectId: savings.projectId,
            archivedAt: savings.lastArchivedAt,
            archivedFileCount: savings.archivedFileCount,
            archivedTotalBytes: savings.archivedTotalBytes,
            stubSizeBytes: savings.stubSizeBytes,
            bytesSaved: savings.bytesSaved,
          },
        ],
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/sync/projects/:projectId/savings — disk savings report
  // -------------------------------------------------------------------------
  server.get(
    '/api/sync/projects/:projectId/savings',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      // Verify project exists
      try {
        await getProject(projectId);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      const savings = await getProjectSavings(projectId);
      if (!savings) {
        return reply.send({
          projectId,
          archived: false,
          archivedFileCount: 0,
          archivedTotalBytes: 0,
          stubSizeBytes: 0,
          bytesSaved: 0,
          lastArchivedAt: null,
        });
      }

      return reply.send({
        projectId,
        archived: true,
        archivedFileCount: savings.archivedFileCount,
        archivedTotalBytes: savings.archivedTotalBytes,
        stubSizeBytes: savings.stubSizeBytes,
        bytesSaved: savings.bytesSaved,
        lastArchivedAt: savings.lastArchivedAt,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/sync/savings — aggregate savings across all projects
  // -------------------------------------------------------------------------
  server.get('/api/sync/savings', async (_request, reply) => {
    const aggregate = await getAggregateSavings();
    const all = await loadSavings();

    return reply.send({
      ...aggregate,
      perProject: all.map((s) => ({
        projectId: s.projectId,
        archivedFileCount: s.archivedFileCount,
        archivedTotalBytes: s.archivedTotalBytes,
        bytesSaved: s.bytesSaved,
        lastArchivedAt: s.lastArchivedAt,
      })),
    });
  });
}
