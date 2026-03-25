import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface TrashRestoreOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export async function trashRestoreCommand(
  client: ApiClient,
  projectArg: string | undefined,
  timestampArg: string | undefined,
  opts: TrashRestoreOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive project selection
  if (!projectId) {
    const projectsRes = await client.get<{ projects: Project[] }>('/api/sync/projects?includeDeleted=true');

    if (projectsRes.projects.length === 0) {
      process.stderr.write(pc.yellow('No projects found.\n'));
      process.exit(0);
    }

    const selected = await p.select({
      message: 'Select a project to restore trash from',
      options: projectsRes.projects.map((proj) => ({
        value: proj.id,
        label: proj.name,
        hint: proj.localPath,
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
      message: `Restore trash files for "${projectId}"?${timestampArg ? ` (timestamp: ${timestampArg})` : ''}`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const body: Record<string, string> = {};
  if (timestampArg) {
    body['timestamp'] = timestampArg;
  }

  const result = await client.post<{ ok: boolean }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/restore-trash`,
    body,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Trash restore requested for "${projectId}".`);
}
