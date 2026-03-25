import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface ProjectRestoreOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export async function projectRestoreCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: ProjectRestoreOptions,
): Promise<void> {
  let projectId = projectArg ?? opts.project;

  // Interactive: show only soft-deleted projects
  if (!projectId) {
    const projectsRes = await client.get<{ projects: Project[] }>('/api/sync/projects?includeDeleted=true');

    const deleted = projectsRes.projects.filter((proj) => proj.deletedAt !== null);

    if (deleted.length === 0) {
      process.stderr.write(pc.yellow('No deleted projects to restore.\n'));
      process.exit(0);
    }

    const selected = await p.select({
      message: 'Select a project to restore',
      options: deleted.map((proj) => ({
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
      message: `Restore deleted project "${projectId}"?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.post<{ ok: boolean; project: Project }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/undelete`,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Project "${projectId}" restored (status: ${result.project.status}).`);
}
