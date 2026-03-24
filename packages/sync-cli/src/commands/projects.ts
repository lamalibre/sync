import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { ApiClient } from '../lib/api-client.js';
import {
  renderTable,
  colorStatus,
  formatRelativeTime,
  formatBytes,
  jsonOutput,
} from '../lib/format.js';
import type { Project } from '../lib/types.js';

interface ProjectStatus {
  projectId: string;
  status: string;
  lastSync: string | null;
  activeOperation: {
    operationId: string;
    type: string;
    transferred: number;
    totalSize: number;
    speed: number;
    eta: number;
    filesTransferred: number;
    filesTotal: number;
  } | null;
}

interface ProjectsOptions {
  json?: boolean;
  detail?: string;
}

export async function projectsCommand(client: ApiClient, opts: ProjectsOptions): Promise<void> {
  const { projects } = await client.get<{ projects: Project[] }>('/api/sync/projects');

  if (projects.length === 0) {
    if (opts.json) {
      process.stdout.write(jsonOutput({ projects: [] }) + '\n');
    } else {
      process.stdout.write(pc.dim('\n  No projects configured.\n\n'));
    }
    return;
  }

  // If --detail flag provided, show details for that project
  let detailId = opts.detail;

  // If no --detail and not --json, offer interactive selection
  if (!detailId && !opts.json) {
    const selected = await p.select({
      message: 'Select a project for details (or Ctrl+C for table view)',
      options: [
        { value: '__table__', label: 'Show all projects (table)' },
        ...projects.map((proj) => ({
          value: proj.id,
          label: `${proj.name} (${proj.direction})`,
          hint: colorStatus(proj.status),
        })),
      ],
    });

    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    if (selected !== '__table__') {
      detailId = selected as string;
    }
  }

  // Detail view
  if (detailId) {
    const project = projects.find((proj) => proj.id === detailId);
    if (!project) {
      process.stderr.write(pc.red(`Project "${detailId}" not found.\n`));
      process.exit(1);
    }

    const status = await client.get<ProjectStatus>(
      `/api/sync/projects/${encodeURIComponent(detailId)}/status`,
    );

    if (opts.json) {
      process.stdout.write(jsonOutput({ project, status }) + '\n');
      return;
    }

    process.stdout.write(pc.bold(`\n  ${project.name}\n\n`));
    process.stdout.write(
      `  ID:              ${project.id}\n` +
        `  Local path:      ${project.localPath}\n` +
        `  Remote path:     ${project.remotePath}\n` +
        `  Direction:       ${project.direction}\n` +
        `  Status:          ${colorStatus(status.status)}\n` +
        `  Last sync:       ${project.lastSync ? formatRelativeTime(project.lastSync) : pc.dim('never')}\n` +
        `  Trigger:         ${project.trigger}\n` +
        `  Watch:           ${project.watch ? pc.green('enabled') : pc.dim('disabled')}\n` +
        `  Schedule:        ${project.schedule ?? pc.dim('none')}\n` +
        `  Encrypted:       ${project.encrypted ? pc.green('yes') : pc.dim('no')}\n` +
        `  Conflicts:       ${project.conflictStrategy}\n` +
        `  Excludes:        ${project.excludes.length > 0 ? project.excludes.join(', ') : pc.dim('none')}\n`,
    );

    if (status.activeOperation) {
      const op = status.activeOperation;
      process.stdout.write(
        `\n  ${pc.bold('Active Operation')}\n` +
          `  Type:            ${op.type}\n` +
          `  Transferred:     ${formatBytes(op.transferred)} / ${formatBytes(op.totalSize)}\n` +
          `  Files:           ${op.filesTransferred} / ${op.filesTotal}\n` +
          `  Speed:           ${formatBytes(op.speed)}/s\n` +
          `  ETA:             ${op.eta}s\n`,
      );
    }

    process.stdout.write('\n');
    return;
  }

  // Table view
  if (opts.json) {
    process.stdout.write(jsonOutput({ projects }) + '\n');
    return;
  }

  process.stdout.write(pc.bold('\nProjects\n\n'));

  const rows = projects.map((proj) => ({
    id: proj.id,
    name: proj.name,
    direction: proj.direction,
    status: colorStatus(proj.status),
    trigger: proj.trigger,
    lastSync: proj.lastSync ? formatRelativeTime(proj.lastSync) : pc.dim('never'),
  }));

  const table = renderTable(
    [
      { header: 'ID', key: 'id', width: 20 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Direction', key: 'direction', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Trigger', key: 'trigger', width: 16 },
      { header: 'Last Sync', key: 'lastSync', width: 12 },
    ],
    rows,
  );

  process.stdout.write(`${table}\n\n`);
}
