import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { projectIdSchema, projectCreateSchema, projectUpdateSchema, type Project } from '../lib/schemas.js';
import {
  loadProjects,
  loadActiveProjects,
  loadConfig,
  createProject,
  getProject,
  updateProject,
  softDeleteProject,
  hardDeleteProject,
  restoreProject,
  getActiveOperation,
  clearActiveOperation,
  NotFoundError,
  ConflictError,
} from '../lib/state.js';

/** Strip encryptionPasswordEncrypted from project objects before returning in API responses. */
function redactProject(project: Project): Omit<Project, 'encryptionPasswordEncrypted'> {
  const { encryptionPasswordEncrypted, ...safe } = project;
  return safe;
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/sync/projects — create project
  server.post(
    '/api/sync/projects',
    {
      schema: {
        body: projectCreateSchema,
      },
    },
    async (request, reply) => {
      try {
        const body = request.body;

        // Validate encryption password availability when encryption is enabled
        if (body.encrypted) {
          if (!body.encryptionPassword) {
            // Check if global storage encryption password is available as fallback
            const config = await loadConfig();
            if (!config.storage?.encryptionPasswordEncrypted) {
              return reply.status(400).send({
                ok: false,
                error:
                  'Encryption password is required when encryption is enabled. ' +
                  'Provide encryptionPassword in the request or configure a global ' +
                  'encryption password in storage settings. ' +
                  'WARNING: Password loss = data loss. There is no key recovery mechanism.',
              });
            }
          }
        }

        const project = await createProject(body);

        // Include encryption warning in the response when encryption is enabled
        const warnings: string[] = [];
        if (project.encrypted) {
          warnings.push(
            'Encryption is enabled for this project. ' +
              'WARNING: Password loss = data loss. There is no key recovery mechanism. ' +
              'Store your encryption password securely.',
          );
        }

        return reply.status(201).send({
          ok: true,
          project: redactProject(project),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          return reply.status(409).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // GET /api/sync/projects — list projects (active by default)
  server.get(
    '/api/sync/projects',
    {
      schema: {
        querystring: z.object({
          includeDeleted: z.enum(['true', 'false']).optional().default('false'),
        }),
      },
    },
    async (request, reply) => {
      const includeDeleted = request.query.includeDeleted === 'true';
      const projects = includeDeleted ? await loadProjects() : await loadActiveProjects();
      return reply.send({ projects: projects.map(redactProject) });
    },
  );

  // GET /api/sync/projects/:projectId — get project details
  server.get(
    '/api/sync/projects/:projectId',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      try {
        const project = await getProject(request.params.projectId);
        return reply.send({ project: redactProject(project) });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // PATCH /api/sync/projects/:projectId — update project
  server.patch(
    '/api/sync/projects/:projectId',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
        body: projectUpdateSchema,
      },
    },
    async (request, reply) => {
      try {
        const project = await updateProject(request.params.projectId, request.body);
        return reply.send({ ok: true, project: redactProject(project) });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // DELETE /api/sync/projects/:projectId — soft delete (default) or hard delete (?permanent=true)
  server.delete(
    '/api/sync/projects/:projectId',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
        querystring: z.object({
          permanent: z.enum(['true', 'false']).optional().default('false'),
        }),
      },
    },
    async (request, reply) => {
      try {
        const permanent = request.query.permanent === 'true';
        const active = getActiveOperation(request.params.projectId);
        if (active) {
          return reply.status(409).send({
            ok: false,
            error: `Operation already in progress for project "${request.params.projectId}"`,
            operationId: active.operationId,
          });
        }
        clearActiveOperation(request.params.projectId);
        if (permanent) {
          await hardDeleteProject(request.params.projectId);
        } else {
          await softDeleteProject(request.params.projectId);
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // POST /api/sync/projects/:projectId/undelete — restore a soft-deleted project
  server.post(
    '/api/sync/projects/:projectId/undelete',
    {
      schema: {
        params: z.object({
          projectId: projectIdSchema,
        }),
      },
    },
    async (request, reply) => {
      try {
        const project = await restoreProject(request.params.projectId);
        return reply.send({ ok: true, project: redactProject(project) });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        if (err instanceof ConflictError) {
          return reply.status(409).send({ ok: false, error: err.message });
        }
        throw err;
      }
    },
  );
}
