import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface TriggerOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export async function triggerCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: TriggerOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection
  if (!projectId) {
    const projectsRes = await client.get<{ projects: Project[] }>('/api/sync/projects');
    if (projectsRes.projects.length === 0) {
      process.stderr.write(pc.red('No projects configured.\n'));
      process.exit(1);
    }

    const selected = await p.select({
      message: 'Select a project to sync',
      options: projectsRes.projects.map((proj) => ({
        value: proj.id,
        label: `${proj.name} (${proj.direction})`,
        hint: proj.status,
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
      message: `Trigger sync for project "${projectId}"?`,
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
  }>(`/api/sync/projects/${encodeURIComponent(projectId)}/sync`);

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Sync triggered for "${projectId}" (operation: ${pc.dim(result.operationId)})`);
}
