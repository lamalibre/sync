import { join } from 'node:path';
import { homedir } from 'node:os';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';
import { readApprovedPaths, getLocalPath } from '@lamalibre/sync-shared';

interface ProjectDeleteOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
  permanent?: boolean;
}

export async function projectDeleteCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: ProjectDeleteOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection
  if (!projectId) {
    const agentDir = join(homedir(), '.sync-agent');
    const includeDeleted = opts.permanent ? '?includeDeleted=true' : '';
    const [projectsRes, approvedPaths] = await Promise.all([
      client.get<{ projects: Project[] }>(`/api/sync/projects${includeDeleted}`),
      readApprovedPaths(agentDir),
    ]);

    const candidates = opts.permanent
      ? projectsRes.projects
      : projectsRes.projects.filter((proj) => !proj.deletedAt);

    if (candidates.length === 0) {
      process.stderr.write(pc.yellow('No projects available for deletion.\n'));
      process.exit(0);
    }

    const selected = await p.select({
      message: opts.permanent
        ? 'Select a project to permanently delete'
        : 'Select a project to delete',
      options: candidates.map((proj) => ({
        value: proj.id,
        label: proj.name,
        hint: proj.deletedAt ? pc.dim('(deleted)') : (getLocalPath(approvedPaths, proj.id) ?? proj.name),
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    projectId = selected as string;
  }

  // Confirm
  if (!opts.yes && !opts.json) {
    const msg = opts.permanent
      ? `Permanently delete "${projectId}"? This cannot be undone.`
      : `Delete "${projectId}"? It can be restored later.`;
    const confirmed = await p.confirm({ message: msg });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const query = opts.permanent ? '?permanent=true' : '';
  const result = await client.delete<{ ok: boolean }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}${query}`,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  if (opts.permanent) {
    p.log.success(`Permanently deleted "${projectId}".`);
  } else {
    p.log.success(`Deleted "${projectId}". Use "project-restore" to undelete it.`);
  }
}
