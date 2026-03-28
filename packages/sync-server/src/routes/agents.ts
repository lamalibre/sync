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
  ConflictError,
} from '../lib/state.js';

/**
 * Strip the agentTokenHash from an agent record before sending to clients.
 * The hash must never be exposed in API responses.
 */
function redactAgent(agent: Awaited<ReturnType<typeof loadAgents>>[number]) {
  const { agentTokenHash: _hash, ...safe } = agent;
  return safe;
}

/**
 * Verify the agent token from the X-Agent-Token header.
 * Returns null if verification passed, or a reply object if it failed.
 */
async function verifyAgentTokenFromRequest(
  agentId: string,
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
): Promise<unknown | null> {
  const agentTokenHeader = request.headers['x-agent-token'] as string | undefined;
  if (agentTokenHeader) {
    const valid = await verifyAgentToken(agentId, agentTokenHeader);
    if (!valid) {
      return reply.status(403).send({
        ok: false,
        error: 'Invalid agent token.',
      });
    }
  } else {
    // If no token header but agent has a stored hash, reject
    try {
      const existingAgent = await getAgent(agentId);
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
  return null;
}

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
      let registrationResult;
      try {
        registrationResult = await registerAgent(request.body);
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          return reply.status(409).send({ ok: false, error: err.message });
        }
        throw err;
      }
      const { agent, agentToken } = registrationResult;

      request.log.info(
        { agentId: agent.id, name: agent.name, hostname: agent.hostname },
        'Agent registered',
      );

      // In plugin mode, request a ticket for the newly registered agent
      // so it can establish a session. The ticket manager may not be ready
      // yet (startup race) — this is best-effort; the agent will get a
      // ticket on a subsequent heartbeat if this attempt fails.
      const ticketManager = app.ticketManager;
      if (ticketManager?.isReady()) {
        void ticketManager.requestTicketForAgent(agent.name, true).catch((err: unknown) => {
          request.log.warn(
            { err: err instanceof Error ? err.message : String(err), agentName: agent.name },
            'Failed to request ticket for newly registered agent',
          );
        });
      }

      // Return the token only on registration — agent must save it.
      // The agentTokenHash is stripped from the response (never expose hashes).
      return reply.status(201).send({
        ok: true,
        agent: {
          ...redactAgent(agent),
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
        ...redactAgent(agent),
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
            ...redactAgent(agent),
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
      // Verify the agent token
      const tokenError = await verifyAgentTokenFromRequest(request.params.agentId, request, reply);
      if (tokenError) return tokenError;

      try {
        const agent = await updateAgentHeartbeat(request.params.agentId, request.body);

        // In plugin mode, periodically re-issue tickets for agents that may
        // not yet have a valid session. This covers the case where the initial
        // ticket request on registration failed or expired before the agent
        // could validate it. Best-effort — failures are logged, not propagated.
        const ticketManager = app.ticketManager;
        if (ticketManager?.isReady()) {
          void ticketManager.requestTicketForAgent(agent.name).catch((err: unknown) => {
            request.log.debug(
              { err: err instanceof Error ? err.message : String(err), agentName: agent.name },
              'Failed to request ticket on heartbeat (may already have active session)',
            );
          });
        }

        return reply.send({
          ok: true,
          agent: {
            ...redactAgent(agent),
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
      // Verify the agent token
      const tokenError = await verifyAgentTokenFromRequest(request.params.agentId, request, reply);
      if (tokenError) return tokenError;

      try {
        const agent = await updateAgentProjects(request.params.agentId, request.body.projectIds);

        return reply.send({
          ok: true,
          agent: {
            ...redactAgent(agent),
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
      // Verify the agent token
      const tokenError = await verifyAgentTokenFromRequest(request.params.agentId, request, reply);
      if (tokenError) return tokenError;

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
