import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { historyQuerySchema } from '../lib/schemas.js';
import {
  loadConfig,
  loadProjects,
  loadHistory,
  getActiveOperation,
  getAllActiveOperations,
  getProject,
  getAggregateSavings,
  NotFoundError,
} from '../lib/state.js';

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/sync/status — global status
  server.get('/api/sync/status', async (_request, reply) => {
    const config = await loadConfig();
    const projects = await loadProjects();
    const activeOps = getAllActiveOperations();
    const savings = await getAggregateSavings();

    return reply.send({
      storageConfigured: config.storage !== null,
      provider: config.storage?.provider ?? null,
      projects: projects.length,
      activeOperations: activeOps.length,
      totalLocalSize: 0, // Populated by agent reports
      totalRemoteSize: 0,
      totalArchived: savings.totalArchivedBytes,
      savedLocally: savings.totalBytesSaved,
    });
  });

  // GET /api/sync/projects/:projectId/status — per-project status
  server.get(
    '/api/sync/projects/:projectId/status',
    {
      schema: {
        params: z.object({
          projectId: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      let project;
      try {
        project = await getProject(projectId);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      const activeOp = getActiveOperation(projectId);

      return reply.send({
        projectId: project.id,
        status: activeOp ? 'syncing' : project.status,
        lastSync: project.lastSync,
        activeOperation: activeOp
          ? {
              operationId: activeOp.operationId,
              type: activeOp.type,
              startedAt: activeOp.startedAt,
              transferred: activeOp.transferred,
              totalSize: activeOp.totalSize,
              speed: activeOp.speed,
              eta: activeOp.eta,
              filesTransferred: activeOp.filesTransferred,
              filesTotal: activeOp.filesTotal,
            }
          : null,
      });
    },
  );

  // GET /api/sync/history — sync history
  server.get(
    '/api/sync/history',
    {
      schema: {
        querystring: historyQuerySchema,
      },
    },
    async (request, reply) => {
      const { projectId, limit } = request.query;
      let operations = await loadHistory();

      if (projectId) {
        operations = operations.filter((op) => op.projectId === projectId);
      }

      operations = operations.slice(0, limit);

      return reply.send({ operations });
    },
  );
}
