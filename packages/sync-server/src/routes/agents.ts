/**
 * Multi-agent management routes.
 *
 * Supports agent registration, heartbeat monitoring, listing, and removal.
 * Agents are identified by a UUID assigned on first registration.
 * An agent is considered "online" if its last heartbeat was within the
 * configured timeout (default 30 seconds).
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentRegisterSchema, agentHeartbeatSchema } from '../lib/schemas.js';
import {
  loadAgents,
  registerAgent,
  getAgent,
  updateAgentHeartbeat,
  removeAgent,
  updateAgentProjects,
  getAgentStatus,
  verifyAgentToken,
  NotFoundError,
} from '../lib/state.js';

export async function agentRegistryRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/sync/agents — register a new agent
  server.post(
    '/api/sync/agents',
    {
      schema: {
        body: agentRegisterSchema,
      },
    },
    async (request, reply) => {
      const { agent, agentToken } = await registerAgent(request.body);

      request.log.info(
        { agentId: agent.id, name: agent.name, hostname: agent.hostname },
        'Agent registered',
      );

      // Return the token only on registration — agent must save it.
      // The agentTokenHash is stripped from the response (never expose hashes).
      const { agentTokenHash: _hash, ...agentWithoutHash } = agent;
      return reply.status(201).send({
        ok: true,
        agent: {
          ...agentWithoutHash,
          status: getAgentStatus(agent),
        },
        agentToken,
      });
    },
  );

  // GET /api/sync/agents — list all registered agents
  server.get('/api/sync/agents', async (_request, reply) => {
    const agents = await loadAgents();

    return reply.send({
      agents: agents.map((agent) => ({
        ...agent,
        status: getAgentStatus(agent),
      })),
    });
  });

  // GET /api/sync/agents/:agentId — get a specific agent
  server.get(
    '/api/sync/agents/:agentId',
    {
      schema: {
        params: z.object({
          agentId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      try {
        const agent = await getAgent(request.params.agentId);
        return reply.send({
          agent: {
            ...agent,
            status: getAgentStatus(agent),
          },
        });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // POST /api/sync/agents/:agentId/heartbeat — agent sends periodic heartbeat
  server.post(
    '/api/sync/agents/:agentId/heartbeat',
    {
      schema: {
        params: z.object({
          agentId: z.string().uuid(),
        }),
        body: agentHeartbeatSchema,
      },
    },
    async (request, reply) => {
      // Verify the agent token if present in the X-Agent-Token header.
      // If the agent has a stored token hash but the request lacks a valid
      // token, reject the heartbeat.
      const agentTokenHeader = request.headers['x-agent-token'] as string | undefined;
      if (agentTokenHeader) {
        const valid = await verifyAgentToken(request.params.agentId, agentTokenHeader);
        if (!valid) {
          return reply.status(403).send({
            ok: false,
            error: 'Invalid agent token.',
          });
        }
      } else {
        // If no token header but agent has a stored hash, reject
        try {
          const existingAgent = await getAgent(request.params.agentId);
          if (existingAgent.agentTokenHash) {
            return reply.status(403).send({
              ok: false,
              error: 'Agent token required. Send X-Agent-Token header.',
            });
          }
        } catch (err: unknown) {
          if (err instanceof NotFoundError) {
            return reply.status(404).send({ ok: false, error: err.message });
          }
          throw err;
        }
      }

      try {
        const agent = await updateAgentHeartbeat(request.params.agentId, request.body);

        return reply.send({
          ok: true,
          agent: {
            ...agent,
            status: getAgentStatus(agent),
          },
        });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // PATCH /api/sync/agents/:agentId/projects — update project assignments
  server.patch(
    '/api/sync/agents/:agentId/projects',
    {
      schema: {
        params: z.object({
          agentId: z.string().uuid(),
        }),
        body: z.object({
          projectIds: z.array(z.string()),
        }),
      },
    },
    async (request, reply) => {
      try {
        const agent = await updateAgentProjects(request.params.agentId, request.body.projectIds);

        return reply.send({
          ok: true,
          agent: {
            ...agent,
            status: getAgentStatus(agent),
          },
        });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // DELETE /api/sync/agents/:agentId — remove a registered agent
  server.delete(
    '/api/sync/agents/:agentId',
    {
      schema: {
        params: z.object({
          agentId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      try {
        await removeAgent(request.params.agentId);
        request.log.info({ agentId: request.params.agentId }, 'Agent removed');
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );
}
