import { join } from 'node:path';
import { homedir } from 'node:os';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';
import { readApprovedPaths, getLocalPath } from '@lamalibre/sync-shared';

interface RestoreOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export async function restoreCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: RestoreOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection
  if (!projectId) {
    const agentDir = join(homedir(), '.sync-agent');
    const [projectsRes, approvedPaths] = await Promise.all([
      client.get<{ projects: Project[] }>('/api/sync/projects'),
      readApprovedPaths(agentDir),
    ]);

    const restorable = projectsRes.projects.filter((proj) => proj.status === 'archived');

    if (restorable.length === 0) {
      process.stderr.write(pc.yellow('No archived projects available for restore.\n'));
      process.exit(0);
    }

    const selected = await p.select({
      message: 'Select an archived project to restore',
      options: restorable.map((proj) => ({
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

  // Confirm
  if (!opts.yes && !opts.json) {
    const confirmed = await p.confirm({
      message: `Restore "${projectId}"? Files will be downloaded from cloud storage.`,
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
  }>(`/api/sync/projects/${encodeURIComponent(projectId)}/restore`);

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Restore triggered for "${projectId}" (operation: ${pc.dim(result.operationId)})`);
}
