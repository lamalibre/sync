/**
 * Agent path approval routes.
 *
 * These routes manage the approved-paths.json file that controls which
 * local directories are mapped to which projects. In standalone mode,
 * the agent's data directory defaults to ~/.sync-agent/. The server
 * reads the SYNC_AGENT_DIR environment variable or falls back to
 * ~/.sync-agent/ for the agent directory path.
 *
 * This provides the desktop UI with a way to manage path approvals
 * without requiring direct filesystem access.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectIdSchema } from '../lib/schemas.js';
import {
  readApprovedPaths,
  writeApprovedPaths,
  addApproval,
  removeApproval,
  validateLocalPath,
  type ApprovedPathEntry,
} from '@lamalibre/sync-shared';
import { ACCESS_MODES, CONFIRM_MODES, DEFAULT_DELETE_THRESHOLD } from '@lamalibre/sync-shared';

function getAgentDir(): string {
  return process.env['SYNC_AGENT_DIR'] ?? join(homedir(), '.sync-agent');
}

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/sync/approvals — list all approved path entries
  server.get('/api/sync/approvals', async (_request, reply) => {
    const agentDir = getAgentDir();
    const approved = await readApprovedPaths(agentDir, (err) => {
      _request.log.warn({ err: err.message }, 'Error reading approved paths');
    });

    // Strip localPath from response — local paths never cross the network
    const sanitized = {
      ...approved,
      entries: approved.entries.map(({ localPath: _, ...rest }) => rest),
    };

    return reply.send(sanitized);
  });

  // POST /api/sync/approvals — add or update a path approval
  server.post(
    '/api/sync/approvals',
    {
      schema: {
        body: z.object({
          projectId: projectIdSchema,
          localPath: z
            .string()
            .min(1)
            .max(4096)
            .refine((v) => !v.includes('\0'), 'Path must not contain null bytes')
            .refine((v) => !v.split('/').includes('..'), 'Path must not contain ..'),
          projectName: z.string().min(1).max(100),
          accessMode: z.enum(ACCESS_MODES).optional().default('full'),
          confirmMode: z.enum(CONFIRM_MODES).optional().default('auto'),
          deleteThreshold: z.number().int().min(1).optional().default(DEFAULT_DELETE_THRESHOLD),
        }),
      },
    },
    async (request, reply) => {
      const { projectId, localPath, projectName, accessMode, confirmMode, deleteThreshold } =
        request.body;

      // Validate local path
      const pathError = validateLocalPath(localPath);
      if (pathError) {
        return reply.status(400).send({ ok: false, error: pathError });
      }

      const agentDir = getAgentDir();
      const approved = await readApprovedPaths(agentDir, (err) => {
        request.log.warn({ err: err.message }, 'Error reading approved paths');
      });

      const entry: ApprovedPathEntry = {
        projectId,
        localPath,
        approvedAt: new Date().toISOString(),
        projectName,
        accessMode,
        confirmMode,
        deleteThreshold,
      };

      const updated = addApproval(approved, entry);
      await writeApprovedPaths(agentDir, updated);

      request.log.info({ projectId }, 'Path approval added');

      return reply.status(201).send({ ok: true, projectId });
    },
  );

  // DELETE /api/sync/approvals/:projectId — revoke a path approval
  server.delete(
    '/api/sync/approvals/:projectId',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;

      const agentDir = getAgentDir();
      const approved = await readApprovedPaths(agentDir, (err) => {
        request.log.warn({ err: err.message }, 'Error reading approved paths');
      });

      const existing = approved.entries.find((e) => e.projectId === projectId);
      if (!existing) {
        return reply.status(404).send({
          ok: false,
          error: `No approval found for project "${projectId}"`,
        });
      }

      const updated = removeApproval(approved, projectId);
      await writeApprovedPaths(agentDir, updated);

      request.log.info({ projectId }, 'Path approval revoked');

      return reply.send({ ok: true });
    },
  );
}
