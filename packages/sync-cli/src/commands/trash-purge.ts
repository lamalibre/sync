import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface TrashPurgeOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
  olderThan?: string;
}

/**
 * Parse a duration string like "7d", "30d", "1d" into days.
 */
function parseDays(value: string): number | null {
  const match = /^(\d+)d$/.exec(value);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

export async function trashPurgeCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: TrashPurgeOptions,
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
      message: 'Select a project to purge trash for',
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

  const body: Record<string, number> = {};
  if (opts.olderThan) {
    const days = parseDays(opts.olderThan);
    if (days === null) {
      process.stderr.write(pc.red(`Invalid --older-than value: "${opts.olderThan}". Use format like "7d".\n`));
      process.exit(1);
    }
    body['olderThanDays'] = days;
  }

  // Confirm
  if (!opts.yes && !opts.json) {
    const msg = opts.olderThan
      ? `Purge trash older than ${opts.olderThan} for "${projectId}"?`
      : `Purge all trash for "${projectId}"?`;
    const confirmed = await p.confirm({ message: msg });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  const result = await client.post<{ ok: boolean; operationId: string }>(
    `/api/sync/projects/${encodeURIComponent(projectId)}/purge-trash`,
    body,
  );

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  p.log.success(`Trash purge requested for "${projectId}" (operation: ${pc.dim(result.operationId)})`);
}
