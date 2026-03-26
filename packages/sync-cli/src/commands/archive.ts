import { join } from 'node:path';
import { homedir } from 'node:os';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';
import { readApprovedPaths, getLocalPath } from '@lamalibre/sync-shared';

interface ArchiveOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export async function archiveCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: ArchiveOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection
  if (!projectId) {
    const agentDir = join(homedir(), '.sync-agent');
    const [projectsRes, approvedPaths] = await Promise.all([
      client.get<{ projects: Project[] }>('/api/sync/projects'),
      readApprovedPaths(agentDir),
    ]);

    const archivable = projectsRes.projects.filter((proj) => proj.status !== 'archived');

    if (archivable.length === 0) {
      process.stderr.write(pc.yellow('No projects available for archiving.\n'));
      process.exit(0);
    }

    const selected = await p.select({
      message: 'Select a project to archive',
      options: archivable.map((proj) => ({
        value: proj.id,
        label: proj.name,
        hint: getLocalPath(approvedPaths, proj.id) ?? proj.name,
      })),
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    projectId = selected as string;
  }

  // Confirm (archiving is destructive — moves local files to cloud)
  if (!opts.yes && !opts.json) {
    const confirmed = await p.confirm({
      message: `Archive "${projectId}"? Local files will be moved to cloud storage and replaced with stubs.`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.post<{
    ok: boolean;
    operationId: string;
    status: string;
  }>(`/api/sync/projects/${encodeURIComponent(projectId)}/archive`);

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Archive triggered for "${projectId}" (operation: ${pc.dim(result.operationId)})`);
}
