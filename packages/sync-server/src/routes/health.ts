import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sync/health', async (_request, reply) => {
    return reply.send({
      ok: true,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });
}
