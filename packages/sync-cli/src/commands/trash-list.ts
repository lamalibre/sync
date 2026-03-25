import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import { jsonOutput } from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface TrashListOptions {
  project?: string;
  json?: boolean;
}

export async function trashListCommand(
  client: ApiClient,
  projectArg: string | undefined,
  opts: TrashListOptions,
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
      message: 'Select a project to view trash',
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

  const result = await client.get<{
    projectId: string;
    entries: Array<{ timestamp: string; fileCount: number; totalSize: number }>;
  }>(`/api/sync/projects/${encodeURIComponent(projectId)}/trash`);

  if (opts.json) {
    process.stdout.write(jsonOutput(result) + '\n');
    return;
  }

  if (result.entries.length === 0) {
    p.log.info(`No trash entries for "${projectId}".`);
    return;
  }

  p.log.info(`Trash entries for "${projectId}":`);
  for (const entry of result.entries) {
    process.stdout.write(`  ${pc.dim(entry.timestamp)}  ${entry.fileCount} files\n`);
  }
}
