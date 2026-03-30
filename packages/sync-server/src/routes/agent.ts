import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { agentReportSchema } from '../lib/schemas.js';
import type { SyncOperation, StorageConfig } from '../lib/schemas.js';
import { decrypt } from '../lib/crypto.js';
import { DEFAULT_SOFT_DELETE_CONFIG } from '@lamalibre/sync-shared';
import type { SoftDeleteConfig } from '@lamalibre/sync-shared';
import {
  loadConfig,
  loadActiveProjects,
  loadAgents,
  decryptStorageConfig,
  prefixedRemotePath,
  addHistoryEntry,
  updateHistoryEntry,
  clearActiveOperation,
  updateProjectStatus,
  getProject,
  getActiveOperation,
  upsertSavings,
  clearSavings,
  verifyAgentToken,
  NotFoundError,
} from '../lib/state.js';

/**
 * Map the server's generic accessKey/secretKey credential model to
 * provider-specific field names expected by the agent's ProviderConfig type.
 * The agent uses these names to generate the correct rclone.conf.
 */
function mapStorageToProviderConfig(
  decrypted: StorageConfig,
  encryptionPassword?: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: decrypted.provider,
    bucket: decrypted.bucket,
    ...(decrypted.region ? { region: decrypted.region } : {}),
    ...(decrypted.endpoint ? { endpoint: decrypted.endpoint } : {}),
    ...(encryptionPassword ? { encryptionPassword } : {}),
  };

  switch (decrypted.provider) {
    case 'gcs':
      return { ...base, serviceAccountKey: decrypted.accessKey };
    case 'azure':
      return {
        ...base,
        storageAccountName: decrypted.accessKey,
        storageAccountKey: decrypted.secretKey,
      };
    case 'b2':
      return {
        ...base,
        applicationKeyId: decrypted.accessKey,
        applicationKey: decrypted.secretKey,
      };
    case 'local':
      return base;
    case 'spaces':
    case 's3':
    case 'custom':
    default:
      return {
        ...base,
        accessKeyId: decrypted.accessKey,
        secretAccessKey: decrypted.secretKey,
      };
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/sync/agent-config — full config including credentials (agents only)
  server.get('/api/sync/agent-config', async (_request, reply) => {
    const config = await loadConfig();

    if (!config.storage) {
      return reply.status(400).send({
        ok: false,
        error: 'Storage not configured',
      });
    }

    const decrypted = await decryptStorageConfig(config.storage);
    // Only serve active (non-deleted) projects to the agent
    const projects = await loadActiveProjects();

    // Include encryptionPassword only when at least one project uses encryption.
    // The password is needed by the agent to generate the rclone crypt remote.
    // It is NEVER logged or passed as a CLI argument — only written into rclone.conf (mode 0600).
    const hasEncryptedProjects = projects.some((p) => p.encrypted);
    const globalEncryptionPassword = hasEncryptedProjects
      ? decrypted.encryptionPassword
      : undefined;

    // Map projects with async decryption of per-project encryption passwords
    const mappedProjects = await Promise.all(
      projects.map(async (p) => {
        // Determine the effective encryption password for this project:
        // 1. Per-project password (stored encrypted at rest, decrypt it)
        // 2. Global storage encryption password as fallback
        let projectEncryptionPassword: string | undefined;
        if (p.encrypted) {
          if (p.encryptionPasswordEncrypted) {
            projectEncryptionPassword = await decrypt(p.encryptionPasswordEncrypted);
          } else {
            projectEncryptionPassword = decrypted.encryptionPassword;
          }
        }

        // Resolve effective soft delete config: project override ?? global ?? default
        const effectiveSoftDelete: SoftDeleteConfig =
          p.softDelete ?? config.softDelete ?? DEFAULT_SOFT_DELETE_CONFIG;

        // Include pendingOperationId when there's an active server-initiated operation
        // so the agent uses the same ID and the report updates the correct history entry.
        const activeOp = getActiveOperation(p.id);

        return {
          id: p.id,
          name: p.name,
          remotePath: prefixedRemotePath(p.remotePath, config),
          direction: p.direction,
          includes: p.includes,
          excludes: p.excludes,
          schedule: p.schedule,
          encrypted: p.encrypted,
          status: p.status,
          // Per-project encryption password sent to agent (only for encrypted projects)
          ...(projectEncryptionPassword ? { encryptionPassword: projectEncryptionPassword } : {}),
          conflictStrategy: p.conflictStrategy,
          watch: p.watch,
          trigger: p.trigger,
          watchDebounceMs: p.watchDebounceMs,
          ...(p.bandwidthLimit ? { bandwidthLimit: p.bandwidthLimit } : {}),
          softDelete: effectiveSoftDelete,
          ...(activeOp
            ? {
                pendingOperationId: activeOp.operationId,
                pendingType: activeOp.type,
                ...(activeOp.direction ? { pendingDirection: activeOp.direction } : {}),
              }
            : {}),
        };
      }),
    );

    // Map storage credentials to provider-specific field names expected by the agent
    const providerConfig = mapStorageToProviderConfig(decrypted, globalEncryptionPassword);

    return reply.send({
      provider: providerConfig,
      projects: mappedProjects,
      softDelete: config.softDelete ?? DEFAULT_SOFT_DELETE_CONFIG,
    });
  });

  // POST /api/sync/agent-report — agent reports sync completion/error
  server.post(
    '/api/sync/agent-report',
    {
      schema: {
        body: agentReportSchema,
      },
    },
    async (request, reply) => {
      const report = request.body;

      // Verify the reporting agent's token. The agent sends X-Agent-Token
      // on all requests; if any registered agent has a token hash, we require
      // a valid token from one of them.
      const agentTokenHeader = request.headers['x-agent-token'] as string | undefined;
      if (agentTokenHeader) {
        const agents = await loadAgents();
        let tokenValid = false;
        for (const agent of agents) {
          if (agent.agentTokenHash) {
            const valid = await verifyAgentToken(agent.id, agentTokenHeader);
            if (valid) {
              tokenValid = true;
              break;
            }
          }
        }
        if (!tokenValid) {
          return reply.status(403).send({
            ok: false,
            error: 'Invalid agent token.',
          });
        }
      } else {
        // If no token header but any agent has a stored hash, reject
        const agents = await loadAgents();
        const anyTokenRequired = agents.some((a) => Boolean(a.agentTokenHash));
        if (anyTokenRequired) {
          return reply.status(403).send({
            ok: false,
            error: 'Agent token required. Send X-Agent-Token header.',
          });
        }
      }

      // Verify project exists (include soft-deleted — an in-flight sync may complete after deletion)
      let project;
      try {
        project = await getProject(report.projectId, true);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ ok: false, error: err.message });
        }
        throw err;
      }

      const now = new Date().toISOString();

      // Update history entry
      const historyUpdate: Partial<SyncOperation> = {
        status: report.status === 'completed' ? 'completed' : 'error',
        completedAt: now,
        duration: report.duration,
        bytesTransferred: report.bytesTransferred,
        filesTransferred: report.filesTransferred,
        errors: report.errors,
        errorMessage: report.errorMessage ?? null,
        ...(report.trigger ? { trigger: report.trigger } : {}),
      };

      const updated = await updateHistoryEntry(report.operationId, historyUpdate);

      // If no matching history entry exists (agent-initiated sync via watch/schedule),
      // create a complete history entry so all syncs are recorded.
      if (!updated) {
        const newEntry: SyncOperation = {
          id: report.operationId,
          projectId: report.projectId,
          type: (report.type as SyncOperation['type']) ?? 'sync',
          direction: report.direction ?? project.direction,
          trigger: report.trigger ?? 'manual',
          status: report.status === 'completed' ? 'completed' : 'error',
          startedAt: report.duration
            ? new Date(Date.now() - report.duration).toISOString()
            : now,
          completedAt: now,
          duration: report.duration,
          bytesTransferred: report.bytesTransferred,
          filesTransferred: report.filesTransferred,
          errors: report.errors ?? 0,
          errorMessage: report.errorMessage ?? null,
        };
        await addHistoryEntry(newEntry);
      }

      // Clear active operation
      clearActiveOperation(report.projectId);

      // Determine project status based on report type
      let projectStatus: 'synced' | 'archived' | 'error';
      if (report.status !== 'completed') {
        projectStatus = 'error';
      } else if (report.type === 'archive') {
        projectStatus = 'archived';
      } else if (report.type === 'restore') {
        projectStatus = 'synced';
      } else {
        projectStatus = 'synced';
      }

      await updateProjectStatus(report.projectId, projectStatus, now);

      // Track savings for archive operations
      if (report.type === 'archive' && report.status === 'completed') {
        const spaceFreed = report.spaceFreed ?? 0;
        const totalSize = report.totalSize ?? report.bytesTransferred;
        const fileCount = report.fileCount ?? report.filesTransferred;

        await upsertSavings({
          projectId: report.projectId,
          archivedFileCount: fileCount,
          archivedTotalBytes: totalSize,
          stubSizeBytes: totalSize - spaceFreed,
          bytesSaved: spaceFreed,
          lastArchivedAt: now,
        });
      }

      // Clear savings when restore completes
      if (report.type === 'restore' && report.status === 'completed') {
        await clearSavings(report.projectId);
      }

      request.log.info(
        {
          operationId: report.operationId,
          projectId: report.projectId,
          status: report.status,
          type: report.type ?? 'sync',
        },
        'Agent report received',
      );

      return reply.send({ ok: true });
    },
  );
}
